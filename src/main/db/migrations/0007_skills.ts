import type { Migration } from '../migrator';

export const migration0007: Migration = {
  version: 7,
  name: 'skills',
  sql: `
    CREATE TABLE skills (
      id          TEXT PRIMARY KEY NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('skill', 'interest')),
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category    TEXT NOT NULL,
      level       TEXT,
      links_json  TEXT NOT NULL DEFAULT '[]',
      visibility  TEXT NOT NULL CHECK (visibility IN ('private', 'contacts')) DEFAULT 'private',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE project_updates (
      id         TEXT PRIMARY KEY NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL CHECK (visibility IN ('private', 'contacts')) DEFAULT 'private',
      created_at INTEGER NOT NULL
    ) STRICT;

    -- Last profile each contact shared with us, for offline search.
    CREATE TABLE peer_profiles (
      device_id    TEXT PRIMARY KEY NOT NULL,
      profile_json TEXT NOT NULL,
      fetched_at   INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE skill_requests (
      id             TEXT PRIMARY KEY NOT NULL,
      direction      TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
      peer_device_id TEXT NOT NULL,
      kind           TEXT NOT NULL CHECK (kind IN ('mentorship', 'collaboration')),
      topic          TEXT NOT NULL,
      note           TEXT NOT NULL DEFAULT '',
      state          TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'declined')),
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE bookmarks (
      id               TEXT PRIMARY KEY NOT NULL,
      title            TEXT NOT NULL,
      url              TEXT NOT NULL,
      note             TEXT NOT NULL DEFAULT '',
      source_device_id TEXT,
      created_at       INTEGER NOT NULL
    ) STRICT;
  `,
};
