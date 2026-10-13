import { vi } from 'vitest';
import type { AppEvent } from '../../src/shared/events';
import { openDatabase, type DatabaseHandle } from '../../src/main/db/connection';
import {
  DiscoveryService,
  type Announcement,
  type MdnsDriver,
} from '../../src/main/discovery/discovery-service';
import { IdentityService } from '../../src/main/identity/identity-service';
import { PeerService } from '../../src/main/peer/peer-service';
import { plaintextSecretStore } from '../../src/main/secrets/secret-store';
import { ContactsService } from '../../src/main/services/contacts-service';
import { ChatService } from '../../src/main/chat/chat-service';
import { TransferService } from '../../src/main/files/transfer-service';
import { CallService } from '../../src/main/calls/call-service';
import { GroupService } from '../../src/main/groups/group-service';
import { SkillsService } from '../../src/main/skills/skills-service';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsService } from '../../src/main/services/settings-service';
import { silentLogger } from './helpers';

/** In-process stand-in for a multicast segment. */
export class FakeLan {
  private readonly members = new Set<{
    announcement: Announcement | null;
    onUp: (a: Announcement) => void;
    onDown: (a: Announcement) => void;
  }>();

  driver(): MdnsDriver {
    const member = {
      announcement: null as Announcement | null,
      onUp: (_a: Announcement) => {},
      onDown: (_a: Announcement) => {},
    };
    this.members.add(member);
    return {
      publish: ({ name, port, txt }) => {
        member.announcement = { name, host: 'localhost', addresses: ['127.0.0.1'], port, txt };
        for (const m of this.members) if (m !== member) m.onUp(member.announcement);
      },
      browse: (onUp, onDown) => {
        member.onUp = onUp;
        member.onDown = onDown;
        for (const m of this.members) if (m !== member && m.announcement) onUp(m.announcement);
      },
      refresh: () => {},
      stop: async () => {
        this.members.delete(member);
        if (member.announcement) for (const m of this.members) m.onDown(member.announcement);
      },
    };
  }

  /** Injects a raw announcement, e.g. a spoofed one. */
  announce(a: Announcement): void {
    for (const m of this.members) m.onUp(a);
  }
}

export interface TestNode {
  name: string;
  database: DatabaseHandle;
  identity: IdentityService;
  peers: PeerService;
  discovery: DiscoveryService;
  contacts: ContactsService;
  settings: SettingsService;
  chat: ChatService;
  transfers: TransferService;
  calls: CallService;
  groups: GroupService;
  skills: SkillsService;
  filesDir: string;
  focused: { value: boolean };
  events: AppEvent[];
  notify: ReturnType<typeof vi.fn>;
  port: number;
  stop(): Promise<void>;
}

export async function createNode(
  name: string,
  lan: FakeLan,
  opts: {
    idleTimeoutMs?: number;
    dbPath?: string;
    port?: number;
    filesDir?: string;
    freeSpace?: () => Promise<number | null>;
    ringTimeoutMs?: number;
  } = {},
): Promise<TestNode> {
  const logger = silentLogger();
  const database = openDatabase(opts.dbPath ?? ':memory:');
  const identity = new IdentityService(database.db, plaintextSecretStore(), logger);
  const credentials = await identity.loadOrCreate();
  if (!identity.getAccount())
    identity.saveAccount({ displayName: name, emailLabel: `${name.toLowerCase()}@example.test` });
  const settings = new SettingsService(database.db, logger);
  const events: AppEvent[] = [];
  const notify = vi.fn();
  let contacts: ContactsService | null = null;
  let groupService: GroupService | null = null;
  const peers = new PeerService({
    credentials,
    logger,
    access: (id) => {
      const c = contacts?.access(id) ?? 'untrusted';
      if (c !== 'untrusted') return c;
      return groupService?.isMember(id) ? 'trusted' : 'untrusted';
    },
    preferredPort: opts.port ?? 0,
    bindHost: '127.0.0.1',
    connectTimeoutMs: 2000,
    handshakeTimeoutMs: 2000,
    ...(opts.idleTimeoutMs
      ? { connection: { pingIntervalMs: 50, idleTimeoutMs: opts.idleTimeoutMs } }
      : {}),
  });
  const discovery = new DiscoveryService(credentials.deviceId, () => lan.driver(), logger);
  contacts = new ContactsService({
    db: database.db,
    identity,
    peers,
    discovery,
    settings,
    logger,
    emit: (e) => events.push(e),
    notify,
  });
  const focused = { value: false };
  const chat = new ChatService({
    db: database.db,
    sqlite: database.sqlite,
    identity,
    contacts,
    peers,
    settings,
    logger,
    emit: (e) => events.push(e),
    notify,
    isWindowFocused: () => focused.value,
  });
  const ownsFilesDir = opts.filesDir === undefined;
  const filesDir = opts.filesDir ?? mkdtempSync(join(tmpdir(), `meshtalk-files-${name}-`));
  const transfers = new TransferService({
    db: database.db,
    sqlite: database.sqlite,
    peers,
    chat,
    logger,
    emit: (e) => events.push(e),
    filesDir,
    ...(opts.freeSpace ? { freeSpace: opts.freeSpace } : {}),
  });
  const calls = new CallService({
    db: database.db,
    peers,
    contacts,
    settings,
    logger,
    emit: (e) => events.push(e),
    notify,
    ...(opts.ringTimeoutMs ? { ringTimeoutMs: opts.ringTimeoutMs } : {}),
  });
  groupService = new GroupService({
    db: database.db,
    sqlite: database.sqlite,
    identity,
    contacts,
    peers,
    chat,
    settings,
    logger,
    emit: (e) => events.push(e),
    notify,
  });
  const groups = groupService;
  const skills = new SkillsService({
    db: database.db,
    sqlite: database.sqlite,
    contacts,
    peers,
    chat,
    settings,
    logger,
    emit: (e) => events.push(e),
    notify,
  });
  const port = await peers.start();
  const c = contacts;
  return {
    name,
    database,
    identity,
    peers,
    discovery,
    contacts: c,
    settings,
    chat,
    transfers,
    calls,
    groups,
    skills,
    filesDir,
    focused,
    events,
    notify,
    port,
    stop: async () => {
      calls.stop();
      transfers.stop();
      chat.stop();
      c.stop();
      await discovery.stop();
      await peers.stop();
      database.close();
      // Only remove folders the harness created itself.
      if (ownsFilesDir) rmSync(filesDir, { recursive: true, force: true });
    },
  };
}

export async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Creates two nodes and makes them accepted contacts of each other. */
export async function befriend(a: TestNode, b: TestNode): Promise<void> {
  await a.contacts.request('127.0.0.1', b.port, null, null);
  await until(() => b.contacts.get(a.identity.deviceId)?.state === 'incoming');
  await b.contacts.accept(a.identity.deviceId);
  await until(
    () =>
      a.contacts.get(b.identity.deviceId)?.state === 'accepted' &&
      a.peers.isConnected(b.identity.deviceId) &&
      b.peers.isConnected(a.identity.deviceId),
  );
}
