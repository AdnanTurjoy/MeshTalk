# MeshTalk — Local Database Schema

SQLite through `better-sqlite3`, typed queries through Drizzle ORM. The source
of truth for the shape is `src/main/db/schema.ts`. The SQL that actually
changes the database lives in `src/main/db/migrations/`.

## Migration rules

- Migrations are numbered, **append-only** and immutable once released.
- Each runs inside a transaction and is recorded in `schema_migrations(version,
name, checksum, applied_at)`.
- At startup the app checks the checksum of every applied migration. If a
  migration was changed after release, the app refuses to start rather than
  silently diverge.
- If the database is _newer_ than the app (the user downgraded), the app
  refuses to open it and shows an error dialog, so it cannot corrupt the data.
- `PRAGMA integrity_check` and `PRAGMA foreign_key_check` can be run from
  Diagnostics.

## Tables (all implemented)

IDs are UUIDs (UUIDv7 for messages), device IDs are base32 SHA-256 certificate
hashes, and timestamps are integer milliseconds UTC.

| Migration | Table                                                                       | Purpose                                                                                                                          |
| --------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| —         | `schema_migrations`                                                         | Applied migration ledger with checksums                                                                                          |
| 0001      | `settings`                                                                  | Key/value settings, each validated by `src/shared/settings.ts`                                                                   |
| 0002      | `local_account`                                                             | Display name and the **unverified** email label                                                                                  |
| 0002      | `device_identity`                                                           | Device ID, certificate, private key encrypted by the OS keychain                                                                 |
| 0002      | `contacts`                                                                  | One row per device: state (`outgoing`/`incoming`/`accepted`/`declined`/`blocked`), verified flag, last address, presence sharing |
| 0003      | `conversations`                                                             | Direct (`d:<deviceId>`) and group (`g:<uuid>`) conversations, flags, draft, unread count                                         |
| 0003      | `messages`                                                                  | Text/file/voice/system messages ordered by hybrid logical clock, edit/delete markers, delivery status                            |
| 0003      | `reactions`                                                                 | (message, reactor, emoji)                                                                                                        |
| 0003      | `outbox`                                                                    | Reliable delivery queue: one row per (event, recipient) until acknowledged                                                       |
| 0003      | `messages_fts`                                                              | FTS5 index over message bodies (kept in sync by triggers)                                                                        |
| 0004      | `files`                                                                     | File metadata; bytes live under `<userData>/files`, never in SQLite                                                              |
| 0004      | `transfers`                                                                 | Per (file, peer) state and bytes done, for resume                                                                                |
| 0005      | `calls`                                                                     | Call history, missed flag, relayed flag                                                                                          |
| 0006      | `groups`, `group_members`, `group_join_requests`, `group_join_pending`      | Group snapshots and requests (ADR-0005)                                                                                          |
| 0007      | `skills`, `project_updates`, `peer_profiles`, `skill_requests`, `bookmarks` | Skill sharing                                                                                                                    |
| 0008      | `app_lock`                                                                  | scrypt hash of the app-lock PIN and back-off state                                                                               |
