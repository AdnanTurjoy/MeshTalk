import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export class MigrationChecksumError extends Error {
  constructor(readonly version: number) {
    super(`Migration ${version} was modified after it was applied.`);
    this.name = 'MigrationChecksumError';
  }
}

export class DatabaseNewerThanAppError extends Error {
  constructor(
    readonly databaseVersion: number,
    readonly appVersion: number,
  ) {
    super(
      `The database is at schema version ${databaseVersion}, but this app only knows up to ${appVersion}.`,
    );
    this.name = 'DatabaseNewerThanAppError';
  }
}

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function assertWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migrations must be numbered 1..n without gaps; found ${m.version} at ${i}.`);
    }
  });
}

/**
 * Applies pending migrations, each in its own transaction. Refuses to run if an
 * applied migration's SQL changed or if the database is newer than the app.
 */
export function runMigrations(
  sqlite: Database.Database,
  migrations: readonly Migration[],
  now: () => number = Date.now,
): MigrationResult {
  assertWellFormed(migrations);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY NOT NULL,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const appliedRows = sqlite
    .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
    .all() as { version: number; checksum: string }[];

  const latestKnown = migrations.length;
  const latestApplied = appliedRows.at(-1)?.version ?? 0;
  if (latestApplied > latestKnown) {
    throw new DatabaseNewerThanAppError(latestApplied, latestKnown);
  }

  for (const row of appliedRows) {
    const migration = migrations[row.version - 1];
    if (!migration || checksum(migration.sql) !== row.checksum) {
      throw new MigrationChecksumError(row.version);
    }
  }

  const insert = sqlite.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );
  const applied: number[] = [];
  for (const migration of migrations.slice(latestApplied)) {
    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      insert.run(migration.version, migration.name, checksum(migration.sql), now());
    })();
    applied.push(migration.version);
  }

  return { applied, currentVersion: latestKnown };
}
