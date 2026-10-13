import type { AppEvent } from './events';
import type {
  AccountInput,
  ConnectionTestResult,
  Contact,
  DeviceIdentityInfo,
  LocalAccount,
  NearbyDevice,
  NetworkStatus,
} from './peers';
import type { SettingUpdate, Settings } from './settings';
import type { ChatMessage, ConversationSummary, MessagePage, SearchHit } from './chat';
import type { StorageUsage, TransferListItem } from './files';
import type { CallEndReason, CallKind, CallRecord, CallSignal } from './calls';
import type { DiscoveredGroup, GroupDetails, GroupPolicy } from './groups';
import type {
  Bookmark,
  PeerProfile,
  ProjectUpdate,
  SimilarPerson,
  Skill,
  SkillInput,
  SkillMatch,
  SkillRequest,
} from './skills';

/**
 * The complete renderer → main IPC surface. Anything not listed here is
 * unreachable from the renderer: the preload refuses other channels and main
 * validates every payload with the zod schemas in ./ipc-schemas.ts (see
 * src/main/ipc/router.ts). This module has no runtime dependencies so the
 * sandboxed preload can import it.
 */
export const IpcChannel = {
  settingsGetAll: 'settings:get-all',
  settingsSet: 'settings:set',
  systemInfo: 'system:info',
  dbIntegrityCheck: 'db:integrity-check',
  openDataDirectory: 'shell:open-data-directory',
  accountGet: 'account:get',
  accountSave: 'account:save',
  identityGet: 'identity:get',
  contactsList: 'contacts:list',
  contactsRequestNearby: 'contacts:request-nearby',
  contactsRequestAddress: 'contacts:request-address',
  contactsAccept: 'contacts:accept',
  contactsDecline: 'contacts:decline',
  contactsBlock: 'contacts:block',
  contactsUnblock: 'contacts:unblock',
  contactsRemove: 'contacts:remove',
  contactsSetVerified: 'contacts:set-verified',
  nearbyList: 'nearby:list',
  networkStatus: 'network:status',
  networkTest: 'network:test',
  chatListConversations: 'chat:list-conversations',
  chatGetConversation: 'chat:get-conversation',
  chatOpenDirect: 'chat:open-direct',
  chatListMessages: 'chat:list-messages',
  chatSend: 'chat:send',
  chatEdit: 'chat:edit',
  chatDelete: 'chat:delete',
  chatReact: 'chat:react',
  chatMarkRead: 'chat:mark-read',
  chatSetActive: 'chat:set-active',
  chatSetDraft: 'chat:set-draft',
  chatSetFlags: 'chat:set-flags',
  chatTyping: 'chat:typing',
  chatSearch: 'chat:search',
  chatMessagePosition: 'chat:message-position',
  filesSendBytes: 'files:send-bytes',
  filesAccept: 'files:accept',
  filesDecline: 'files:decline',
  filesPause: 'files:pause',
  filesResume: 'files:resume',
  filesCancel: 'files:cancel',
  filesSaveAs: 'files:save-as',
  filesShowInFolder: 'files:show-in-folder',
  filesOpen: 'files:open',
  filesRemove: 'files:remove',
  transfersList: 'transfers:list',
  storageUsage: 'storage:usage',
  storageClearPartial: 'storage:clear-partial',
  callStart: 'call:start',
  callSignal: 'call:signal',
  callEnd: 'call:end',
  callConnected: 'call:connected',
  callHistory: 'call:history',
  callMarkSeen: 'call:mark-seen',
  groupsList: 'groups:list',
  groupsGet: 'groups:get',
  groupsCreate: 'groups:create',
  groupsUpdate: 'groups:update',
  groupsInvite: 'groups:invite',
  groupsRemoveMember: 'groups:remove-member',
  groupsSetRole: 'groups:set-role',
  groupsTransferOwnership: 'groups:transfer-ownership',
  groupsLeave: 'groups:leave',
  groupsDelete: 'groups:delete',
  groupsAcceptInvite: 'groups:accept-invite',
  groupsDeclineInvite: 'groups:decline-invite',
  groupsDiscover: 'groups:discover',
  groupsRequestJoin: 'groups:request-join',
  groupsDecideJoin: 'groups:decide-join',
  skillsMine: 'skills:mine',
  skillsSave: 'skills:save',
  skillsDelete: 'skills:delete',
  skillsPostUpdate: 'skills:post-update',
  skillsDeleteUpdate: 'skills:delete-update',
  skillsDirectory: 'skills:directory',
  skillsSearch: 'skills:search',
  skillsRefresh: 'skills:refresh',
  skillsRequest: 'skills:request',
  skillsRespond: 'skills:respond',
  skillsRequests: 'skills:requests',
  bookmarksList: 'bookmarks:list',
  bookmarksAdd: 'bookmarks:add',
  bookmarksRemove: 'bookmarks:remove',
  lockStatus: 'lock:status',
  lockUnlock: 'lock:unlock',
  lockNow: 'lock:now',
  lockSetPin: 'lock:set-pin',
  lockDisable: 'lock:disable',
  dataBackup: 'data:backup',
  dataChooseBackup: 'data:choose-backup',
  dataRestore: 'data:restore',
  dataExport: 'data:export',
  dataWipe: 'data:wipe',
} as const;

