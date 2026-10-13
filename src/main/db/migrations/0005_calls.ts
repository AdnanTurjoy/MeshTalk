import type { Migration } from '../migrator';

export const migration0005: Migration = {
  version: 5,
  name: 'calls',
  sql: `
    CREATE TABLE calls (
      id              TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      peer_device_id  TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('audio', 'video')),
      direction       TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
      created_at      INTEGER NOT NULL,
      answered_at     INTEGER,
      ended_at        INTEGER,
      end_reason      TEXT,
      relayed         INTEGER NOT NULL DEFAULT 0,
      seen            INTEGER NOT NULL DEFAULT 1
    ) STRICT;

    CREATE INDEX calls_created ON calls (created_at);
  `,
};
