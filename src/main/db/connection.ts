import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrations } from './migrations';
import { runMigrations, type MigrationResult } from './migrator';
import * as schema from './schema';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  sqlite: Database.Database;
  db: AppDatabase;
  migration: MigrationResult;
  close(): void;
}

/** Opens (or creates) the database at `path`, or in memory for `':memory:'`, and migrates it. */
export function openDatabase(path: string): DatabaseHandle {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    const migration = runMigrations(sqlite, migrations);
    return {
      sqlite,
      db: drizzle(sqlite, { schema }),
      migration,
      close: () => {
        if (sqlite.open) {
          sqlite.pragma('optimize');
          sqlite.close();
        }
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
