import { eq } from 'drizzle-orm';
import type { AppEvent } from '../../shared/events';
import type { Contact, ContactState, NearbyDevice } from '../../shared/peers';
import type { AppDatabase } from '../db/connection';
import { UserFacingError } from '../errors';
import { contacts } from '../db/schema';
import type { DiscoveryService } from '../discovery/discovery-service';
import { formatFingerprint } from '../identity/device-id';
import type { IdentityService } from '../identity/identity-service';
import type { Logger } from '../logger';
import type { PeerConnection } from '../peer/peer-connection';
import { PeerConnectError, type PeerAccess, type PeerService } from '../peer/peer-service';
import type { WireMessage } from '../peer/wire';
import type { SettingsService } from './settings-service';

type ContactRow = typeof contacts.$inferSelect;

/** Declined requests from the same device are ignored for this long. */
export const DECLINE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 60_000;

export class ContactError extends UserFacingError {
  override name = 'ContactError';
}

export interface ContactsServiceDeps {
  db: AppDatabase;
  identity: IdentityService;
  peers: PeerService;
  discovery: DiscoveryService;
  settings: SettingsService;
  logger: Logger;
  emit(event: AppEvent): void;
  notify(title: string, body: string): void;
  now?: () => number;
}

/**
 * Contact lifecycle over PeerLink. In LAN-only mode one contact is one device:
 * the device ID (certificate hash) is the identity that gets pinned.
 */
export class ContactsService {
  private readonly now: () => number;
  private readonly backoff = new Map<string, { delay: number; timer: NodeJS.Timeout | null }>();
  private stopped = false;

  constructor(private readonly deps: ContactsServiceDeps) {
    this.now = deps.now ?? Date.now;
    deps.peers.on('connected', (conn) => this.onConnected(conn));
    deps.peers.on('disconnected', (id) => this.onDisconnected(id));
    deps.peers.on('message', (id, msg, conn) => this.onMessage(id, msg, conn));
    deps.discovery.on('changed', () => {
      this.deps.emit({ type: 'nearby-changed' });
      for (const entry of deps.discovery.list()) {
        if (this.wantsLink(entry.deviceId)) this.scheduleReconnect(entry.deviceId, 0);
      }
    });
  }

  private extension: ReconnectExtension | null = null;

  /** Lets other features (groups) keep links to non-contact devices alive. */
  setReconnectExtension(extension: ReconnectExtension): void {
    this.extension = extension;
  }

  private wantsLink(deviceId: string): boolean {
    const state = this.row(deviceId)?.state;
    if (state === 'blocked') return false;
    return state === 'accepted' || (this.extension?.wants(deviceId) ?? false);
  }

  /** Access policy handed to PeerService. */
  access = (deviceId: string): PeerAccess => {
    const state = this.row(deviceId)?.state;
    if (state === 'blocked') return 'blocked';
    if (state === 'accepted') return 'trusted';
    return 'untrusted';
  };

  isTrusted(deviceId: string): boolean {
    return this.access(deviceId) === 'trusted';
  }

