import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppEvent } from '../../shared/events';
import {
  groupConversationId,
  type DiscoveredGroup,
  type GroupDetails,
  type GroupMember,
  type GroupPolicy,
  type GroupRole,
} from '../../shared/groups';
import type { ChatService, ConversationResolver } from '../chat/chat-service';
import type { AppDatabase } from '../db/connection';
import { groupJoinPending, groupJoinRequests, groupMembers, groups } from '../db/schema';
import { UserFacingError } from '../errors';
import type { IdentityService } from '../identity/identity-service';
import type { Logger } from '../logger';
import type { PeerConnection } from '../peer/peer-connection';
import type { PeerService } from '../peer/peer-service';
import type { WireMessage } from '../peer/wire';
import type { ContactsService } from '../services/contacts-service';
import type { SettingsService } from '../services/settings-service';
import type { GroupEvent, GroupSnapshot } from './group-wire';

type GroupRow = typeof groups.$inferSelect;
type MemberRow = typeof groupMembers.$inferSelect;

const DISCOVER_WAIT_MS = 1500;

export class GroupError extends UserFacingError {
  override name = 'GroupError';
}

export interface GroupServiceDeps {
  db: AppDatabase;
  sqlite: Database.Database;
  identity: IdentityService;
  contacts: ContactsService;
  peers: PeerService;
  chat: ChatService;
  settings: SettingsService;
  logger: Logger;
  emit(event: AppEvent): void;
  notify(title: string, body: string): void;
  now?: () => number;
}

/**
 * Local-network groups.
 *
 * Membership is a versioned snapshot owned by the group's admins: every change
 * bumps the version and the full snapshot is sent (via the reliable outbox) to
 * every member. A device accepts a snapshot only from someone who is an admin
 * in its current view (or, for a first invitation, from a contact who is an
 * admin in the snapshot), and only if the version is newer.
 *
 * Messages are fanned out by their author directly to each member over
 * authenticated PeerLinks; nobody relays anyone else's messages. Members who
 * are offline receive messages when both they and the author are online.
 * Concurrent edits by two admins resolve to whichever snapshot arrives first
 * with the higher version; the other is dropped (documented limitation).
 */
export class GroupService implements ConversationResolver {
  private readonly now: () => number;
  private discoverReplies: Map<string, DiscoveredGroup> | null = null;

  constructor(private readonly deps: GroupServiceDeps) {
    this.now = deps.now ?? Date.now;
    deps.chat.groups = this;
    deps.contacts.setReconnectExtension({
      wants: (id) => this.isMember(id),
      target: (id) => this.addressHint(id),
      all: () => this.coMembers(),
    });
    deps.peers.on('message', (from, msg, conn) => this.onMessage(from, msg, conn));
    deps.peers.on('connected', () => this.changed());
    deps.peers.on('disconnected', () => this.changed());
  }

  private get me(): string {
    return this.deps.identity.deviceId;
  }

  // ------------------------------------------------- ConversationResolver

  recipients(conversationId: string): string[] | null {
    const g = this.groupForConversation(conversationId);
    if (!g || g.myStatus !== 'active') return [];
    return this.members(g.id)
      .filter((m) => m.status === 'active' && m.deviceId !== this.me)
      .map((m) => m.deviceId);
  }

  canPost(conversationId: string, deviceId: string): boolean {
    const g = this.groupForConversation(conversationId);
    if (!g || g.myStatus !== 'active') return false;
    const m = this.member(g.id, deviceId);
    if (!m || m.status !== 'active') return false;
    return g.policy === 'everyone' || m.role !== 'member';
  }

  title(conversationId: string): string | null {
    return this.groupForConversation(conversationId)?.name ?? null;
  }

  cannotSendReason(conversationId: string): string | null {
    const g = this.groupForConversation(conversationId);
    if (!g) return 'This group no longer exists.';
    switch (g.myStatus) {
      case 'invited':
        return 'Accept the invitation to take part in this group.';
      case 'left':
        return 'You left this group.';
      case 'removed':
        return 'You were removed from this group.';
      case 'deleted':
        return 'This group was deleted by its owner.';
      default:
        break;
    }
    if (!this.canPost(conversationId, this.me)) return 'Only admins can post in this group.';
    return null;
  }

