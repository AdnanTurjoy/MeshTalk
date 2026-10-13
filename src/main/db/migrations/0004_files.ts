import type { Migration } from '../migrator';

export const migration0004: Migration = {
  version: 4,
  name: 'files',
  sql: `
    -- One row per file known to this device (sent or received). Blobs live on
    -- disk under <userData>/files; stored_path is relative to that folder.
    CREATE TABLE files (
      id              TEXT PRIMARY KEY NOT NULL,
      message_id      TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      direction       TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
      name            TEXT NOT NULL,
      size            INTEGER NOT NULL,
      mime            TEXT NOT NULL,
      sha256          TEXT NOT NULL,
      duration_ms     INTEGER,
      source_path     TEXT,
      source_mtime    INTEGER,
      stored_path     TEXT,
      created_at      INTEGER NOT NULL,
      removed_at      INTEGER
    ) STRICT;

    CREATE INDEX files_sha256 ON files (sha256);

    -- One row per (file, peer) movement of bytes.
    CREATE TABLE transfers (
      file_id        TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
      peer_device_id TEXT NOT NULL,
      direction      TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
      state          TEXT NOT NULL CHECK (state IN
                       ('offered', 'waiting', 'transferring', 'paused', 'complete', 'failed', 'cancelled', 'declined')),
      bytes_done     INTEGER NOT NULL DEFAULT 0,
      error          TEXT,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (file_id, peer_device_id)
    ) STRICT;
  `,
};
