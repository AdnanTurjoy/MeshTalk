import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/db/connection';
import { runIntegrityCheck } from '../../src/main/db/integrity';
import { SettingsService } from '../../src/main/services/settings-service';
import { defaultSettings } from '../../src/shared/settings';
import { silentLogger, tempDir } from './helpers';

let dir: ReturnType<typeof tempDir>;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => dir.cleanup());

describe('SettingsService', () => {
  it('returns defaults for a new database', () => {
    const handle = openDatabase(':memory:');
    expect(new SettingsService(handle.db, silentLogger()).getAll()).toEqual(defaultSettings);
    handle.close();
  });

  it('persists settings across close and reopen', () => {
    const path = join(dir.path, 'meshtalk.db');
    const first = openDatabase(path);
    const service = new SettingsService(first.db, silentLogger());
    service.set({ key: 'theme', value: 'dark' });
    service.set({ key: 'onboardingCompleted', value: true });
    first.close();

    const second = openDatabase(path);
    expect(new SettingsService(second.db, silentLogger()).getAll()).toEqual({
      ...defaultSettings,
      theme: 'dark',
      onboardingCompleted: true,
    });
    expect(second.migration.applied).toEqual([]);
    second.close();
  });

  it('overwrites an existing value instead of duplicating it', () => {
    const handle = openDatabase(':memory:');
    const service = new SettingsService(handle.db, silentLogger());
    service.set({ key: 'theme', value: 'dark' });
    service.set({ key: 'theme', value: 'light' });
    expect(service.get('theme')).toBe('light');
    expect(handle.sqlite.prepare('SELECT count(*) FROM settings').pluck().get()).toBe(1);
    handle.close();
  });

  it('falls back to defaults for corrupt or unknown rows and logs a warning', () => {
    const handle = openDatabase(':memory:');
    const insert = handle.sqlite.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)',
    );
    insert.run('theme', '"neon"');
    insert.run('onboardingCompleted', '{not json');
    insert.run('legacyKey', '1');
    const logger = silentLogger();
    const service = new SettingsService(handle.db, logger);
    expect(service.getAll()).toEqual(defaultSettings);
    expect(service.get('theme')).toBe('system');
    expect(logger.warn).toHaveBeenCalledWith('settings.invalid_value', { setting: 'theme' });
    handle.close();
  });

  it('rejects invalid values passed past the type system', () => {
    const handle = openDatabase(':memory:');
    const service = new SettingsService(handle.db, silentLogger());
    expect(() => service.set({ key: 'theme', value: 'neon' as never })).toThrow();
    expect(service.get('theme')).toBe('system');
    handle.close();
  });
});

describe('runIntegrityCheck', () => {
  it('reports a healthy database', () => {
    const handle = openDatabase(join(dir.path, 'meshtalk.db'));
    const report = runIntegrityCheck(handle.sqlite);
    expect(report).toMatchObject({ ok: true, integrity: ['ok'], foreignKeyViolations: 0 });
    handle.close();
  });
});
