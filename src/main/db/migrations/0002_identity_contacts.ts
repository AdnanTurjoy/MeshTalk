import type { Migration } from '../migrator';

export const migration0002: Migration = {
  version: 2,
  name: 'identity_contacts',
  sql: `
    CREATE TABLE local_account (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      display_name TEXT NOT NULL,
      email_label  TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE device_identity (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      device_id     TEXT NOT NULL,
      cert_pem      TEXT NOT NULL,
      key_backend   TEXT NOT NULL,
      encrypted_key BLOB NOT NULL,
      created_at    INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE contacts (
      device_id    TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      email_label  TEXT,
      state        TEXT NOT NULL CHECK (state IN ('outgoing', 'incoming', 'accepted', 'declined', 'blocked')),
      verified     INTEGER NOT NULL DEFAULT 0,
      last_host    TEXT,
      last_port    INTEGER,
      request_note TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      last_seen_at INTEGER
    ) STRICT;

    CREATE INDEX contacts_state ON contacts (state);
  `,
};
