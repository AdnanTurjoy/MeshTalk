import type { Migration } from '../migrator';

export const migration0003: Migration = {
  version: 3,
  name: 'messaging',
  sql: `
    -- Whether the contact lets us show their online status / last seen.
    ALTER TABLE contacts ADD COLUMN shares_presence INTEGER NOT NULL DEFAULT 1;

    CREATE TABLE conversations (
      id              TEXT PRIMARY KEY NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
      peer_device_id  TEXT,
      pinned          INTEGER NOT NULL DEFAULT 0,
      archived        INTEGER NOT NULL DEFAULT 0,
      muted           INTEGER NOT NULL DEFAULT 0,
      draft           TEXT NOT NULL DEFAULT '',
      unread_count    INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER,
      created_at      INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE messages (
      id               TEXT PRIMARY KEY NOT NULL,
      conversation_id  TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      sender_device_id TEXT NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('text', 'file', 'voice', 'system')),
      body             TEXT NOT NULL DEFAULT '',
      reply_to_id      TEXT,
      sent_at          INTEGER NOT NULL,
      received_at      INTEGER NOT NULL,
      edited_at        INTEGER,
      deleted_at       INTEGER,
      status           TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'read', 'received', 'failed')),
      attachment_id    TEXT,
      mentions_me      INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE INDEX messages_conversation_order ON messages (conversation_id, sent_at, id);

    CREATE TABLE reactions (
      message_id        TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
      reactor_device_id TEXT NOT NULL,
      emoji             TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      PRIMARY KEY (message_id, reactor_device_id, emoji)
    ) STRICT;

    -- Reliable delivery: one row per (event, recipient) until the recipient acks.
    CREATE TABLE outbox (
      event_id         TEXT NOT NULL,
      target_device_id TEXT NOT NULL,
      conversation_id  TEXT,
      message_id       TEXT,
      payload          TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      attempts         INTEGER NOT NULL DEFAULT 0,
      last_attempt_at  INTEGER,
      PRIMARY KEY (event_id, target_device_id)
    ) STRICT;

    CREATE INDEX outbox_target ON outbox (target_device_id, created_at);

    CREATE VIRTUAL TABLE messages_fts USING fts5 (
      body,
      content = 'messages',
      content_rowid = 'rowid',
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
    END;
    CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
    END;
    CREATE TRIGGER messages_fts_update AFTER UPDATE OF body ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
    END;
  `,
};