/** The only requests main accepts while the app lock is engaged. */
export const ALLOWED_WHILE_LOCKED: ReadonlySet<string> = new Set([
  'lock:status',
  'lock:unlock',
  'settings:get-all',
]);

/**
 * Channels only the preload itself may call, never the renderer directly.
 * `files:send-path` takes a path that the preload derived from a real File
 * object (drag-and-drop or file picker), so the renderer cannot name
 * arbitrary files on disk.
 */
export const PreloadChannel = {
  filesSendPath: 'files:send-path',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];
export type AnyChannelName = IpcChannelName | (typeof PreloadChannel)[keyof typeof PreloadChannel];

export const ipcChannelNames: ReadonlySet<string> = new Set(Object.values(IpcChannel));

/** Main → renderer push channel; payload is an AppEvent. */
export const IPC_EVENT_CHANNEL = 'app:event';

export type Screen =
  'chats' | 'calls' | 'people' | 'skills' | 'files' | 'network' | 'settings' | 'diagnostics';

export type NetworkMode = 'lan-only' | 'account-server' | 'self-hosted';

export interface SystemInfo {
  app: { name: string; version: string; profile: string | null; packaged: boolean };
  runtime: { electron: string; chrome: string; node: string; v8: string };
  os: { platform: string; arch: string; release: string };
  paths: { userData: string; database: string; files: string; logs: string };
  database: {
    schemaVersion: number;
    latestKnownVersion: number;
    sqliteVersion: string;
    journalMode: string;
    sizeBytes: number;
  };
  networkMode: NetworkMode;
}

export interface IntegrityReport {
  ok: boolean;
  /** Messages from PRAGMA integrity_check; `["ok"]` when healthy. */
  integrity: string[];
  foreignKeyViolations: number;
  checkedAt: number;
  durationMs: number;
}

export type IpcErrorCode = 'invalid_request' | 'rejected' | 'internal' | 'unavailable';

export type IpcResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: IpcErrorCode; message: string } };

type DeviceRef = { deviceId: string };

