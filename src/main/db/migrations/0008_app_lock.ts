import type { Migration } from '../migrator';

export const migration0008: Migration = {
  version: 8,
  name: 'app_lock',
  sql: `
    -- Optional PIN/passphrase lock. Stores only a scrypt hash.
    CREATE TABLE app_lock (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      salt            BLOB NOT NULL,
      hash            BLOB NOT NULL,
      cost            INTEGER NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until    INTEGER NOT NULL DEFAULT 0
    ) STRICT;
  `,
};
