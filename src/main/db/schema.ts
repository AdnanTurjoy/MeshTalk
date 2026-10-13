import { blob, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { TRANSFER_STATES } from '../../shared/files';

// Must stay in sync with the SQL in ./migrations — the migration test asserts it.

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  checksum: text('checksum').notNull(),
  appliedAt: integer('applied_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  /** JSON-encoded; validated per key by src/shared/settings.ts. */
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const localAccount = sqliteTable('local_account', {
  id: integer('id').primaryKey(),
  displayName: text('display_name').notNull(),
  emailLabel: text('email_label'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const deviceIdentity = sqliteTable('device_identity', {
  id: integer('id').primaryKey(),
  deviceId: text('device_id').notNull(),
  certPem: text('cert_pem').notNull(),
  keyBackend: text('key_backend').notNull(),
  encryptedKey: blob('encrypted_key', { mode: 'buffer' }).notNull(),
  createdAt: integer('created_at').notNull(),
});

export const contacts = sqliteTable('contacts', {
  deviceId: text('device_id').primaryKey(),
  displayName: text('display_name').notNull(),
  emailLabel: text('email_label'),
  state: text('state', {
    enum: ['outgoing', 'incoming', 'accepted', 'declined', 'blocked'],
  }).notNull(),
  verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
  lastHost: text('last_host'),
  lastPort: integer('last_port'),
  requestNote: text('request_note'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  sharesPresence: integer('shares_presence', { mode: 'boolean' }).notNull().default(true),
});

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['direct', 'group'] }).notNull(),
  peerDeviceId: text('peer_device_id'),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
  draft: text('draft').notNull().default(''),
  unreadCount: integer('unread_count').notNull().default(0),
  lastMessageAt: integer('last_message_at'),
  createdAt: integer('created_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  senderDeviceId: text('sender_device_id').notNull(),
  kind: text('kind', { enum: ['text', 'file', 'voice', 'system'] }).notNull(),
  body: text('body').notNull().default(''),
  replyToId: text('reply_to_id'),
  sentAt: integer('sent_at').notNull(),
  receivedAt: integer('received_at').notNull(),
  editedAt: integer('edited_at'),
  deletedAt: integer('deleted_at'),
  status: text('status', {
    enum: ['pending', 'delivered', 'read', 'received', 'failed'],
  }).notNull(),
  attachmentId: text('attachment_id'),
  mentionsMe: integer('mentions_me', { mode: 'boolean' }).notNull().default(false),
});

export const reactions = sqliteTable(
  'reactions',
  {
    messageId: text('message_id').notNull(),
    reactorDeviceId: text('reactor_device_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.reactorDeviceId, t.emoji] })],
);

export const outbox = sqliteTable(
  'outbox',
  {
    eventId: text('event_id').notNull(),
    targetDeviceId: text('target_device_id').notNull(),
    conversationId: text('conversation_id'),
    messageId: text('message_id'),
    payload: text('payload').notNull(),
    createdAt: integer('created_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: integer('last_attempt_at'),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.targetDeviceId] })],
);

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  direction: text('direction', { enum: ['outgoing', 'incoming'] }).notNull(),
  name: text('name').notNull(),
  size: integer('size').notNull(),
  mime: text('mime').notNull(),
  sha256: text('sha256').notNull(),
  durationMs: integer('duration_ms'),
  sourcePath: text('source_path'),
  sourceMtime: integer('source_mtime'),
  storedPath: text('stored_path'),
  createdAt: integer('created_at').notNull(),
  removedAt: integer('removed_at'),
});

export const transfers = sqliteTable(
  'transfers',
  {
    fileId: text('file_id').notNull(),
    peerDeviceId: text('peer_device_id').notNull(),
    direction: text('direction', { enum: ['outgoing', 'incoming'] }).notNull(),
    state: text('state', { enum: TRANSFER_STATES }).notNull(),
    bytesDone: integer('bytes_done').notNull().default(0),
    error: text('error'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.peerDeviceId] })],
);

export const calls = sqliteTable('calls', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  peerDeviceId: text('peer_device_id').notNull(),
  kind: text('kind', { enum: ['audio', 'video'] }).notNull(),
  direction: text('direction', { enum: ['incoming', 'outgoing'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  answeredAt: integer('answered_at'),
  endedAt: integer('ended_at'),
  endReason: text('end_reason'),
  relayed: integer('relayed', { mode: 'boolean' }).notNull().default(false),
  /** Missed incoming calls start unseen. */
  seen: integer('seen', { mode: 'boolean' }).notNull().default(true),
});

export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  policy: text('policy', { enum: ['everyone', 'admins'] }).notNull(),
  discoverable: integer('discoverable', { mode: 'boolean' }).notNull().default(false),
  version: integer('version').notNull(),
  myStatus: text('my_status', {
    enum: ['invited', 'active', 'left', 'removed', 'deleted'],
  }).notNull(),
  invitedBy: text('invited_by'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const groupMembers = sqliteTable(
  'group_members',
  {
    groupId: text('group_id').notNull(),
    deviceId: text('device_id').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
    status: text('status', { enum: ['active', 'invited'] }).notNull(),
    host: text('host'),
    port: integer('port'),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.deviceId] })],
);

export const groupJoinRequests = sqliteTable(
  'group_join_requests',
  {
    groupId: text('group_id').notNull(),
    deviceId: text('device_id').notNull(),
    note: text('note').notNull().default(''),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.deviceId] })],
);

export const groupJoinPending = sqliteTable('group_join_pending', {
  groupId: text('group_id').primaryKey(),
  adminId: text('admin_id').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['skill', 'interest'] }).notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  category: text('category').notNull(),
  level: text('level'),
  linksJson: text('links_json').notNull().default('[]'),
  visibility: text('visibility', { enum: ['private', 'contacts'] })
    .notNull()
    .default('private'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const projectUpdates = sqliteTable('project_updates', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  visibility: text('visibility', { enum: ['private', 'contacts'] })
    .notNull()
    .default('private'),
  createdAt: integer('created_at').notNull(),
});

export const peerProfiles = sqliteTable('peer_profiles', {
  deviceId: text('device_id').primaryKey(),
  profileJson: text('profile_json').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

export const skillRequests = sqliteTable('skill_requests', {
  id: text('id').primaryKey(),
  direction: text('direction', { enum: ['incoming', 'outgoing'] }).notNull(),
  peerDeviceId: text('peer_device_id').notNull(),
  kind: text('kind', { enum: ['mentorship', 'collaboration'] }).notNull(),
  topic: text('topic').notNull(),
  note: text('note').notNull().default(''),
  state: text('state', { enum: ['pending', 'accepted', 'declined'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const bookmarks = sqliteTable('bookmarks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  note: text('note').notNull().default(''),
  sourceDeviceId: text('source_device_id'),
  createdAt: integer('created_at').notNull(),
});

export const appLock = sqliteTable('app_lock', {
  id: integer('id').primaryKey(),
  salt: blob('salt', { mode: 'buffer' }).notNull(),
  hash: blob('hash', { mode: 'buffer' }).notNull(),
  cost: integer('cost').notNull(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: integer('locked_until').notNull().default(0),
});