/** Request payload per channel (`undefined` = no payload). */
export interface IpcRequests {
  [IpcChannel.settingsGetAll]: undefined;
  [IpcChannel.settingsSet]: SettingUpdate;
  [IpcChannel.systemInfo]: undefined;
  [IpcChannel.dbIntegrityCheck]: undefined;
  [IpcChannel.openDataDirectory]: undefined;
  [IpcChannel.accountGet]: undefined;
  [IpcChannel.accountSave]: AccountInput;
  [IpcChannel.identityGet]: undefined;
  [IpcChannel.contactsList]: undefined;
  [IpcChannel.contactsRequestNearby]: DeviceRef & { note: string | null };
  [IpcChannel.contactsRequestAddress]: { host: string; port: number; note: string | null };
  [IpcChannel.contactsAccept]: DeviceRef;
  [IpcChannel.contactsDecline]: DeviceRef;
  [IpcChannel.contactsBlock]: DeviceRef;
  [IpcChannel.contactsUnblock]: DeviceRef;
  [IpcChannel.contactsRemove]: DeviceRef;
  [IpcChannel.contactsSetVerified]: DeviceRef & { verified: boolean };
  [IpcChannel.nearbyList]: undefined;
  [IpcChannel.networkStatus]: undefined;
  [IpcChannel.networkTest]: { host: string; port: number };
  [IpcChannel.chatListConversations]: { archived: boolean };
  [IpcChannel.chatGetConversation]: ConversationRef;
  [IpcChannel.chatOpenDirect]: DeviceRef;
  [IpcChannel.chatListMessages]: {
    conversationId: string;
    before: { sentAt: number; id: string } | null;
    limit: number;
  };
  [IpcChannel.chatSend]: {
    conversationId: string;
    body: string;
    replyToId: string | null;
    mentions?: string[];
  };
  [IpcChannel.chatEdit]: { messageId: string; body: string };
  [IpcChannel.chatDelete]: { messageId: string; forEveryone: boolean };
  [IpcChannel.chatReact]: { messageId: string; emoji: string; on: boolean };
  [IpcChannel.chatMarkRead]: ConversationRef;
  [IpcChannel.chatSetActive]: { conversationId: string | null };
  [IpcChannel.chatSetDraft]: { conversationId: string; draft: string };
  [IpcChannel.chatSetFlags]: {
    conversationId: string;
    pinned?: boolean;
    archived?: boolean;
    muted?: boolean;
  };
  [IpcChannel.chatTyping]: ConversationRef;
  [IpcChannel.chatSearch]: { query: string; conversationId: string | null };
  [IpcChannel.chatMessagePosition]: { conversationId: string; messageId: string };
  [IpcChannel.filesSendBytes]: {
    conversationId: string;
    name: string;
    mime: string;
    kind: 'file' | 'voice';
    durationMs: number | null;
    data: Uint8Array;
  };
  [IpcChannel.filesAccept]: FileRef;
  [IpcChannel.filesDecline]: FileRef;
  [IpcChannel.filesPause]: FileRef;
  [IpcChannel.filesResume]: FileRef;
  [IpcChannel.filesCancel]: FileRef;
  [IpcChannel.filesSaveAs]: FileRef;
  [IpcChannel.filesShowInFolder]: FileRef;
  [IpcChannel.filesOpen]: FileRef;
  [IpcChannel.filesRemove]: FileRef;
  [IpcChannel.transfersList]: undefined;
  [IpcChannel.storageUsage]: undefined;
  [IpcChannel.storageClearPartial]: undefined;
  [PreloadChannel.filesSendPath]: { conversationId: string; path: string };
  [IpcChannel.callStart]: { conversationId: string; kind: CallKind };
  [IpcChannel.callSignal]: { callId: string; signal: CallSignal };
  [IpcChannel.callEnd]: { callId: string; reason: CallEndReason };
  [IpcChannel.callConnected]: { callId: string; relayed: boolean };
  [IpcChannel.callHistory]: undefined;
  [IpcChannel.callMarkSeen]: undefined;
  [IpcChannel.groupsList]: undefined;
  [IpcChannel.groupsGet]: GroupRef;
  [IpcChannel.groupsCreate]: {
    name: string;
    description: string;
    memberIds: string[];
    policy: GroupPolicy;
    discoverable: boolean;
  };
  [IpcChannel.groupsUpdate]: {
    groupId: string;
    name?: string;
    description?: string;
    policy?: GroupPolicy;
    discoverable?: boolean;
  };
  [IpcChannel.groupsInvite]: { groupId: string; deviceIds: string[] };
  [IpcChannel.groupsRemoveMember]: GroupMemberRef;
  [IpcChannel.groupsSetRole]: GroupMemberRef & { role: 'admin' | 'member' };
  [IpcChannel.groupsTransferOwnership]: GroupMemberRef;
  [IpcChannel.groupsLeave]: GroupRef;
  [IpcChannel.groupsDelete]: GroupRef;
  [IpcChannel.groupsAcceptInvite]: GroupRef;
  [IpcChannel.groupsDeclineInvite]: GroupRef;
  [IpcChannel.groupsDiscover]: undefined;
  [IpcChannel.groupsRequestJoin]: { groupId: string; adminDeviceId: string; note: string };
  [IpcChannel.groupsDecideJoin]: GroupMemberRef & { approve: boolean };
  [IpcChannel.skillsMine]: undefined;
  [IpcChannel.skillsSave]: SkillInput;
  [IpcChannel.skillsDelete]: IdRef;
  [IpcChannel.skillsPostUpdate]: {
    title: string;
    body: string;
    visibility: 'private' | 'contacts';
  };
  [IpcChannel.skillsDeleteUpdate]: IdRef;
  [IpcChannel.skillsDirectory]: undefined;
  [IpcChannel.skillsSearch]: { query: string };
  [IpcChannel.skillsRefresh]: undefined;
  [IpcChannel.skillsRequest]: {
    deviceId: string;
    kind: 'mentorship' | 'collaboration';
    topic: string;
    note: string;
  };
  [IpcChannel.skillsRespond]: { id: string; accept: boolean };
  [IpcChannel.skillsRequests]: undefined;
  [IpcChannel.bookmarksList]: undefined;
  [IpcChannel.bookmarksAdd]: {
    title: string;
    url: string;
    note: string;
    sourceDeviceId: string | null;
  };
  [IpcChannel.bookmarksRemove]: IdRef;
  [IpcChannel.lockStatus]: undefined;
  [IpcChannel.lockUnlock]: { pin: string };
  [IpcChannel.lockNow]: undefined;
  [IpcChannel.lockSetPin]: { pin: string; currentPin: string | null };
  [IpcChannel.lockDisable]: { pin: string };
  [IpcChannel.dataBackup]: { passphrase: string | null };
  [IpcChannel.dataChooseBackup]: undefined;
  [IpcChannel.dataRestore]: { path: string; passphrase: string | null };
  [IpcChannel.dataExport]: undefined;
  [IpcChannel.dataWipe]: { confirm: 'DELETE' };
}

