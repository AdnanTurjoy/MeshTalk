import type Database from 'better-sqlite3';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  directConversationId,
  type ChatMessage,
  type ConversationSummary,
  type MessagePage,
  type MessageStatus,
  type ReactionSummary,
  type ReplyPreview,
  type SearchHit,
} from '../../shared/chat';
import type { AppEvent } from '../../shared/events';
import type { AppDatabase } from '../db/connection';
import { contacts, conversations, messages, outbox, reactions } from '../db/schema';
import { UserFacingError } from '../errors';
import type { IdentityService } from '../identity/identity-service';
import type { Logger } from '../logger';
import type { PeerConnection } from '../peer/peer-connection';
import type { PeerService } from '../peer/peer-service';
import type { WireMessage, WireMessageOf } from '../peer/wire';
import type { ContactsService } from '../services/contacts-service';
import type { SettingsService } from '../services/settings-service';
import type { ChatEvent } from './chat-wire';
import { HybridClock, uuidv7 } from './ids';

type MessageRow = typeof messages.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

/** How many outbox events may be unacknowledged per peer at once. */
const OUTBOX_WINDOW = 200;
/** sender_device_id of local timeline notes. */
const SYSTEM_SENDER = 'system';
const EXCERPT_CHARS = 120;
const TYPING_TTL_MS = 6000;

export class ChatError extends UserFacingError {
  override name = 'ChatError';
}

/** Anything that sends chat events to devices other than 1:1 contacts (groups, M6). */
export interface ConversationResolver {
  /** Device IDs that should receive events for this conversation, excluding us. */
  recipients(conversationId: string): string[] | null;
  /** Whether `deviceId` may post to `conversationId`. */
  canPost(conversationId: string, deviceId: string): boolean;
  title(conversationId: string): string | null;
  cannotSendReason(conversationId: string): string | null;
  /** Whether we share any active group with `deviceId`. */
  isMember(deviceId: string): boolean;
  /** Display name of a fellow group member who is not a contact (as listed by the group's admins). */
  memberName(deviceId: string): string | null;
}

export interface ChatServiceDeps {
  db: AppDatabase;
  sqlite: Database.Database;
  identity: IdentityService;
  contacts: ContactsService;
  peers: PeerService;
  settings: SettingsService;
  logger: Logger;
  emit(event: AppEvent): void;
  notify(title: string, body: string): void;
  isWindowFocused(): boolean;
  now?: () => number;
}

/**
 * One-to-one (and, through `groups`, group) messaging.
 *
 * Delivery model: every durable change is an event stored in the sender's
 * outbox per recipient and retried on every reconnect until the recipient
 * acks it. Recipients apply events idempotently. There is no relay: if the
 * recipient is offline, events wait on this device (see docs/architecture.md).
 */
export class ChatService {
  private readonly now: () => number;
  private readonly clock: HybridClock;
  private readonly inFlight = new Map<string, Set<string>>();
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();
  private activeConversation: string | null = null;
  groups: ConversationResolver | null = null;

  constructor(private readonly deps: ChatServiceDeps) {
    this.now = deps.now ?? Date.now;
    const last = deps.sqlite.prepare('SELECT max(sent_at) FROM messages').pluck().get() as
      number | null;
    this.clock = new HybridClock(last ?? 0, this.now);
    deps.peers.on('connected', (conn) => this.onConnected(conn));
    deps.peers.on('disconnected', (id) => this.inFlight.delete(id));
    deps.peers.on('message', (id, msg, conn) => this.onMessage(id, msg, conn));
  }

  private get me(): string {
    return this.deps.identity.deviceId;
  }

  // ---------------------------------------------------------------- queries