  list(): Contact[] {
    const rows = this.deps.db.select().from(contacts).all();
    const acceptedNames = new Map<string, number>();
    for (const r of rows) {
      if (r.state === 'accepted')
        acceptedNames.set(
          foldName(r.displayName),
          (acceptedNames.get(foldName(r.displayName)) ?? 0) + 1,
        );
    }
    return rows
      .map((r) => this.toContact(r, acceptedNames))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  get(deviceId: string): Contact | null {
    const r = this.row(deviceId);
    return r ? this.toContact(r, null) : null;
  }

  nearby(): NearbyDevice[] {
    return this.deps.discovery.list().map((n) => {
      const r = this.row(n.deviceId);
      return {
        deviceId: n.deviceId,
        fingerprint: formatFingerprint(n.deviceId),
        host: n.host,
        port: n.port,
        lastSeenAt: n.lastSeenAt,
        contactState: r?.state ?? null,
        displayName: r && r.state !== 'incoming' ? r.displayName : null,
      };
    });
  }

  /** Sends a contact request to a discovered device (identity pinned by its announcement). */
  async requestNearby(deviceId: string, note: string | null): Promise<Contact> {
    const entry = this.deps.discovery.get(deviceId);
    if (!entry) throw new ContactError('That device is no longer visible on the network.');
    return this.request(entry.host, entry.port, deviceId, note);
  }

  /**
   * Sends a contact request to `host:port`. With no expected ID this is trust
   * on first use: the UI must show the returned fingerprint for comparison.
   */
  async request(
    host: string,
    port: number,
    expectedDeviceId: string | null,
    note: string | null,
  ): Promise<Contact> {
    const account = this.requireAccount();
    let conn: PeerConnection;
    try {
      conn = await this.deps.peers.connect(host, port, expectedDeviceId);
    } catch (error) {
      if (error instanceof PeerConnectError) throw new ContactError(error.message);
      throw error;
    }
    const id = conn.remoteDeviceId;
    const existing = this.row(id);
    if (existing?.state === 'accepted') return this.toContact(existing, null);
    if (existing?.state === 'blocked')
      throw new ContactError('You blocked this device. Unblock it first.');
    if (existing?.state === 'incoming') return this.accept(id);

    const now = this.now();
    this.upsert({
      deviceId: id,
      displayName: existing?.displayName ?? `Device ${id.slice(0, 7)}`,
      emailLabel: existing?.emailLabel ?? null,
      state: 'outgoing',
      lastHost: host,
      lastPort: port,
      requestNote: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    conn.send({
      t: 'contact_request',
      displayName: account.displayName,
      emailLabel: account.emailLabel,
      note,
    });
    this.changed();
    return this.requireContact(id);
  }

  async accept(deviceId: string): Promise<Contact> {
    const r = this.row(deviceId);
    if (!r || r.state !== 'incoming')
      throw new ContactError('There is no pending request from this device.');
    this.update(deviceId, { state: 'accepted', requestNote: null });
    this.changed();
    const account = this.requireAccount();
    const message: WireMessage = {
      t: 'contact_accept',
      displayName: account.displayName,
      emailLabel: account.emailLabel,
    };
    if (!this.deps.peers.send(deviceId, message)) {
      // The requester disconnected; call back on the port it announced.
      if (r.lastHost && r.lastPort) {
        try {
          const conn = await this.deps.peers.connect(r.lastHost, r.lastPort, deviceId);
          conn.send(message);
        } catch (error) {
          this.deps.logger.info('contacts.accept_delivery_deferred', {
            reason: (error as Error).message,
          });
        }
      }
    }
    return this.requireContact(deviceId);
  }

  decline(deviceId: string): void {
    const r = this.row(deviceId);
    if (!r || r.state !== 'incoming')
      throw new ContactError('There is no pending request from this device.');
    this.update(deviceId, { state: 'declined', requestNote: null });
    this.deps.peers.send(deviceId, { t: 'contact_decline' });
    this.deps.peers.disconnect(deviceId, 'declined');
    this.changed();
  }

  block(deviceId: string): void {
    const r = this.row(deviceId);
    const now = this.now();
    if (r) this.update(deviceId, { state: 'blocked', requestNote: null });
    else
      this.upsert({
        deviceId,
        displayName: `Device ${deviceId.slice(0, 7)}`,
        emailLabel: null,
        state: 'blocked',
        lastHost: null,
        lastPort: null,
        requestNote: null,
        createdAt: now,
        updatedAt: now,
      });
    this.cancelReconnect(deviceId);
    this.deps.peers.disconnect(deviceId, 'blocked');
    this.changed();
  }

  unblock(deviceId: string): void {
    const r = this.row(deviceId);
    if (r?.state !== 'blocked') return;
    this.deps.db.delete(contacts).where(eq(contacts.deviceId, deviceId)).run();
    this.changed();
  }

  remove(deviceId: string): void {
    const r = this.row(deviceId);
    if (!r) return;
    if (r.state === 'accepted' || r.state === 'outgoing')
      this.deps.peers.send(deviceId, { t: 'contact_remove' });
    this.cancelReconnect(deviceId);
    this.deps.peers.disconnect(deviceId, 'removed');
    this.deps.db.delete(contacts).where(eq(contacts.deviceId, deviceId)).run();
    this.changed();
  }

  setVerified(deviceId: string, verified: boolean): Contact {
    const r = this.row(deviceId);
    if (!r || r.state !== 'accepted')
      throw new ContactError('Only accepted contacts can be verified.');
    this.update(deviceId, { verified });
    this.changed();
    return this.requireContact(deviceId);
  }

  /** Pushes the local profile to every connected contact (after an edit). */
  broadcastProfile(): void {
    const account = this.deps.identity.getAccount();
    if (!account) return;
    for (const id of this.deps.peers.connectedDeviceIds()) {
      if (this.isTrusted(id)) {
        this.deps.peers.send(id, {
          t: 'profile',
          displayName: account.displayName,
          emailLabel: account.emailLabel,
        });
      }
    }
  }

  /** Tries to reach every accepted contact once; failures back off. */
  reconnectAll(): void {
    const rows = this.deps.db.select().from(contacts).where(eq(contacts.state, 'accepted')).all();
    for (const r of rows) this.scheduleReconnect(r.deviceId, 0);
    for (const id of this.extension?.all() ?? []) {
      if (this.wantsLink(id)) this.scheduleReconnect(id, 0);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const id of [...this.backoff.keys()]) this.cancelReconnect(id);
  }

  private onConnected(conn: PeerConnection): void {
    const id = conn.remoteDeviceId;
    this.cancelReconnect(id);
    const r = this.row(id);
    if (!r) return;
    const fields: Partial<ContactRow> = { lastSeenAt: this.now() };
    if (conn.remoteListenPort) {
      fields.lastHost = conn.remoteAddress;
      fields.lastPort = conn.remoteListenPort;
    }
    this.update(id, fields);
    if (r.state === 'accepted') {
      const account = this.deps.identity.getAccount();
      if (account)
        conn.send({
          t: 'profile',
          displayName: account.displayName,
          emailLabel: account.emailLabel,
        });
      conn.send({ t: 'presence', share: this.deps.settings.get('shareOnlineStatus') });
    }
    this.changed();
  }

  /** Tells connected contacts whether they may show our online status. */
  broadcastPresence(): void {
    const share = this.deps.settings.get('shareOnlineStatus');
    for (const id of this.deps.peers.connectedDeviceIds()) {
      if (this.isTrusted(id)) this.deps.peers.send(id, { t: 'presence', share });
    }
  }

  private onDisconnected(id: string): void {
    if (this.wantsLink(id)) this.scheduleReconnect(id, RECONNECT_MIN_MS);
    const r = this.row(id);
    if (!r) return;
    this.update(id, { lastSeenAt: this.now() });
    this.changed();
  }

  private onMessage(id: string, msg: WireMessage, conn: PeerConnection): void {
    const r = this.row(id);
    switch (msg.t) {
      case 'contact_request': {
        if (r?.state === 'accepted') {
          // They lost us (e.g. reinstalled the contact list); re-confirm.
          const account = this.requireAccount();
          conn.send({
            t: 'contact_accept',
            displayName: account.displayName,
            emailLabel: account.emailLabel,
          });
          return;
        }
        if (r?.state === 'outgoing') {
          // Both sides asked: treat as mutual acceptance.
          this.update(id, {
            state: 'accepted',
            displayName: msg.displayName,
            emailLabel: msg.emailLabel,
          });
          const account = this.requireAccount();
          conn.send({
            t: 'contact_accept',
            displayName: account.displayName,
            emailLabel: account.emailLabel,
          });
          this.changed();
          return;
        }
        if (r?.state === 'declined' && this.now() - r.updatedAt < DECLINE_COOLDOWN_MS) return;
        const now = this.now();
        this.upsert({
          deviceId: id,
          displayName: msg.displayName,
          emailLabel: msg.emailLabel,
          state: 'incoming',
          lastHost: conn.remoteAddress,
          lastPort: conn.remoteListenPort,
          requestNote: msg.note,
          createdAt: r?.createdAt ?? now,
          updatedAt: now,
        });
        this.changed();
        if (this.deps.settings.get('notificationsEnabled')) {
          this.deps.notify('New contact request', `${msg.displayName} wants to connect with you.`);
        }
        return;
      }
      case 'contact_accept': {
        if (r?.state !== 'outgoing' && r?.state !== 'accepted') return;
        this.update(id, {
          state: 'accepted',
          displayName: msg.displayName,
          emailLabel: msg.emailLabel,
        });
        this.changed();
        return;
      }
      case 'contact_decline': {
        if (r?.state === 'outgoing') {
          this.update(id, { state: 'declined' });
          this.changed();
        }
        return;
      }
      case 'contact_remove': {
        if (r && r.state !== 'blocked') {
          this.cancelReconnect(id);
          this.deps.db.delete(contacts).where(eq(contacts.deviceId, id)).run();
          this.changed();
        }
        return;
      }
      case 'presence': {
        if (r?.state === 'accepted' && r.sharesPresence !== msg.share) {
          this.update(id, { sharesPresence: msg.share });
          this.changed();
        }
        return;
      }
      case 'profile': {
        if (r?.state === 'accepted') {
          this.update(id, { displayName: msg.displayName, emailLabel: msg.emailLabel });
          this.changed();
        }
        return;
      }
      default:
        return;
    }
  }

  private scheduleReconnect(id: string, delay: number): void {
    if (this.stopped || this.deps.peers.isConnected(id)) return;
    const current = this.backoff.get(id);
    if (current?.timer) return;
    const state = current ?? { delay: RECONNECT_MIN_MS, timer: null };
    const jitter = delay === 0 ? 0 : Math.random() * 0.3 * delay;
    state.timer = setTimeout(() => void this.attemptReconnect(id), delay + jitter);
    state.timer.unref();
    this.backoff.set(id, state);
  }

  private async attemptReconnect(id: string): Promise<void> {
    const state = this.backoff.get(id);
    if (state) state.timer = null;
    if (this.stopped) return;
    if (!this.wantsLink(id) || this.deps.peers.isConnected(id)) return;
    const r = this.row(id);
    const nearby = this.deps.discovery.get(id);
    const target = nearby
      ? { host: nearby.host, port: nearby.port }
      : r?.lastHost && r.lastPort
        ? { host: r.lastHost, port: r.lastPort }
        : (this.extension?.target(id) ?? null);
    if (!target) return;
    try {
      await this.deps.peers.connect(target.host, target.port, id);
      this.backoff.delete(id);
    } catch {
      if (this.stopped) return;
      const next = Math.min((state?.delay ?? RECONNECT_MIN_MS) * 2, RECONNECT_MAX_MS);
      this.backoff.set(id, { delay: next, timer: null });
      this.scheduleReconnect(id, next);
    }
  }

  private cancelReconnect(id: string): void {
    const state = this.backoff.get(id);
    if (state?.timer) clearTimeout(state.timer);
    this.backoff.delete(id);
  }

  private toContact(r: ContactRow, acceptedNames: Map<string, number> | null): Contact {
    const online = this.deps.peers.isConnected(r.deviceId);
    const sameName = acceptedNames?.get(foldName(r.displayName)) ?? 0;
    return {
      deviceId: r.deviceId,
      fingerprint: formatFingerprint(r.deviceId),
      displayName: r.displayName,
      emailLabel: r.emailLabel,
      state: r.state,
      verified: r.verified,
      online: r.state === 'accepted' && online && r.sharesPresence,
      lastSeenAt: r.state === 'accepted' && r.sharesPresence ? r.lastSeenAt : null,
      requestNote: r.requestNote,
      nameCollision: r.state === 'accepted' ? sameName > 1 : sameName > 0,
      createdAt: r.createdAt,
    };
  }

  private row(deviceId: string): ContactRow | undefined {
    return this.deps.db.select().from(contacts).where(eq(contacts.deviceId, deviceId)).get();
  }

  private requireContact(deviceId: string): Contact {
    const c = this.get(deviceId);
    if (!c) throw new ContactError('Contact not found.');
    return c;
  }

  private requireAccount() {
    const account = this.deps.identity.getAccount();
    if (!account) throw new ContactError('Create your profile first.');
    return account;
  }

  private upsert(values: Omit<ContactRow, 'verified' | 'lastSeenAt' | 'sharesPresence'>): void {
    this.deps.db
      .insert(contacts)
      .values({ ...values, verified: false })
      .onConflictDoUpdate({ target: contacts.deviceId, set: values })
      .run();
  }

  private update(deviceId: string, fields: Partial<ContactRow>): void {
    const before = fields.state === 'accepted' ? this.row(deviceId)?.state : undefined;
    this.deps.db
      .update(contacts)
      .set({ ...fields, updatedAt: this.now() })
      .where(eq(contacts.deviceId, deviceId))
      .run();
    if (fields.state === 'accepted' && before !== 'accepted') {
      // After the current handler, so protocol replies (contact_accept) go out first.
      for (const listener of this.acceptedListeners) {
        queueMicrotask(() => {
          if (!this.stopped) listener(deviceId);
        });
      }
    }
  }

  private readonly acceptedListeners = new Set<(deviceId: string) => void>();

  /** Called whenever a device becomes an accepted contact. */
  onAccepted(listener: (deviceId: string) => void): void {
    this.acceptedListeners.add(listener);
  }

  private changed(): void {
    this.deps.emit({ type: 'contacts-changed' });
  }
}

function foldName(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase();
}

export type { ContactState };

/** Non-contact devices another feature needs links to (e.g. fellow group members). */
export interface ReconnectExtension {
  wants(deviceId: string): boolean;
  target(deviceId: string): { host: string; port: number } | null;
  all(): string[];
}
