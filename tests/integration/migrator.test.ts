import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/db/connection';
import { migrations } from '../../src/main/db/migrations';
import {
  DatabaseNewerThanAppError,
  MigrationChecksumError,
  runMigrations,
  type Migration,
} from '../../src/main/db/migrator';
import * as schema from '../../src/main/db/schema';
import { tempDir } from './helpers';

let dir: ReturnType<typeof tempDir>;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => dir.cleanup());

const sample: Migration[] = [
  { version: 1, name: 'a', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY);' },
  { version: 2, name: 'b', sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY);' },
];

describe('runMigrations', () => {
  it('applies all migrations to a fresh database, then nothing on re-run', () => {
    const db = new Database(':memory:');
    expect(runMigrations(db, sample)).toEqual({ applied: [1, 2], currentVersion: 2 });
    expect(runMigrations(db, sample)).toEqual({ applied: [], currentVersion: 2 });
    db.close();
  });

  it('applies only the new migrations after an upgrade', () => {
    const db = new Database(':memory:');
    runMigrations(db, sample.slice(0, 1));
    expect(runMigrations(db, sample).applied).toEqual([2]);
    db.close();
  });

  it('rolls back a failing migration completely', () => {
    const db = new Database(':memory:');
    const broken: Migration[] = [
      ...sample,
      { version: 3, name: 'bad', sql: 'CREATE TABLE c (id INTEGER); INSERT INTO nope VALUES (1);' },
    ];
    expect(() => runMigrations(db, broken)).toThrow();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all();
    expect(tables).not.toContain('c');
    expect(db.prepare('SELECT max(version) FROM schema_migrations').pluck().get()).toBe(2);
    db.close();
  });

  it('refuses to run when an applied migration was edited', () => {
    const db = new Database(':memory:');
    runMigrations(db, sample);
    const edited = [sample[0], { ...sample[1], sql: 'CREATE TABLE b (id TEXT);' }] as Migration[];
    expect(() => runMigrations(db, edited)).toThrow(MigrationChecksumError);
    db.close();
  });

  it('refuses to open a database created by a newer app', () => {
    const db = new Database(':memory:');
    runMigrations(db, sample);
    expect(() => runMigrations(db, sample.slice(0, 1))).toThrow(DatabaseNewerThanAppError);
    db.close();
  });

  it('rejects gaps in migration numbering', () => {
    const db = new Database(':memory:');
    expect(() => runMigrations(db, [sample[1] as Migration])).toThrow(/without gaps/);
    db.close();
  });
});

describe('openDatabase', () => {
  it('creates the file with WAL and foreign keys enabled', () => {
    const handle = openDatabase(join(dir.path, 'nested', 'meshtalk.db'));
    expect(handle.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(handle.migration.currentVersion).toBe(migrations.length);
    handle.close();
  });

  it('keeps the Drizzle schema in sync with the migrated SQL', () => {
    const handle = openDatabase(':memory:');
    const tables = Object.values(schema) as SQLiteTable[];
    for (const table of tables) {
      const config = getTableConfig(table);
      const actual = (
        handle.sqlite.prepare(`PRAGMA table_info(${config.name})`).all() as {
          name: string;
          notnull: number;
          pk: number;
        }[]
      ).map((c) => ({ name: c.name, notNull: c.notnull === 1 || c.pk > 0, pk: c.pk > 0 }));
      // Composite primary keys are declared on the table, not on each column.
      const compositePk = new Set(
        config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
      );
      const expected = config.columns.map((c) => ({
        name: c.name,
        notNull: c.notNull || compositePk.has(c.name),
        pk: c.primary || compositePk.has(c.name),
      }));
      expect(sortByName(actual), config.name).toEqual(sortByName(expected));
    }
    handle.close();
  });

  it('fails loudly on a file that is not a database', async () => {
    const { writeFileSync } = await import('node:fs');
    const path = join(dir.path, 'garbage.db');
    writeFileSync(path, 'this is not sqlite'.repeat(100));
    expect(() => openDatabase(path)).toThrow(/not a database/i);
  });
});

function sortByName<T extends { name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}
