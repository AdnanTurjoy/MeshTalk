import type { Migration } from '../migrator';

export const migration0006: Migration = {
  version: 6,
  name: 'groups',
  sql: `
    CREATE TABLE groups (
      id           TEXT PRIMARY KEY NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      policy       TEXT NOT NULL CHECK (policy IN ('everyone', 'admins')),
      discoverable INTEGER NOT NULL DEFAULT 0,
      version      INTEGER NOT NULL,
      my_status    TEXT NOT NULL CHECK (my_status IN ('invited', 'active', 'left', 'removed', 'deleted')),
      invited_by   TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE group_members (
      group_id     TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
      device_id    TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
      status       TEXT NOT NULL CHECK (status IN ('active', 'invited')),
      host         TEXT,
      port         INTEGER,
      PRIMARY KEY (group_id, device_id)
    ) STRICT;

    CREATE INDEX group_members_device ON group_members (device_id);

    CREATE TABLE group_join_requests (
      group_id   TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
      device_id  TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, device_id)
    ) STRICT;

    -- Groups this device asked to join; an incoming snapshot listing us is then accepted.
    CREATE TABLE group_join_pending (
      group_id   TEXT PRIMARY KEY NOT NULL,
      admin_id   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
  `,
};
