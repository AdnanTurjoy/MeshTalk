import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { directConversationId } from '../../shared/chat';
import type { CallEndReason, CallKind, CallRecord, CallSignal } from '../../shared/calls';
import type { AppEvent } from '../../shared/events';
import type { AppDatabase } from '../db/connection';
import { calls, contacts } from '../db/schema';
import { UserFacingError } from '../errors';
import type { Logger } from '../logger';
import type { PeerService } from '../peer/peer-service';
import type { WireMessage } from '../peer/wire';
import type { ContactsService } from '../services/contacts-service';
import type { SettingsService } from '../services/settings-service';

export const RING_TIMEOUT_MS = 45_000;

export class CallError extends UserFacingError {
  override name = 'CallError';
}

interface ActiveCall {
  id: string;
  peer: string;
  kind: CallKind;
  direction: 'incoming' | 'outgoing';
  invited: boolean;
  answered: boolean;
}

export interface CallServiceDeps {
  db: AppDatabase;
  peers: PeerService;
  contacts: ContactsService;
  settings: SettingsService;
  logger: Logger;
  emit(event: AppEvent): void;
  notify(title: string, body: string): void;
  now?: () => number;
  ringTimeoutMs?: number;
}

/**
 * One-to-one call signaling and history. WebRTC itself runs in the renderer;
 * this service relays SDP/ICE over the authenticated PeerLink, enforces that
 * only contacts can call, handles busy/timeout, and records history.
 * Media is encrypted end to end by WebRTC (DTLS-SRTP) and never passes main.
 */
