# ADR-0002: SQLite via better-sqlite3 + Drizzle, hand-written migrations

Status: Accepted (M1)

## Decision

- **better-sqlite3**: synchronous, fast and mature. It runs in the main process
  only, and the renderer never gets a handle to it.
- **Drizzle ORM** for typed queries. The table definitions are in
  `src/main/db/schema.ts`.
- **Migrations are plain SQL strings in TypeScript modules**
  (`src/main/db/migrations/NNNN_name.ts`), applied by our own small migrator
  (`src/main/db/migrator.ts`). The migrator records a SHA-256 checksum for each
  migration and refuses to start if a migration was edited after release or if
  the DB is newer than the app.
- WAL mode, `foreign_keys = ON`, `busy_timeout = 5000`.

## Why not drizzle-kit's migrator

It reads migration folders from disk at runtime. That means shipping them as
`extraResources` and resolving paths differently in dev and in packaged
builds. Embedding the SQL in the bundle removes that failure mode, and the
checksum guard is ours. We can still use drizzle-kit to _draft_ SQL.

## Native ABI and tests

better-sqlite3 is rebuilt for Electron (`electron-builder install-app-deps`
in `postinstall`). Integration tests therefore run **under Electron's Node**
(`ELECTRON_RUN_AS_NODE=1`), so tests and the app load the same binary.

## Encryption at rest (later)

`better-sqlite3-multiple-ciphers` is a drop-in replacement with SQLCipher
support. It is planned as an opt-in in M8, with the key kept in the OS keychain
through `safeStorage`.
