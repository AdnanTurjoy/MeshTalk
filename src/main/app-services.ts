import type { AppEvent } from '../shared/events';
import type { NetworkStatus } from '../shared/peers';
import type { SettingKey } from '../shared/settings';
import type { DatabaseHandle } from './db/connection';
import { bonjourDriver } from './discovery/bonjour-driver';
import { DiscoveryService, type MdnsDriver } from './discovery/discovery-service';
import { IdentityService } from './identity/identity-service';
import type { Logger } from './logger';
import { DEFAULT_PEER_PORT, localAddresses, PeerService } from './peer/peer-service';
import { NetworkWatcher } from './platform/network-watcher';
import type { SecretStore } from './secrets/secret-store';
import { CallService } from './calls/call-service';
import { ChatService } from './chat/chat-service';
import { TransferService } from './files/transfer-service';
import { GroupService } from './groups/group-service';
import { SkillsService } from './skills/skills-service';
import { AppLock } from './data/app-lock';
import { BackupService } from './data/backup-service';
import type { AppPaths } from './platform/paths';
import { ContactsService } from './services/contacts-service';
import { SettingsService } from './services/settings-service';

export interface AppServicesOptions {
  database: DatabaseHandle;
  secrets: SecretStore;
  logger: Logger;
  emit(event: AppEvent): void;
  notify(title: string, body: string): void;
  isWindowFocused(): boolean;
  paths: AppPaths;
  appVersion: string;
  peerPort?: number;
  mdnsDriver?: () => MdnsDriver;
}

/** Composition root: builds and wires every main-process service. */
export class AppServices {
  readonly settings: SettingsService;
  readonly identity: IdentityService;
  peers!: PeerService;
  discovery!: DiscoveryService;
  contacts!: ContactsService;
  chat!: ChatService;
  transfers!: TransferService;
  calls!: CallService;
  groups!: GroupService;
  skills!: SkillsService;
  readonly lock: AppLock;
  backups!: BackupService;
  private readonly network = new NetworkWatcher();
  private listenerError: string | null = null;

  private constructor(private readonly options: AppServicesOptions) {
    this.settings = new SettingsService(options.database.db, options.logger);
    this.identity = new IdentityService(options.database.db, options.secrets, options.logger);
    this.lock = new AppLock(options.database.db);
  }

  static async create(options: AppServicesOptions): Promise<AppServices> {
    const services = new AppServices(options);
    await services.init();
    return services;
  }

  private async init(): Promise<void> {
    const { logger, emit } = this.options;
    const credentials = await this.identity.loadOrCreate();
    this.peers = new PeerService({
      credentials,
      logger,
      // Contacts, and members of a group we share, may talk to us; blocked always wins.
      access: (id) => {
        const contact = this.contacts.access(id);
        if (contact !== 'untrusted') return contact;
        return this.groups.isMember(id) ? 'trusted' : 'untrusted';
      },
      preferredPort: this.options.peerPort ?? DEFAULT_PEER_PORT,
    });
    this.discovery = new DiscoveryService(
      credentials.deviceId,
      this.options.mdnsDriver ?? bonjourDriver,
      logger,
    );
    this.contacts = new ContactsService({
      db: this.options.database.db,
      identity: this.identity,
      peers: this.peers,
      discovery: this.discovery,
      settings: this.settings,
      logger,
      emit,
      notify: this.options.notify,
    });
    this.chat = new ChatService({
      db: this.options.database.db,
      sqlite: this.options.database.sqlite,
      identity: this.identity,
      contacts: this.contacts,
      peers: this.peers,
      settings: this.settings,
      logger,
      emit,
      notify: this.options.notify,
      isWindowFocused: this.options.isWindowFocused,
    });
    this.transfers = new TransferService({
      db: this.options.database.db,
      sqlite: this.options.database.sqlite,
      peers: this.peers,
      chat: this.chat,
      logger,
      emit,
      filesDir: this.options.paths.files,
      quotaBytes: () => {
        const gb = this.settings.get('storageQuotaGb');
        return gb > 0 ? gb * 1024 ** 3 : null;
      },
    });
    this.calls = new CallService({
      db: this.options.database.db,
      peers: this.peers,
      contacts: this.contacts,
      settings: this.settings,
      logger,
      emit,
      notify: this.options.notify,
    });
    this.groups = new GroupService({
      db: this.options.database.db,
      sqlite: this.options.database.sqlite,
      identity: this.identity,
      contacts: this.contacts,
      peers: this.peers,
      chat: this.chat,
      settings: this.settings,
      logger,
      emit,
      notify: this.options.notify,
    });
    this.skills = new SkillsService({
      db: this.options.database.db,
      sqlite: this.options.database.sqlite,
      contacts: this.contacts,
      peers: this.peers,
      chat: this.chat,
      settings: this.settings,
      logger,
      emit,
      notify: this.options.notify,
    });
    this.backups = new BackupService({
      database: this.options.database,
      paths: this.options.paths,
      secrets: this.options.secrets,
      logger,
      appVersion: this.options.appVersion,
      credentials: () => credentials,
    });
    // Online state shows in the conversation list too.
    this.peers.on('connected', () => emit({ type: 'conversations-changed' }));
    this.peers.on('disconnected', () => emit({ type: 'conversations-changed' }));
    this.peers.on('connected', () => emit({ type: 'network-changed' }));
    this.peers.on('disconnected', () => emit({ type: 'network-changed' }));
    this.discovery.on('changed', () => emit({ type: 'network-changed' }));

    try {
      await this.peers.start();
    } catch (error) {
      this.listenerError =
        'MeshTalk could not open a network port. Other devices will not be able to connect to this one.';
      logger.error('peer.listen_failed', { error });
    }
    this.syncDiscovery();
    this.contacts.reconnectAll();

    this.network.on('changed', () => {
      logger.info('network.changed');
      void this.restartDiscovery();
      this.contacts.reconnectAll();
      emit({ type: 'network-changed' });
    });
    this.network.start();
  }