export class CallService {
  private readonly now: () => number;
  private active: ActiveCall | null = null;
  private ringTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CallServiceDeps) {
    this.now = deps.now ?? Date.now;
    deps.peers.on('message', (from, msg) => this.onMessage(from, msg));
    deps.peers.on('disconnected', (id) => {
      // Without signaling a call that hasn't connected yet cannot proceed.
      if (this.active?.peer === id && !this.active.answered) this.finish('unavailable', true);
    });
  }

  /** Reserves a call to the contact in a direct conversation; the renderer then sends the offer. */
  start(conversationId: string, kind: CallKind): { callId: string; peerDeviceId: string } {
    if (!conversationId.startsWith('d:')) throw new CallError('Group calls are not available yet.');
    const peer = conversationId.slice(2);
    if (!this.deps.contacts.isTrusted(peer))
      throw new CallError('You can only call your contacts.');
    if (this.active) throw new CallError('You are already in a call.');
    if (!this.deps.peers.isConnected(peer)) {
      throw new CallError('This contact is offline or not reachable on this network right now.');
    }
    const id = randomUUID();
    this.active = { id, peer, kind, direction: 'outgoing', invited: false, answered: false };
    this.record(id, peer, kind, 'outgoing');
    this.armRingTimer(id);
    return { callId: id, peerDeviceId: peer };
  }

  /** Forwards an offer/answer/ICE candidate from the renderer to the other side. */
  signal(callId: string, signal: CallSignal): void {
    const call = this.requireActive(callId);
    if (signal.type === 'offer' && call.direction === 'outgoing' && !call.invited) {
      call.invited = true;
      if (
        !this.deps.peers.send(call.peer, {
          t: 'call_invite',
          callId,
          kind: call.kind,
          sdp: signal.sdp,
        })
      ) {
        this.finish('unavailable', false);
        throw new CallError('Could not reach this contact.');
      }
      return;
    }
    if (signal.type === 'answer' && call.direction === 'incoming' && !call.answered) {
      call.answered = true;
      this.clearRingTimer();
      this.deps.db.update(calls).set({ answeredAt: this.now() }).where(eq(calls.id, callId)).run();
      this.deps.emit({ type: 'calls-changed' });
    }
    this.deps.peers.send(call.peer, { t: 'call_signal', callId, signal });
  }

  markConnected(callId: string, relayed: boolean): void {
    if (this.active?.id !== callId) return;
    this.deps.db.update(calls).set({ relayed }).where(eq(calls.id, callId)).run();
  }

  /** Ends, declines or cancels the active call. */
  end(callId: string, reason: CallEndReason): void {
    if (this.active?.id !== callId) return;
    this.finish(reason, true);
  }

  history(limit = 100): CallRecord[] {
    const rows = this.deps.db
      .select()
      .from(calls)
      .orderBy(desc(calls.createdAt))
      .limit(limit)
      .all();
    const names = new Map<string, string>();
    for (const r of rows) {
      if (names.has(r.peerDeviceId)) continue;
      const c = this.deps.db
        .select({ name: contacts.displayName })
        .from(contacts)
        .where(eq(contacts.deviceId, r.peerDeviceId))
        .get();
      names.set(r.peerDeviceId, c?.name ?? `Device ${r.peerDeviceId.slice(0, 7)}`);
    }
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      peerDeviceId: r.peerDeviceId,
      peerName: names.get(r.peerDeviceId) ?? '',
      kind: r.kind,
      direction: r.direction,
      createdAt: r.createdAt,
      answeredAt: r.answeredAt,
      endedAt: r.endedAt,
      endReason: (r.endReason as CallEndReason | null) ?? null,
      relayed: r.relayed,
    }));
  }

  missedCount(): number {
    return this.deps.db.select().from(calls).where(eq(calls.seen, false)).all().length;
  }

  markSeen(): void {
    this.deps.db.update(calls).set({ seen: true }).where(eq(calls.seen, false)).run();
    this.deps.emit({ type: 'calls-changed' });
  }

  stop(): void {
    if (this.active) this.finish('hangup', true);
  }

  private onMessage(from: string, msg: WireMessage): void {
    switch (msg.t) {
      case 'call_invite': {
        if (!this.deps.contacts.isTrusted(from)) return;
        if (this.active) {
          // Already in a call: tell the caller, and keep a record of the attempt.
          this.deps.peers.send(from, { t: 'call_end', callId: msg.callId, reason: 'busy' });
          this.record(msg.callId, from, msg.kind, 'incoming', 'busy');
          return;
        }
        this.active = {
          id: msg.callId,
          peer: from,
          kind: msg.kind,
          direction: 'incoming',
          invited: true,
          answered: false,
        };
        this.record(msg.callId, from, msg.kind, 'incoming');
        this.armRingTimer(msg.callId);
        const name = this.deps.contacts.get(from)?.displayName ?? 'Someone';
        this.deps.emit({
          type: 'call-incoming',
          call: {
            callId: msg.callId,
            peerDeviceId: from,
            peerName: name,
            kind: msg.kind,
            conversationId: directConversationId(from),
            offerSdp: msg.sdp,
          },
        });
        if (this.deps.settings.get('notificationsEnabled')) {
          this.deps.notify(name, msg.kind === 'video' ? 'Incoming video call' : 'Incoming call');
        }
        return;
      }
      case 'call_signal': {
        const call = this.active;
        if (!call || call.id !== msg.callId || call.peer !== from) return;
        if (msg.signal.type === 'answer' && call.direction === 'outgoing' && !call.answered) {
          call.answered = true;
          this.clearRingTimer();
          this.deps.db
            .update(calls)
            .set({ answeredAt: this.now() })
            .where(eq(calls.id, call.id))
            .run();
          this.deps.emit({ type: 'calls-changed' });
        }
        this.deps.emit({ type: 'call-signal', callId: call.id, signal: msg.signal });
        return;
      }
      case 'call_end': {
        if (this.active?.id === msg.callId && this.active.peer === from)
          this.finish(msg.reason, false);
        return;
      }
      default:
        return;
    }
  }

  private finish(reason: CallEndReason, tellPeer: boolean): void {
    const call = this.active;
    if (!call) return;
    this.active = null;
    this.clearRingTimer();
    if (tellPeer) this.deps.peers.send(call.peer, { t: 'call_end', callId: call.id, reason });
    const missed = call.direction === 'incoming' && !call.answered && reason !== 'declined';
    this.deps.db
      .update(calls)
      .set({ endedAt: this.now(), endReason: reason, seen: !missed })
      .where(eq(calls.id, call.id))
      .run();
    this.deps.emit({ type: 'call-ended', callId: call.id, reason });
    this.deps.emit({ type: 'calls-changed' });
    if (missed && this.deps.settings.get('notificationsEnabled')) {
      const name = this.deps.contacts.get(call.peer)?.displayName ?? 'Someone';
      this.deps.notify('Missed call', `${name} called you.`);
    }
  }

  private record(
    id: string,
    peer: string,
    kind: CallKind,
    direction: 'incoming' | 'outgoing',
    endReason?: CallEndReason,
  ): void {
    const now = this.now();
    this.deps.db
      .insert(calls)
      .values({
        id,
        conversationId: directConversationId(peer),
        peerDeviceId: peer,
        kind,
        direction,
        createdAt: now,
        ...(endReason ? { endedAt: now, endReason, seen: false } : {}),
      })
      .onConflictDoNothing()
      .run();
    this.deps.emit({ type: 'calls-changed' });
  }

  private armRingTimer(callId: string): void {
    this.clearRingTimer();
    this.ringTimer = setTimeout(() => {
      if (this.active?.id === callId && !this.active.answered) this.finish('no_answer', true);
    }, this.deps.ringTimeoutMs ?? RING_TIMEOUT_MS);
    this.ringTimer.unref();
  }

  private clearRingTimer(): void {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = null;
  }

  private requireActive(callId: string): ActiveCall {
    if (this.active?.id !== callId) throw new CallError('This call has ended.');
    return this.active;
  }
}