  /** True if we share an active (or pending) group with `deviceId`. */
  isMember(deviceId: string): boolean {
    if (deviceId === this.me) return false;
    const rows = this.deps.db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.deviceId, deviceId))
      .all();
    return rows.some((r) => {
      const g = this.group(r.groupId);
      return g !== undefined && (g.myStatus === 'active' || g.myStatus === 'invited');
    });
  }

  memberName(deviceId: string): string | null {
    return (
      this.deps.db.select().from(groupMembers).where(eq(groupMembers.deviceId, deviceId)).get()
        ?.displayName ?? null
    );
  }

  // ---------------------------------------------------------------- queries

  list(): GroupDetails[] {
    return this.deps.db
      .select()
      .from(groups)
      .all()
      .map((g) => this.details(g.id));
  }

  details(groupId: string): GroupDetails {
    const g = this.requireGroup(groupId);
    const me = this.member(groupId, this.me);
    const myRole = me?.role ?? null;
    const active = g.myStatus === 'active';
    const isAdmin = active && (myRole === 'owner' || myRole === 'admin');
    const members: GroupMember[] = this.members(groupId).map((m) => ({
      deviceId: m.deviceId,
      displayName:
        m.deviceId === this.me
          ? (this.deps.identity.getAccount()?.displayName ?? m.displayName)
          : m.displayName,
      role: m.role,
      status: m.status,
      online: m.deviceId === this.me || this.deps.peers.isConnected(m.deviceId),
      isMe: m.deviceId === this.me,
      isContact: this.deps.contacts.isTrusted(m.deviceId),
      canRemove:
        isAdmin &&
        m.deviceId !== this.me &&
        m.role !== 'owner' &&
        (myRole === 'owner' || m.role === 'member'),
      canChangeRole:
        active && myRole === 'owner' && m.deviceId !== this.me && m.status === 'active',
    }));
    const order: Record<GroupRole, number> = { owner: 0, admin: 1, member: 2 };
    members.sort(
      (a, b) => order[a.role] - order[b.role] || a.displayName.localeCompare(b.displayName),
    );
    const requests = isAdmin
      ? this.deps.db
          .select()
          .from(groupJoinRequests)
          .where(eq(groupJoinRequests.groupId, groupId))
          .all()
      : [];
    return {
      id: g.id,
      conversationId: groupConversationId(g.id),
      name: g.name,
      description: g.description,
      policy: g.policy,
      discoverable: g.discoverable,
      myStatus: g.myStatus,
      myRole,
      invitedBy: g.invitedBy,
      invitedByName: g.invitedBy
        ? (this.deps.contacts.get(g.invitedBy)?.displayName ?? null)
        : null,
      canPost: this.canPost(groupConversationId(g.id), this.me),
      canEdit: isAdmin,
      canInvite: isAdmin,
      canDelete: active && myRole === 'owner',
      members,
      joinRequests: requests.map((r) => ({
        deviceId: r.deviceId,
        displayName:
          this.deps.contacts.get(r.deviceId)?.displayName ?? `Device ${r.deviceId.slice(0, 7)}`,
        note: r.note,
        at: r.createdAt,
      })),
      createdAt: g.createdAt,
    };
  }

  // ---------------------------------------------------------------- actions

  create(input: {
    name: string;
    description: string;
    memberIds: string[];
    policy: GroupPolicy;
    discoverable: boolean;
  }): GroupDetails {
    const account = this.deps.identity.getAccount();
    if (!account) throw new GroupError('Create your profile first.');
    const invitees = [...new Set(input.memberIds)].filter((id) => id !== this.me);
    for (const id of invitees) {
      if (!this.deps.contacts.isTrusted(id))
        throw new GroupError('You can only invite your contacts.');
    }
    const id = randomUUID();
    const now = this.now();
    this.deps.sqlite.transaction(() => {
      this.deps.db
        .insert(groups)
        .values({
          id,
          name: input.name,
          description: input.description,
          policy: input.policy,
          discoverable: input.discoverable,
          version: 1,
          myStatus: 'active',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      this.deps.db
        .insert(groupMembers)
        .values({
          groupId: id,
          deviceId: this.me,
          displayName: account.displayName,
          role: 'owner',
          status: 'active',
        })
        .run();
      for (const inv of invitees) this.insertInvitee(id, inv);
      this.deps.chat.ensureConversation(groupConversationId(id), 'group', null);
    })();
    this.broadcast(id);
    this.changed();
    return this.details(id);
  }

  update(
    groupId: string,
    fields: { name?: string; description?: string; policy?: GroupPolicy; discoverable?: boolean },
  ): GroupDetails {
    this.requireAdmin(groupId);
    this.mutate(groupId, () => {
      const set: Partial<GroupRow> = {};
      if (fields.name !== undefined) set.name = fields.name;
      if (fields.description !== undefined) set.description = fields.description;
      if (fields.policy !== undefined) set.policy = fields.policy;
      if (fields.discoverable !== undefined) set.discoverable = fields.discoverable;
      this.deps.db.update(groups).set(set).where(eq(groups.id, groupId)).run();
    });
    return this.details(groupId);
  }

  invite(groupId: string, deviceIds: string[]): GroupDetails {
    this.requireAdmin(groupId);
    const fresh = [...new Set(deviceIds)].filter(
      (id) => id !== this.me && !this.member(groupId, id),
    );
    if (fresh.length === 0) throw new GroupError('Everyone you chose is already in the group.');
    for (const id of fresh) {
      if (!this.deps.contacts.isTrusted(id))
        throw new GroupError('You can only invite your contacts.');
    }
    this.mutate(groupId, () => {
      for (const id of fresh) this.insertInvitee(groupId, id);
    });
    return this.details(groupId);
  }

  removeMember(groupId: string, deviceId: string): GroupDetails {
    const target = this.details(groupId).members.find((m) => m.deviceId === deviceId);
    if (!target?.canRemove) throw new GroupError('You can’t remove this member.');
    this.mutate(groupId, () => this.deleteMember(groupId, deviceId), [deviceId]);
    return this.details(groupId);
  }

  setRole(groupId: string, deviceId: string, role: 'admin' | 'member'): GroupDetails {
    const target = this.details(groupId).members.find((m) => m.deviceId === deviceId);
    if (!target?.canChangeRole) throw new GroupError('Only the owner can change roles.');
    this.mutate(groupId, () => {
      this.deps.db
        .update(groupMembers)
        .set({ role })
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.deviceId, deviceId)))
        .run();
    });
    return this.details(groupId);
  }

  transferOwnership(groupId: string, deviceId: string): GroupDetails {
    const d = this.details(groupId);
    if (!d.canDelete) throw new GroupError('Only the owner can transfer ownership.');
    const target = d.members.find((m) => m.deviceId === deviceId);
    if (!target || target.isMe || target.status !== 'active')
      throw new GroupError('Choose an active member.');
    this.mutate(groupId, () => {
      this.deps.db
        .update(groupMembers)
        .set({ role: 'owner' })
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.deviceId, deviceId)))
        .run();
      this.deps.db
        .update(groupMembers)
        .set({ role: 'admin' })
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.deviceId, this.me)))
        .run();
    });
    return this.details(groupId);
  }

  leave(groupId: string): void {
    const g = this.requireGroup(groupId);
    if (g.myStatus !== 'active')
      throw new GroupError('You are not an active member of this group.');
    const me = this.member(groupId, this.me);
    const others = this.members(groupId).filter(
      (m) => m.deviceId !== this.me && m.status === 'active',
    );
    if (me?.role === 'owner' && others.length > 0) {
      throw new GroupError('Transfer ownership to another member before leaving.');
    }
    if (me?.role === 'owner') {
      this.deleteGroup(groupId);
      return;
    }
    // The owner sequences membership changes; it updates everyone else.
    for (const owner of this.members(groupId).filter((m) => m.role === 'owner')) {
      this.sendEvent(owner.deviceId, groupId, { k: 'leave', groupId });
    }
    this.deps.db
      .update(groups)
      .set({ myStatus: 'left', updatedAt: this.now() })
      .where(eq(groups.id, groupId))
      .run();
    this.changed();
  }

  deleteGroup(groupId: string): void {
    const d = this.details(groupId);
    if (!d.canDelete) throw new GroupError('Only the owner can delete the group.');
    const everyone = this.members(groupId).map((m) => m.deviceId);
    this.mutate(
      groupId,
      () => {
        this.deps.db
          .update(groups)
          .set({ myStatus: 'deleted' })
          .where(eq(groups.id, groupId))
          .run();
      },
      everyone,
      true,
    );
  }

  acceptInvite(groupId: string): GroupDetails {
    const g = this.requireGroup(groupId);
    if (g.myStatus !== 'invited')
      throw new GroupError('There is no pending invitation for this group.');
    this.deps.db
      .update(groups)
      .set({ myStatus: 'active', updatedAt: this.now() })
      .where(eq(groups.id, groupId))
      .run();
    this.deps.db
      .update(groupMembers)
      .set({ status: 'active' })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.deviceId, this.me)))
      .run();
    this.deps.chat.ensureConversation(groupConversationId(groupId), 'group', null);
    for (const owner of this.members(groupId).filter((m) => m.role === 'owner')) {
      this.sendEvent(owner.deviceId, groupId, { k: 'accept', groupId });
    }
    this.changed();
    return this.details(groupId);
  }

  declineInvite(groupId: string): void {
    const g = this.requireGroup(groupId);
    if (g.myStatus !== 'invited')
      throw new GroupError('There is no pending invitation for this group.');
    for (const owner of this.members(groupId).filter((m) => m.role === 'owner')) {
      this.sendEvent(owner.deviceId, groupId, { k: 'decline', groupId });
    }
    this.deps.db.delete(groups).where(eq(groups.id, groupId)).run();
    this.changed();
  }

  /** Asks connected contacts which of their groups are discoverable. */
  async discover(): Promise<DiscoveredGroup[]> {
    this.discoverReplies = new Map();
    for (const id of this.deps.peers.connectedDeviceIds()) {
      if (this.deps.contacts.isTrusted(id)) this.deps.peers.send(id, { t: 'group_list_req' });
    }
    await new Promise((r) => setTimeout(r, DISCOVER_WAIT_MS));
    const found = [...this.discoverReplies.values()].filter((d) => {
      const local = this.group(d.groupId);
      return !local || local.myStatus === 'left' || local.myStatus === 'removed';
    });
    this.discoverReplies = null;
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  requestJoin(groupId: string, adminDeviceId: string, note: string): void {
    if (!this.deps.contacts.isTrusted(adminDeviceId))
      throw new GroupError('You can only ask your contacts.');
    this.deps.db
      .insert(groupJoinPending)
      .values({ groupId, adminId: adminDeviceId, createdAt: this.now() })
      .onConflictDoUpdate({
        target: groupJoinPending.groupId,
        set: { adminId: adminDeviceId, createdAt: this.now() },
      })
      .run();
    this.sendEvent(adminDeviceId, null, { k: 'join_req', groupId, note });
  }

  decideJoin(groupId: string, deviceId: string, approve: boolean): GroupDetails {
    this.requireAdmin(groupId);
    const request = this.deps.db
      .select()
      .from(groupJoinRequests)
      .where(and(eq(groupJoinRequests.groupId, groupId), eq(groupJoinRequests.deviceId, deviceId)))
      .get();
    if (!request) throw new GroupError('That request is no longer pending.');
    this.deps.db
      .delete(groupJoinRequests)
      .where(and(eq(groupJoinRequests.groupId, groupId), eq(groupJoinRequests.deviceId, deviceId)))
      .run();
    if (approve && !this.member(groupId, deviceId)) {
      const name =
        this.deps.contacts.get(deviceId)?.displayName ?? `Device ${deviceId.slice(0, 7)}`;
      this.mutate(groupId, () => {
        this.deps.db
          .insert(groupMembers)
          .values({ groupId, deviceId, displayName: name, role: 'member', status: 'active' })
          .run();
      });
    } else {
      this.changed();
    }
    return this.details(groupId);
  }

  // --------------------------------------------------------------- receiving

  private onMessage(from: string, msg: WireMessage, conn: PeerConnection): void {
    switch (msg.t) {
      case 'group_ev': {
        try {
          this.deps.sqlite.transaction(() => this.apply(from, msg.ev))();
        } catch (error) {
          this.deps.logger.error('group.apply_failed', { kind: msg.ev.k, error });
          return; // not acked: retried later
        }
        conn.send({ t: 'ev_ack', eids: [msg.eid] });
        return;
      }
      case 'group_list_req': {
        if (!this.deps.contacts.isTrusted(from)) return;
        const listed = this.deps.db
          .select()
          .from(groups)
          .where(and(eq(groups.discoverable, true), eq(groups.myStatus, 'active')))
          .all()
          .filter((g) => ['owner', 'admin'].includes(this.member(g.id, this.me)?.role ?? ''));
        conn.send({
          t: 'group_list',
          groups: listed.slice(0, 100).map((g) => ({
            groupId: g.id,
            name: g.name,
            description: g.description,
            memberCount: this.members(g.id).filter((m) => m.status === 'active').length,
          })),
        });
        return;
      }
      case 'group_list': {
        if (!this.discoverReplies || !this.deps.contacts.isTrusted(from)) return;
        const adminName = this.deps.contacts.get(from)?.displayName ?? '';
        for (const g of msg.groups) {
          if (!this.discoverReplies.has(g.groupId)) {
            this.discoverReplies.set(g.groupId, { ...g, adminDeviceId: from, adminName });
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private apply(from: string, ev: GroupEvent): void {
    switch (ev.k) {
      case 'state':
        this.applySnapshot(from, ev.snapshot);
        return;
      case 'accept': {
        if (!this.isOwner(ev.groupId)) return;
        const m = this.member(ev.groupId, from);
        if (m?.status !== 'invited') return;
        this.mutate(ev.groupId, () => {
          this.deps.db
            .update(groupMembers)
            .set({ status: 'active' })
            .where(and(eq(groupMembers.groupId, ev.groupId), eq(groupMembers.deviceId, from)))
            .run();
        });
        return;
      }
      case 'decline':
      case 'leave': {
        if (!this.isOwner(ev.groupId) || !this.member(ev.groupId, from)) return;
        this.mutate(ev.groupId, () => this.deleteMember(ev.groupId, from), [from]);
        return;
      }
      case 'join_req': {
        const g = this.group(ev.groupId);
        const role = this.member(ev.groupId, this.me)?.role;
        if (
          !g ||
          g.myStatus !== 'active' ||
          !g.discoverable ||
          role === 'member' ||
          role === undefined
        )
          return;
        if (!this.deps.contacts.isTrusted(from) || this.member(ev.groupId, from)) return;
        this.deps.db
          .insert(groupJoinRequests)
          .values({ groupId: ev.groupId, deviceId: from, note: ev.note, createdAt: this.now() })
          .onConflictDoUpdate({
            target: [groupJoinRequests.groupId, groupJoinRequests.deviceId],
            set: { note: ev.note, createdAt: this.now() },
          })
          .run();
        this.changed();
        if (this.deps.settings.get('notificationsEnabled')) {
          const name = this.deps.contacts.get(from)?.displayName ?? 'Someone';
          this.deps.notify(g.name, `${name} asked to join.`);
        }
        return;
      }
    }
  }

  private applySnapshot(from: string, snap: GroupSnapshot): void {
    const current = this.group(snap.groupId);
    const senderInSnap = snap.members.find((m) => m.id === from);
    const meInSnap = snap.members.find((m) => m.id === this.me);
    let myStatus: GroupRow['myStatus'];
    let invitedBy = current?.invitedBy ?? null;

    if (current) {
      if (current.myStatus === 'left' || current.myStatus === 'deleted') return;
      const senderRole = this.member(snap.groupId, from)?.role;
      if (senderRole !== 'owner' && senderRole !== 'admin') return;
      if (snap.version <= current.version) return;
      if (snap.deleted) myStatus = 'deleted';
      else if (!meInSnap) myStatus = 'removed';
      else if (current.myStatus === 'invited' && meInSnap.status === 'active') myStatus = 'active';
      else
        myStatus =
          current.myStatus === 'removed'
            ? meInSnap.status === 'active'
              ? 'active'
              : 'invited'
            : current.myStatus;
    } else {
      // First contact with this group: only from a contact who is an admin in it.
      if (!this.deps.contacts.isTrusted(from)) return;
      if (senderInSnap?.role !== 'owner' && senderInSnap?.role !== 'admin') return;
      if (!meInSnap || snap.deleted) return;
      const pending = this.deps.db
        .select()
        .from(groupJoinPending)
        .where(eq(groupJoinPending.groupId, snap.groupId))
        .get();
      if (meInSnap.status === 'active' && pending) {
        myStatus = 'active';
        this.deps.db
          .delete(groupJoinPending)
          .where(eq(groupJoinPending.groupId, snap.groupId))
          .run();
      } else if (meInSnap.status === 'invited') {
        myStatus = 'invited';
        invitedBy = from;
      } else {
        return;
      }
    }

    const before = current ? this.members(snap.groupId) : [];
    const now = this.now();
    this.deps.db
      .insert(groups)
      .values({
        id: snap.groupId,
        name: snap.name,
        description: snap.description,
        policy: snap.policy,
        discoverable: snap.discoverable,
        version: snap.version,
        myStatus,
        invitedBy,
        createdAt: snap.createdAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: groups.id,
        set: {
          name: snap.name,
          description: snap.description,
          policy: snap.policy,
          discoverable: snap.discoverable,
          version: snap.version,
          myStatus,
          invitedBy,
          updatedAt: now,
        },
      })
      .run();
    this.deps.db.delete(groupMembers).where(eq(groupMembers.groupId, snap.groupId)).run();
    if (myStatus === 'active' || myStatus === 'invited') {
      for (const m of snap.members) {
        this.deps.db
          .insert(groupMembers)
          .values({
            groupId: snap.groupId,
            deviceId: m.id,
            displayName: m.name,
            role: m.role,
            status: m.status,
            host: m.host,
            port: m.port,
          })
          .run();
      }
    }
    if (myStatus === 'active')
      this.deps.chat.ensureConversation(groupConversationId(snap.groupId), 'group', null);

    // Visible history of membership changes.
    if (current && myStatus === 'active') {
      const actor = senderInSnap?.name ?? 'An admin';
      for (const m of snap.members) {
        if (!before.some((b) => b.deviceId === m.id) && m.id !== this.me) {
          this.deps.chat.addSystemMessage(
            groupConversationId(snap.groupId),
            `${actor} added ${m.name}`,
          );
        }
      }
      for (const b of before) {
        if (!snap.members.some((m) => m.id === b.deviceId)) {
          this.deps.chat.addSystemMessage(
            groupConversationId(snap.groupId),
            `${b.displayName} is no longer in the group`,
          );
        }
      }
      if (current.name !== snap.name) {
        this.deps.chat.addSystemMessage(
          groupConversationId(snap.groupId),
          `${actor} renamed the group to “${snap.name}”`,
        );
      }
    }
    if (
      current &&
      myStatus !== current.myStatus &&
      (myStatus === 'removed' || myStatus === 'deleted')
    ) {
      this.deps.chat.addSystemMessage(
        groupConversationId(snap.groupId),
        myStatus === 'removed'
          ? 'You were removed from this group'
          : 'The owner deleted this group',
      );
    }
    if (!current && myStatus === 'invited' && this.deps.settings.get('notificationsEnabled')) {
      this.deps.notify(
        'Group invitation',
        `${senderInSnap?.name ?? 'A contact'} invited you to “${snap.name}”.`,
      );
    }
    this.changed();
    this.linkMembers();
  }

  // ---------------------------------------------------------------- helpers

  /** Applies a local change, bumps the version and sends the new snapshot to everyone. */
  private mutate(
    groupId: string,
    change: () => void,
    alsoNotify: string[] = [],
    deleted = false,
  ): void {
    this.deps.sqlite.transaction(() => {
      change();
      this.deps.db
        .update(groups)
        .set({ version: this.requireGroup(groupId).version + 1, updatedAt: this.now() })
        .where(eq(groups.id, groupId))
        .run();
    })();
    this.broadcast(groupId, alsoNotify, deleted);
    this.changed();
    this.linkMembers();
  }

  private broadcast(groupId: string, extra: string[] = [], deleted = false): void {
    const snapshot = this.snapshot(groupId, deleted);
    const targets = new Set([...snapshot.members.map((m) => m.id), ...extra]);
    targets.delete(this.me);
    for (const target of targets) {
      this.deps.chat.enqueueWire(target, null, (eid) => ({
        t: 'group_ev',
        eid,
        ev: { k: 'state', snapshot },
      }));
    }
  }

  private sendEvent(target: string, groupId: string | null, ev: GroupEvent): void {
    this.deps.chat.enqueueWire(target, groupId ? groupConversationId(groupId) : null, (eid) => ({
      t: 'group_ev',
      eid,
      ev,
    }));
  }

  private snapshot(groupId: string, deleted: boolean): GroupSnapshot {
    const g = this.requireGroup(groupId);
    return {
      groupId,
      version: g.version,
      name: g.name,
      description: g.description,
      policy: g.policy,
      discoverable: g.discoverable,
      deleted,
      members: this.members(groupId).map((m) => {
        const hint =
          m.deviceId === this.me
            ? null
            : (this.liveAddress(m.deviceId) ??
              (m.host && m.port ? { host: m.host, port: m.port } : null));
        return {
          id: m.deviceId,
          name:
            m.deviceId === this.me
              ? (this.deps.identity.getAccount()?.displayName ?? m.displayName)
              : m.displayName,
          role: m.role,
          status: m.status,
          host: hint?.host ?? null,
          port: hint?.port ?? null,
        };
      }),
      createdAt: g.createdAt,
    };
  }

  private liveAddress(deviceId: string): { host: string; port: number } | null {
    const conn = this.deps.peers.get(deviceId);
    return conn?.remoteListenPort
      ? { host: conn.remoteAddress, port: conn.remoteListenPort }
      : null;
  }

  private addressHint(deviceId: string): { host: string; port: number } | null {
    const rows = this.deps.db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.deviceId, deviceId))
      .all();
    const withAddress = rows.find((r) => r.host && r.port);
    return withAddress?.host && withAddress.port
      ? { host: withAddress.host, port: withAddress.port }
      : null;
  }

  private coMembers(): string[] {
    const active = this.deps.db
      .select()
      .from(groups)
      .where(inArray(groups.myStatus, ['active', 'invited']))
      .all()
      .map((g) => g.id);
    if (active.length === 0) return [];
    const ids = this.deps.db
      .select()
      .from(groupMembers)
      .where(inArray(groupMembers.groupId, active))
      .all();
    return [...new Set(ids.map((m) => m.deviceId))].filter((id) => id !== this.me);
  }

  private insertInvitee(groupId: string, deviceId: string): void {
    const contact = this.deps.contacts.get(deviceId);
    this.deps.db
      .insert(groupMembers)
      .values({
        groupId,
        deviceId,
        displayName: contact?.displayName ?? `Device ${deviceId.slice(0, 7)}`,
        role: 'member',
        status: 'invited',
      })
      .run();
  }

  private deleteMember(groupId: string, deviceId: string): void {
    this.deps.db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.deviceId, deviceId)))
      .run();
  }

  private isOwner(groupId: string): boolean {
    const g = this.group(groupId);
    return g?.myStatus === 'active' && this.member(groupId, this.me)?.role === 'owner';
  }

  private requireAdmin(groupId: string): void {
    const d = this.details(groupId);
    if (!d.canEdit) throw new GroupError('Only group admins can do that.');
  }

  private group(id: string): GroupRow | undefined {
    return this.deps.db.select().from(groups).where(eq(groups.id, id)).get();
  }

  private requireGroup(id: string): GroupRow {
    const g = this.group(id);
    if (!g) throw new GroupError('Group not found.');
    return g;
  }

  private groupForConversation(conversationId: string): GroupRow | undefined {
    return conversationId.startsWith('g:') ? this.group(conversationId.slice(2)) : undefined;
  }

  private members(groupId: string): MemberRow[] {
    return this.deps.db.select().from(groupMembers).where(eq(groupMembers.groupId, groupId)).all();
  }

  private member(groupId: string, deviceId: string): MemberRow | undefined {
    return this.deps.db
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.deviceId, deviceId)))
      .get();
  }

  private changed(): void {
    this.deps.emit({ type: 'groups-changed' });
    this.deps.emit({ type: 'conversations-changed' });
  }

  /** After membership changes, open links to members we can't reach yet. */
  private linkMembers(): void {
    this.deps.contacts.reconnectAll();
  }
}