  listConversations(archived: boolean): ConversationSummary[] {
    const rows = this.deps.db
      .select()
      .from(conversations)
      .where(eq(conversations.archived, archived))
      .all();
    return rows
      .map((r) => this.summary(r))
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          (b.lastMessage?.sentAt ?? 0) - (a.lastMessage?.sentAt ?? 0) ||
          a.title.localeCompare(b.title),
      );
  }

  getConversation(conversationId: string): ConversationSummary {
    return this.summary(this.requireConversation(conversationId));
  }

  /** Opens (creating if needed) the direct conversation with an accepted contact. */
  openDirect(deviceId: string): ConversationSummary {
    const contact = this.deps.contacts.get(deviceId);
    if (!contact || contact.state !== 'accepted')
      throw new ChatError('You can only message accepted contacts.');
    return this.summary(
      this.ensureConversation(directConversationId(deviceId), 'direct', deviceId),
    );
  }

  listMessages(
    conversationId: string,
    before: { sentAt: number; id: string } | null,
    limit: number,
  ): MessagePage {
    this.requireConversation(conversationId);
    const cursor = before
      ? sql`AND (sent_at < ${before.sentAt} OR (sent_at = ${before.sentAt} AND id < ${before.id}))`
      : sql``;
    const rows = this.deps.db.all<{ id: string }>(
      sql`SELECT id FROM messages WHERE conversation_id = ${conversationId} ${cursor}
          ORDER BY sent_at DESC, id DESC LIMIT ${limit + 1}`,
    );
    const hasMore = rows.length > limit;
    const ids = rows.slice(0, limit).map((r) => r.id);
    return { messages: this.hydrate(ids).reverse(), hasMore };
  }

  getMessage(id: string): ChatMessage | null {
    return this.hydrate([id])[0] ?? null;
  }

  /** How many messages (including it) are at or after `messageId`; null if absent. */
  messagePosition(conversationId: string, messageId: string): number | null {
    const row = this.messageRow(messageId, conversationId);
    if (!row) return null;
    return this.deps.sqlite
      .prepare(
        `SELECT count(*) FROM messages WHERE conversation_id = ?
         AND (sent_at > ? OR (sent_at = ? AND id >= ?))`,
      )
      .pluck()
      .get(conversationId, row.sentAt, row.sentAt, row.id) as number;
  }

  search(query: string, conversationId: string | null): SearchHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const scope = conversationId ? sql`AND m.conversation_id = ${conversationId}` : sql``;
    const rows = this.deps.db.all<{
      id: string;
      conversation_id: string;
      sender_device_id: string;
      sent_at: number;
      snippet: string;
    }>(sql`
      SELECT m.id, m.conversation_id, m.sender_device_id, m.sent_at,
             snippet(messages_fts, 0, char(1), char(2), '…', 12) AS snippet
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ${match} AND m.deleted_at IS NULL ${scope}
      ORDER BY m.sent_at DESC
      LIMIT 100`);
    return rows.map((r) => ({
      messageId: r.id,
      conversationId: r.conversation_id,
      conversationTitle: this.title(this.requireConversation(r.conversation_id)),
      senderName: this.senderName(r.sender_device_id),
      sentAt: r.sent_at,
      snippet: r.snippet,
    }));
  }

  // ---------------------------------------------------------------- actions

  send(
    conversationId: string,
    body: string,
    replyToId: string | null,
    extra: {
      kind?: 'text' | 'file' | 'voice';
      attachmentId?: string;
      file?: ChatEventFile;
      mentions?: string[];
    } = {},
  ): ChatMessage {
    const conversation = this.requireConversation(conversationId);
    const reason = this.cannotSendReason(conversation);
    if (reason) throw new ChatError(reason);
    if (replyToId && !this.messageRow(replyToId, conversationId)) replyToId = null;

    const id = uuidv7(this.now());
    const sentAt = this.clock.now();
    const kind = extra.kind ?? 'text';
    const event: ChatEvent = {
      k: 'msg',
      id,
      kind,
      body,
      replyTo: replyToId,
      sentAt,
      mentions: extra.mentions ?? [],
      file: extra.file ?? null,
    };
    this.deps.sqlite.transaction(() => {
      this.deps.db
        .insert(messages)
        .values({
          id,
          conversationId,
          senderDeviceId: this.me,
          kind,
          body,
          replyToId,
          sentAt,
          receivedAt: this.now(),
          status: 'pending',
          attachmentId: extra.attachmentId ?? null,
        })
        .run();
      this.deps.db
        .update(conversations)
        .set({ lastMessageAt: sentAt, draft: '', archived: false })
        .where(eq(conversations.id, conversationId))
        .run();
      this.enqueue(conversation, event, id);
    })();
    this.flushConversation(conversation);
    this.changed(conversationId);
    const message = this.getMessage(id);
    if (!message) throw new Error('Message was not stored');
    return message;
  }

  edit(messageId: string, body: string): ChatMessage {
    const row = this.ownMessage(messageId);
    if (row.kind !== 'text') throw new ChatError('Only text messages can be edited.');
    if (row.deletedAt) throw new ChatError('This message was deleted.');
    const conversation = this.requireConversation(row.conversationId);
    if (this.cannotSendReason(conversation))
      throw new ChatError(this.cannotSendReason(conversation) ?? '');
    const editedAt = this.clock.now();
    this.deps.sqlite.transaction(() => {
      this.deps.db.update(messages).set({ body, editedAt }).where(eq(messages.id, messageId)).run();
      this.enqueue(conversation, { k: 'edit', id: messageId, body, editedAt }, null);
    })();
    this.flushConversation(conversation);
    this.changed(row.conversationId);
    return this.requireMessage(messageId);
  }

  /**
   * Delete for everyone: replaces the message with a tombstone here and asks
   * recipients to do the same. A recipient that already read or copied the
   * message cannot be forced to forget it; the UI says so.
   * Delete for me: removes the local copy only.
   */
  delete(messageId: string, forEveryone: boolean): void {
    const row = this.anyMessage(messageId);
    if (!forEveryone) {
      this.deps.db.delete(messages).where(eq(messages.id, messageId)).run();
      this.changed(row.conversationId);
      return;
    }
    if (row.senderDeviceId !== this.me)
      throw new ChatError('You can only delete your own messages for everyone.');
    if (row.deletedAt) return;
    const conversation = this.requireConversation(row.conversationId);
    const deletedAt = this.clock.now();
    this.deps.sqlite.transaction(() => {
      this.tombstone(messageId, deletedAt);
      this.enqueue(conversation, { k: 'delete', id: messageId, deletedAt }, null);
    })();
    this.flushConversation(conversation);
    this.changed(row.conversationId);
  }

  react(messageId: string, emoji: string, on: boolean): ChatMessage {
    const row = this.anyMessage(messageId);
    if (row.deletedAt) throw new ChatError('This message was deleted.');
    const conversation = this.requireConversation(row.conversationId);
    const reason = this.cannotSendReason(conversation);
    if (reason) throw new ChatError(reason);
    const at = this.clock.now();
    this.deps.sqlite.transaction(() => {
      this.applyReaction(messageId, this.me, emoji, on, at);
      this.enqueue(conversation, { k: 'react', id: messageId, emoji, on, at }, null);
    })();
    this.flushConversation(conversation);
    this.changed(row.conversationId);
    return this.requireMessage(messageId);
  }

  /** Marks incoming messages read and (if enabled) sends read receipts. */
  markRead(conversationId: string): void {
    const conversation = this.requireConversation(conversationId);
    const unread = this.deps.db
      .select({ id: messages.id, sender: messages.senderDeviceId })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.status, 'received')))
      .all();
    if (unread.length === 0 && conversation.unreadCount === 0) return;
    // In groups a per-member read state would mislead (one reader marks it read for all), so none are sent.
    const sendReceipts =
      conversation.kind === 'direct' && this.deps.settings.get('sendReadReceipts');
    this.deps.sqlite.transaction(() => {
      this.deps.db
        .update(messages)
        .set({ status: 'read' })
        .where(and(eq(messages.conversationId, conversationId), eq(messages.status, 'received')))
        .run();
      this.deps.db
        .update(conversations)
        .set({ unreadCount: 0 })
        .where(eq(conversations.id, conversationId))
        .run();
      if (sendReceipts) {
        const bySender = new Map<string, string[]>();
        for (const m of unread) bySender.set(m.sender, [...(bySender.get(m.sender) ?? []), m.id]);
        for (const [sender, ids] of bySender) {
          for (let i = 0; i < ids.length; i += 500) {
            this.enqueueTo(sender, conversation, { k: 'read', ids: ids.slice(i, i + 500) }, null);
          }
        }
      }
    })();
    if (sendReceipts) this.flushConversation(conversation);
    this.deps.emit({ type: 'conversations-changed' });
  }

  setActive(conversationId: string | null): void {
    this.activeConversation = conversationId;
    if (conversationId && this.deps.isWindowFocused()) this.markRead(conversationId);
  }

  /** Called when the window gains focus, so the open conversation counts as read. */
  onWindowFocused(): void {
    if (this.activeConversation) this.markRead(this.activeConversation);
  }

  setDraft(conversationId: string, draft: string): void {
    this.requireConversation(conversationId);
    this.deps.db
      .update(conversations)
      .set({ draft })
      .where(eq(conversations.id, conversationId))
      .run();
  }

  setFlags(
    conversationId: string,
    flags: { pinned?: boolean; archived?: boolean; muted?: boolean },
  ): ConversationSummary {
    this.requireConversation(conversationId);
    const set: Partial<ConversationRow> = {};
    if (flags.pinned !== undefined) set.pinned = flags.pinned;
    if (flags.archived !== undefined) set.archived = flags.archived;
    if (flags.muted !== undefined) set.muted = flags.muted;
    if (Object.keys(set).length) {
      this.deps.db.update(conversations).set(set).where(eq(conversations.id, conversationId)).run();
    }
    this.deps.emit({ type: 'conversations-changed' });
    return this.getConversation(conversationId);
  }

  /** Ephemeral: never queued; dropped if the peer isn't connected. */
  typing(conversationId: string): void {
    if (!this.deps.settings.get('sendTypingIndicators')) return;
    const conversation = this.requireConversation(conversationId);
    const conv = conversation.kind === 'group' ? conversation.id : null;
    for (const id of this.recipients(conversation))
      this.deps.peers.send(id, { t: 'typing', conv, on: true });
  }

  pendingCount(): number {
    return this.deps.sqlite.prepare('SELECT count(*) FROM outbox').pluck().get() as number;
  }

  /** A local, never-sent note in the timeline (e.g. "Alice added Bob"). */
  addSystemMessage(conversationId: string, text: string): void {
    const sentAt = this.clock.now();
    this.deps.db
      .insert(messages)
      .values({
        id: uuidv7(this.now()),
        conversationId,
        senderDeviceId: SYSTEM_SENDER,
        kind: 'system',
        body: text,
        sentAt,
        receivedAt: this.now(),
        status: 'read',
      })
      .run();
    this.deps.db
      .update(conversations)
      .set({ lastMessageAt: sentAt })
      .where(eq(conversations.id, conversationId))
      .run();
    this.changed(conversationId);
  }

  stop(): void {
    for (const t of this.typingTimers.values()) clearTimeout(t);
    this.typingTimers.clear();
  }

  // ------------------------------------------------------- internal: outbox

  /** Queues `event` for every recipient of the conversation. */
  enqueue(conversation: ConversationRow, event: ChatEvent, messageId: string | null): void {
    for (const target of this.recipients(conversation))
      this.enqueueTo(target, conversation, event, messageId);
  }

  private enqueueTo(
    target: string,
    conversation: ConversationRow,
    event: ChatEvent,
    messageId: string | null,
  ): void {
    const wire: WireMessage = {
      t: 'ev',
      eid: crypto.randomUUID(),
      conv: conversation.kind === 'group' ? conversation.id : null,
      ev: event,
    };
    this.deps.db
      .insert(outbox)
      .values({
        eventId: wire.eid,
        targetDeviceId: target,
        conversationId: conversation.id,
        messageId,
        payload: JSON.stringify(wire),
        createdAt: this.now(),
      })
      .run();
  }

  private flushConversation(conversation: ConversationRow): void {
    for (const id of this.recipients(conversation)) this.flush(id);
  }

  /** Sends queued events to `deviceId`, keeping at most OUTBOX_WINDOW unacked. */
  flush(deviceId: string): void {
    if (!this.deps.peers.isConnected(deviceId)) return;
    const inFlight = this.inFlight.get(deviceId) ?? new Set<string>();
    this.inFlight.set(deviceId, inFlight);
    const room = OUTBOX_WINDOW - inFlight.size;
    if (room <= 0) return;
    const rows = this.deps.db
      .select()
      .from(outbox)
      .where(eq(outbox.targetDeviceId, deviceId))
      .orderBy(outbox.createdAt)
      .limit(OUTBOX_WINDOW)
      .all()
      .filter((r) => !inFlight.has(r.eventId))
      .slice(0, room);
    const now = this.now();
    for (const row of rows) {
      const sent = this.deps.peers.send(deviceId, JSON.parse(row.payload) as WireMessage);
      if (!sent) break;
      inFlight.add(row.eventId);
      this.deps.db
        .update(outbox)
        .set({ attempts: row.attempts + 1, lastAttemptAt: now })
        .where(and(eq(outbox.eventId, row.eventId), eq(outbox.targetDeviceId, deviceId)))
        .run();
    }
  }

  private onConnected(conn: PeerConnection): void {
    const id = conn.remoteDeviceId;
    if (!this.deps.contacts.isTrusted(id) && !this.groups?.isMember(id)) return;
    this.inFlight.delete(id);
    this.flush(id);
  }

  /**
   * Queues any reliable wire message (e.g. group membership) for `target`.
   * Delivered and retried exactly like chat events; the receiver acks the eid.
   */
  enqueueWire(
    target: string,
    conversationId: string | null,
    make: (eventId: string) => WireMessage,
  ): void {
    const eid = crypto.randomUUID();
    this.deps.db
      .insert(outbox)
      .values({
        eventId: eid,
        targetDeviceId: target,
        conversationId,
        messageId: null,
        payload: JSON.stringify(make(eid)),
        createdAt: this.now(),
      })
      .run();
    this.flush(target);
  }

  private onAck(from: string, eids: string[]): void {
    const rows = this.deps.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.targetDeviceId, from), inArray(outbox.eventId, eids)))
      .all();
    if (rows.length === 0) return;
    const changedConversations = new Set<string>();
    this.deps.sqlite.transaction(() => {
      for (const row of rows) {
        this.deps.db
          .delete(outbox)
          .where(and(eq(outbox.eventId, row.eventId), eq(outbox.targetDeviceId, from)))
          .run();
        if (row.messageId) {
          this.markDeliveredIfComplete(row.messageId);
          if (row.conversationId) changedConversations.add(row.conversationId);
        }
      }
    })();
    const inFlight = this.inFlight.get(from);
    for (const eid of eids) inFlight?.delete(eid);
    for (const c of changedConversations) this.changed(c);
    this.flush(from);
  }

  /** A message counts as delivered once every recipient has acked it. */
  private markDeliveredIfComplete(messageId: string): void {
    const remaining = this.deps.sqlite
      .prepare('SELECT count(*) FROM outbox WHERE message_id = ?')
      .pluck()
      .get(messageId) as number;
    if (remaining === 0) {
      this.deps.db
        .update(messages)
        .set({ status: 'delivered' })
        .where(and(eq(messages.id, messageId), eq(messages.status, 'pending')))
        .run();
    }
  }

  // ------------------------------------------------- internal: receiving

  private onMessage(from: string, msg: WireMessage, conn: PeerConnection): void {
    switch (msg.t) {
      case 'ev':
        this.onEvent(from, msg, conn);
        return;
      case 'ev_ack':
        this.onAck(from, msg.eids);
        return;
      case 'typing':
        this.onTyping(from, msg.conv);
        return;
      default:
        return;
    }
  }

  private onEvent(from: string, msg: WireMessageOf<'ev'>, conn: PeerConnection): void {
    if (!this.deps.contacts.isTrusted(from) && !(msg.conv && this.groups?.canPost(msg.conv, from)))
      return;
    const conversationId = msg.conv ?? directConversationId(from);
    if (msg.conv && !this.groups?.canPost(msg.conv, from)) {
      // Not a member (anymore): ack so the sender stops retrying, but apply nothing.
      conn.send({ t: 'ev_ack', eids: [msg.eid] });
      return;
    }
    try {
      this.deps.sqlite.transaction(() => this.apply(from, conversationId, msg.ev))();
    } catch (error) {
      this.deps.logger.error('chat.apply_failed', { kind: msg.ev.k, error });
      return; // not acked: the sender will retry after reconnect
    }
    conn.send({ t: 'ev_ack', eids: [msg.eid] });
  }

  private apply(from: string, conversationId: string, ev: ChatEvent): void {
    switch (ev.k) {
      case 'msg': {
        this.clock.observe(ev.sentAt);
        const conversation = this.ensureConversation(
          conversationId,
          conversationId.startsWith('g:') ? 'group' : 'direct',
          conversationId.startsWith('d:') ? from : null,
        );
        const existing = this.deps.db.select().from(messages).where(eq(messages.id, ev.id)).get();
        if (existing) return; // duplicate delivery
        const replyTo =
          ev.replyTo && this.messageRow(ev.replyTo, conversationId) ? ev.replyTo : null;
        const attachmentId = ev.file
          ? (this.onIncomingFile?.(from, conversationId, ev.id, ev.file, ev.kind) ?? null)
          : null;
        this.deps.db
          .insert(messages)
          .values({
            id: ev.id,
            conversationId,
            senderDeviceId: from,
            kind: ev.kind,
            body: ev.body,
            replyToId: replyTo,
            sentAt: ev.sentAt,
            receivedAt: this.now(),
            status: 'received',
            attachmentId,
            mentionsMe: ev.mentions.includes(this.me),
          })
          .run();
        const visible = this.activeConversation === conversationId && this.deps.isWindowFocused();
        this.deps.db
          .update(conversations)
          .set({
            lastMessageAt: sql`max(coalesce(${conversations.lastMessageAt}, 0), ${ev.sentAt})`,
            unreadCount: visible ? conversation.unreadCount : sql`${conversations.unreadCount} + 1`,
            archived: false,
          })
          .where(eq(conversations.id, conversationId))
          .run();
        this.changed(conversationId);
        if (visible) queueMicrotask(() => this.markRead(conversationId));
        else this.notifyIncoming(conversation, from, ev.mentions.includes(this.me));
        return;
      }
      case 'edit': {
        const row = this.messageRow(ev.id, conversationId);
        if (!row || row.senderDeviceId !== from || row.deletedAt || row.kind !== 'text') return;
        if ((row.editedAt ?? 0) >= ev.editedAt) return;
        this.clock.observe(ev.editedAt);
        this.deps.db
          .update(messages)
          .set({ body: ev.body, editedAt: ev.editedAt })
          .where(eq(messages.id, ev.id))
          .run();
        this.changed(conversationId);
        return;
      }
      case 'delete': {
        const row = this.messageRow(ev.id, conversationId);
        if (!row || row.senderDeviceId !== from || row.deletedAt) return;
        this.tombstone(ev.id, ev.deletedAt);
        this.changed(conversationId);
        return;
      }
      case 'react': {
        const row = this.messageRow(ev.id, conversationId);
        if (!row || row.deletedAt) return;
        this.applyReaction(ev.id, from, ev.emoji, ev.on, ev.at);
        this.changed(conversationId);
        return;
      }
      case 'read': {
        const updated = this.deps.db
          .update(messages)
          .set({ status: 'read' })
          .where(
            and(
              inArray(messages.id, ev.ids),
              eq(messages.conversationId, conversationId),
              eq(messages.senderDeviceId, this.me),
              inArray(messages.status, ['pending', 'delivered']),
            ),
          )
          .run();
        if (updated.changes > 0) this.changed(conversationId);
        return;
      }
    }
  }

  /** Hook for file transfers (M4): returns the local attachment ID for an offered file. */
  onIncomingFile:
    | ((
        from: string,
        conversationId: string,
        messageId: string,
        file: ChatEventFile,
        kind: 'text' | 'file' | 'voice',
      ) => string | null)
    | null = null;

  private onTyping(from: string, conv: string | null): void {
    const conversationId = conv ?? directConversationId(from);
    if (conv && !this.groups?.canPost(conv, from)) return;
    if (!conv && !this.deps.contacts.isTrusted(from)) return;
    const key = `${conversationId}|${from}`;
    clearTimeout(this.typingTimers.get(key));
    this.deps.emit({ type: 'typing', conversationId, deviceId: from, on: true });
    const timer = setTimeout(() => {
      this.typingTimers.delete(key);
      this.deps.emit({ type: 'typing', conversationId, deviceId: from, on: false });
    }, TYPING_TTL_MS);
    timer.unref();
    this.typingTimers.set(key, timer);
  }

  private notifyIncoming(conversation: ConversationRow, from: string, mentioned: boolean): void {
    if (!this.deps.settings.get('notificationsEnabled')) return;
    if (conversation.muted && !mentioned) return;
    const title = this.title(conversation);
    const body =
      conversation.kind === 'group'
        ? `${this.senderName(from)} ${mentioned ? 'mentioned you' : 'sent a message'}`
        : 'New message';
    // Message text is deliberately not shown: notifications can appear on a locked screen.
    this.deps.notify(title, body);
  }

  // ---------------------------------------------------- internal: helpers

  private applyReaction(
    messageId: string,
    reactor: string,
    emoji: string,
    on: boolean,
    at: number,
  ): void {
    if (on) {
      this.deps.db
        .insert(reactions)
        .values({ messageId, reactorDeviceId: reactor, emoji, createdAt: at })
        .onConflictDoNothing()
        .run();
    } else {
      this.deps.db
        .delete(reactions)
        .where(
          and(
            eq(reactions.messageId, messageId),
            eq(reactions.reactorDeviceId, reactor),
            eq(reactions.emoji, emoji),
          ),
        )
        .run();
    }
  }

  private tombstone(messageId: string, deletedAt: number): void {
    this.deps.db
      .update(messages)
      .set({ body: '', deletedAt })
      .where(eq(messages.id, messageId))
      .run();
    this.deps.db.delete(reactions).where(eq(reactions.messageId, messageId)).run();
  }

  recipients(conversation: ConversationRow): string[] {
    if (conversation.kind === 'group') return this.groups?.recipients(conversation.id) ?? [];
    return conversation.peerDeviceId ? [conversation.peerDeviceId] : [];
  }

  private cannotSendReason(conversation: ConversationRow): string | null {
    if (conversation.kind === 'group') {
      // null from the resolver means "allowed"; only a missing resolver is an error.
      return this.groups
        ? this.groups.cannotSendReason(conversation.id)
        : 'Groups are not available.';
    }
    const contact = conversation.peerDeviceId
      ? this.deps.contacts.get(conversation.peerDeviceId)
      : null;
    if (!contact) return 'This person is no longer in your contacts.';
    if (contact.state === 'blocked') return 'You blocked this contact.';
    if (contact.state !== 'accepted') return 'This person is no longer in your contacts.';
    return null;
  }

  ensureConversation(
    id: string,
    kind: 'direct' | 'group',
    peerDeviceId: string | null,
  ): ConversationRow {
    this.deps.db
      .insert(conversations)
      .values({ id, kind, peerDeviceId, createdAt: this.now() })
      .onConflictDoNothing()
      .run();
    const created = this.deps.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!created) throw new Error('Conversation was not created');
    return created;
  }

  private requireConversation(id: string): ConversationRow {
    const row = this.deps.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) throw new ChatError('Conversation not found.');
    return row;
  }

  private messageRow(id: string, conversationId: string): MessageRow | undefined {
    return this.deps.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, id), eq(messages.conversationId, conversationId)))
      .get();
  }

  private anyMessage(id: string): MessageRow {
    const row = this.deps.db.select().from(messages).where(eq(messages.id, id)).get();
    if (!row) throw new ChatError('Message not found.');
    return row;
  }

  private ownMessage(id: string): MessageRow {
    const row = this.anyMessage(id);
    if (row.senderDeviceId !== this.me)
      throw new ChatError('You can only change your own messages.');
    return row;
  }

  private requireMessage(id: string): ChatMessage {
    const m = this.getMessage(id);
    if (!m) throw new ChatError('Message not found.');
    return m;
  }

  title(conversation: ConversationRow): string {
    if (conversation.kind === 'group') return this.groups?.title(conversation.id) ?? 'Group';
    return conversation.peerDeviceId ? this.senderName(conversation.peerDeviceId) : 'Unknown';
  }

  private senderName(deviceId: string): string {
    if (deviceId === SYSTEM_SENDER) return '';
    if (deviceId === this.me) return this.deps.identity.getAccount()?.displayName ?? 'You';
    const row = this.deps.db
      .select({ name: contacts.displayName })
      .from(contacts)
      .where(eq(contacts.deviceId, deviceId))
      .get();
    return row?.name ?? this.groups?.memberName(deviceId) ?? `Device ${deviceId.slice(0, 7)}`;
  }

  private summary(r: ConversationRow): ConversationSummary {
    const last = this.deps.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, r.id))
      .orderBy(desc(messages.sentAt), desc(messages.id))
      .limit(1)
      .get();
    const pending = this.deps.sqlite
      .prepare('SELECT count(DISTINCT event_id) FROM outbox WHERE conversation_id = ?')
      .pluck()
      .get(r.id) as number;
    const peer = r.peerDeviceId ? this.deps.contacts.get(r.peerDeviceId) : null;
    return {
      id: r.id,
      kind: r.kind,
      title: this.title(r),
      peerDeviceId: r.peerDeviceId,
      online: peer?.online ?? false,
      pinned: r.pinned,
      archived: r.archived,
      muted: r.muted,
      unreadCount: r.unreadCount,
      draft: r.draft,
      lastMessage: last
        ? {
            excerpt: excerpt(last),
            sentAt: last.sentAt,
            fromMe: last.senderDeviceId === this.me,
            senderName: this.senderName(last.senderDeviceId),
          }
        : null,
      cannotSendReason: this.cannotSendReason(r),
      pendingCount: pending,
    };
  }

  /** Builds full ChatMessage objects for the given IDs, in the given order. */
  private hydrate(ids: string[]): ChatMessage[] {
    if (ids.length === 0) return [];
    const rows = this.deps.db.select().from(messages).where(inArray(messages.id, ids)).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const reactionRows = this.deps.db
      .select()
      .from(reactions)
      .where(inArray(reactions.messageId, ids))
      .all();
    const replyIds = [
      ...new Set(rows.map((r) => r.replyToId).filter((x): x is string => x !== null)),
    ];
    const replies = replyIds.length
      ? new Map(
          this.deps.db
            .select()
            .from(messages)
            .where(inArray(messages.id, replyIds))
            .all()
            .map((r) => [r.id, r]),
        )
      : new Map<string, MessageRow>();
    const names = new Map<string, string>();
    const name = (id: string) => {
      if (!names.has(id)) names.set(id, this.senderName(id));
      return names.get(id) ?? '';
    };

    return ids
      .map((id) => byId.get(id))
      .filter((r): r is MessageRow => r !== undefined)
      .map((r) => {
        const grouped = new Map<string, ReactionSummary>();
        for (const re of reactionRows) {
          if (re.messageId !== r.id) continue;
          const g = grouped.get(re.emoji) ?? { emoji: re.emoji, count: 0, mine: false, names: [] };
          g.count++;
          g.mine ||= re.reactorDeviceId === this.me;
          g.names.push(name(re.reactorDeviceId));
          grouped.set(re.emoji, g);
        }
        const reply = r.replyToId ? replies.get(r.replyToId) : undefined;
        const replyTo: ReplyPreview | null = reply
          ? {
              id: reply.id,
              senderName: name(reply.senderDeviceId),
              excerpt: excerpt(reply),
              deleted: reply.deletedAt !== null,
            }
          : null;
        return {
          id: r.id,
          conversationId: r.conversationId,
          senderDeviceId: r.senderDeviceId,
          senderName: name(r.senderDeviceId),
          fromMe: r.senderDeviceId === this.me,
          kind: r.kind,
          body: r.body,
          replyTo,
          sentAt: r.sentAt,
          editedAt: r.editedAt,
          deletedAt: r.deletedAt,
          status: r.status as MessageStatus,
          reactions: [...grouped.values()],
          attachment: r.attachmentId ? (this.attachmentSummary?.(r.attachmentId) ?? null) : null,
          mentionsMe: r.mentionsMe,
        };
      });
  }

  /** Hook for file transfers (M4). */
  attachmentSummary: ((attachmentId: string) => ChatMessage['attachment']) | null = null;

  private changed(conversationId: string): void {
    this.deps.emit({ type: 'messages-changed', conversationId });
    this.deps.emit({ type: 'conversations-changed' });
  }
}

export type ChatEventFile = NonNullable<Extract<ChatEvent, { k: 'msg' }>['file']>;

function excerpt(m: MessageRow): string {
  if (m.deletedAt) return 'Message deleted';
  if (m.kind === 'voice') return 'Voice message';
  if (m.kind === 'file' && !m.body) return 'File';
  const flat = m.body.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

/**
 * Turns free text into a safe FTS5 query: every whitespace-separated term is
 * quoted (so operators like NEAR/OR/* in user input are literal) and
 * prefix-matched.
 */
export function ftsQuery(input: string): string | null {
  const terms = input
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""').trim())
    .filter((t) => t.length > 0)
    .slice(0, 10);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' ');
}