  /** Discovery runs only with an account and explicit consent. */
  syncDiscovery(): void {
    const wanted = this.settings.get('discoveryEnabled') && this.identity.getAccount() !== null;
    const port = this.peers.listenPort;
    if (wanted && port && this.discovery.state === 'off') this.discovery.start(port);
    if (!wanted && this.discovery.state !== 'off') void this.discovery.stop();
  }

  onSettingChanged(key: SettingKey): void {
    if (key === 'discoveryEnabled') this.syncDiscovery();
    if (key === 'shareOnlineStatus') this.contacts.broadcastPresence();
  }

  onAccountChanged(): void {
    this.syncDiscovery();
    this.contacts.broadcastProfile();
  }

  /** After sleep or a network change, multicast sockets must be re-bound. */
  async restartDiscovery(): Promise<void> {
    if (this.discovery.state === 'off') return;
    await this.discovery.stop();
    this.syncDiscovery();
  }

  networkStatus(): NetworkStatus {
    const port = this.peers.listenPort;
    return {
      listener: port ? { port, addresses: localAddresses() } : null,
      listenerError: this.listenerError,
      discovery: this.discovery.state,
      discoveryError: this.discovery.error,
      connectedPeers: this.peers.connectedDeviceIds().length,
    };
  }

  /** A readable snapshot of the user's data for "Export my data". */
  collectExport(): Record<string, unknown> {
    const conversations = [
      ...this.chat.listConversations(false),
      ...this.chat.listConversations(true),
    ];
    return {
      profile: { account: this.identity.getAccount(), device: this.identity.info() },
      contacts: this.contacts.list(),
      conversations: conversations.map((c) => {
        const messages = [];
        let before: { sentAt: number; id: string } | null = null;
        for (;;) {
          const page = this.chat.listMessages(c.id, before, 200);
          messages.unshift(...page.messages);
          const oldest = page.messages[0];
          if (!page.hasMore || !oldest) break;
          before = { sentAt: oldest.sentAt, id: oldest.id };
        }
        return {
          id: c.id,
          title: c.title,
          kind: c.kind,
          messages: messages.map((m) => ({
            id: m.id,
            from: m.senderName,
            sentAt: new Date(m.sentAt).toISOString(),
            kind: m.kind,
            body: m.deletedAt ? null : m.body,
            attachment: m.attachment ? { name: m.attachment.name, size: m.attachment.size } : null,
            editedAt: m.editedAt ? new Date(m.editedAt).toISOString() : null,
          })),
        };
      }),
      groups: this.groups.list(),
      calls: this.calls.history(10_000),
      skills: {
        skills: this.skills.mySkills(),
        updates: this.skills.myUpdates(),
        requests: this.skills.requests(),
      },
      bookmarks: this.skills.bookmarks(),
      settings: this.settings.getAll(),
    };
  }

  async stop(): Promise<void> {
    this.network.stop();
    this.calls.stop();
    this.transfers.stop();
    this.chat.stop();
    this.contacts.stop();
    await this.discovery.stop();
    await this.peers.stop();
  }
}
