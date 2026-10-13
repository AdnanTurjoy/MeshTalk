import type Database from 'better-sqlite3';
import type { IntegrityReport } from '../../shared/ipc';

export function runIntegrityCheck(
  sqlite: Database.Database,
  now: () => number = Date.now,
): IntegrityReport {
  const startedAt = now();
  const integrity = (
    sqlite.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
  ).map((row) => row.integrity_check);
  const foreignKeyViolations = sqlite.prepare('PRAGMA foreign_key_check').all().length;
  const checkedAt = now();
  return {
    ok: integrity.length === 1 && integrity[0] === 'ok' && foreignKeyViolations === 0,
    integrity,
    foreignKeyViolations,
    checkedAt,
    durationMs: checkedAt - startedAt,
  };
}