type IdRef = { id: string };

type GroupRef = { groupId: string };
type GroupMemberRef = { groupId: string; deviceId: string };

type FileRef = { fileId: string };

type ConversationRef = { conversationId: string };

export interface IpcResponses {
  [IpcChannel.settingsGetAll]: Settings;
  [IpcChannel.settingsSet]: Settings;
  [IpcChannel.systemInfo]: SystemInfo;
  [IpcChannel.dbIntegrityCheck]: IntegrityReport;
  [IpcChannel.openDataDirectory]: null;
  [IpcChannel.accountGet]: LocalAccount | null;
  [IpcChannel.accountSave]: LocalAccount;
  [IpcChannel.identityGet]: DeviceIdentityInfo;
  [IpcChannel.contactsList]: Contact[];
  [IpcChannel.contactsRequestNearby]: Contact;
  [IpcChannel.contactsRequestAddress]: Contact;
  [IpcChannel.contactsAccept]: Contact;
  [IpcChannel.contactsDecline]: null;
  [IpcChannel.contactsBlock]: null;
  [IpcChannel.contactsUnblock]: null;
  [IpcChannel.contactsRemove]: null;
  [IpcChannel.contactsSetVerified]: Contact;
  [IpcChannel.nearbyList]: NearbyDevice[];
  [IpcChannel.networkStatus]: NetworkStatus;
  [IpcChannel.networkTest]: ConnectionTestResult;
  [IpcChannel.chatListConversations]: ConversationSummary[];
  [IpcChannel.chatGetConversation]: ConversationSummary;
  [IpcChannel.chatOpenDirect]: ConversationSummary;
  [IpcChannel.chatListMessages]: MessagePage;
  [IpcChannel.chatSend]: ChatMessage;
  [IpcChannel.chatEdit]: ChatMessage;
  [IpcChannel.chatDelete]: null;
  [IpcChannel.chatReact]: ChatMessage;
  [IpcChannel.chatMarkRead]: null;
  [IpcChannel.chatSetActive]: null;
  [IpcChannel.chatSetDraft]: null;
  [IpcChannel.chatSetFlags]: ConversationSummary;
  [IpcChannel.chatTyping]: null;
  [IpcChannel.chatSearch]: SearchHit[];
  [IpcChannel.chatMessagePosition]: number | null;
  [IpcChannel.filesSendBytes]: ChatMessage;
  [IpcChannel.filesAccept]: null;
  [IpcChannel.filesDecline]: null;
  [IpcChannel.filesPause]: null;
  [IpcChannel.filesResume]: null;
  [IpcChannel.filesCancel]: null;
  [IpcChannel.filesSaveAs]: { saved: boolean };
  [IpcChannel.filesShowInFolder]: null;
  [IpcChannel.filesOpen]: null;
  [IpcChannel.filesRemove]: null;
  [IpcChannel.transfersList]: TransferListItem[];
  [IpcChannel.storageUsage]: StorageUsage;
  [IpcChannel.storageClearPartial]: { removed: number };
  [PreloadChannel.filesSendPath]: ChatMessage;
  [IpcChannel.callStart]: { callId: string; peerDeviceId: string };
  [IpcChannel.callSignal]: null;
  [IpcChannel.callEnd]: null;
  [IpcChannel.callConnected]: null;
  [IpcChannel.callHistory]: { calls: CallRecord[]; missed: number };
  [IpcChannel.callMarkSeen]: null;
  [IpcChannel.groupsList]: GroupDetails[];
  [IpcChannel.groupsGet]: GroupDetails;
  [IpcChannel.groupsCreate]: GroupDetails;
  [IpcChannel.groupsUpdate]: GroupDetails;
  [IpcChannel.groupsInvite]: GroupDetails;
  [IpcChannel.groupsRemoveMember]: GroupDetails;
  [IpcChannel.groupsSetRole]: GroupDetails;
  [IpcChannel.groupsTransferOwnership]: GroupDetails;
  [IpcChannel.groupsLeave]: null;
  [IpcChannel.groupsDelete]: null;
  [IpcChannel.groupsAcceptInvite]: GroupDetails;
  [IpcChannel.groupsDeclineInvite]: null;
  [IpcChannel.groupsDiscover]: DiscoveredGroup[];
  [IpcChannel.groupsRequestJoin]: null;
  [IpcChannel.groupsDecideJoin]: GroupDetails;
  [IpcChannel.skillsMine]: { skills: Skill[]; updates: ProjectUpdate[] };
  [IpcChannel.skillsSave]: Skill;
  [IpcChannel.skillsDelete]: null;
  [IpcChannel.skillsPostUpdate]: ProjectUpdate;
  [IpcChannel.skillsDeleteUpdate]: null;
  [IpcChannel.skillsDirectory]: { profiles: PeerProfile[]; similar: SimilarPerson[] };
  [IpcChannel.skillsSearch]: SkillMatch[];
  [IpcChannel.skillsRefresh]: { asked: number };
  [IpcChannel.skillsRequest]: SkillRequest;
  [IpcChannel.skillsRespond]: null;
  [IpcChannel.skillsRequests]: SkillRequest[];
  [IpcChannel.bookmarksList]: Bookmark[];
  [IpcChannel.bookmarksAdd]: Bookmark;
  [IpcChannel.bookmarksRemove]: null;
  [IpcChannel.lockStatus]: LockStatus;
  [IpcChannel.lockUnlock]: LockStatus;
  [IpcChannel.lockNow]: LockStatus;
  [IpcChannel.lockSetPin]: LockStatus;
  [IpcChannel.lockDisable]: LockStatus;
  [IpcChannel.dataBackup]: { path: string; fileCount: number; fileBytes: number } | null;
  [IpcChannel.dataChooseBackup]: {
    path: string;
    createdAt: number;
    appVersion: string;
    fileCount: number;
    fileBytes: number;
    hasIdentity: boolean;
    sameDevice: boolean;
  } | null;
  [IpcChannel.dataRestore]: { needsPassphrase: boolean };
  [IpcChannel.dataExport]: { path: string } | null;
  [IpcChannel.dataWipe]: null;
}

export interface LockStatus {
  enabled: boolean;
  locked: boolean;
  retryAfterMs: number;
}

export type { AppEvent };
