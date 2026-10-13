import type { Migration } from '../migrator';

export const migration0001: Migration = {
  version: 1,
  name: 'settings',
  sql: `
    CREATE TABLE settings (
      key        TEXT PRIMARY KEY NOT NULL,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `,
};
