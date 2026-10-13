import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppLock } from '../../src/main/data/app-lock';
import { applyPendingDataOperations, BackupService } from '../../src/main/data/backup-service';
import { openDatabase } from '../../src/main/db/connection';
import { IdentityService } from '../../src/main/identity/identity-service';
import { appPaths } from '../../src/main/platform/paths';
import type { SecretStore } from '../../src/main/secrets/secret-store';
import { silentLogger, tempDir } from './helpers';
import { befriend, createNode, FakeLan, until, type TestNode } from './peer-harness';

let dir: ReturnType<typeof tempDir>;
let nodes: TestNode[] = [];
beforeEach(() => {
  dir = tempDir();
});
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop().catch(() => undefined)));
  nodes = [];
  dir.cleanup();
});

/** A keychain stand-in bound to one "computer": other keys can't decrypt it. */
function keychain(machine: string): SecretStore {
  const mask = createHash('sha256').update(machine).digest();
  const xor = (b: Buffer) => Buffer.from(b.map((v, i) => v ^ (mask[i % mask.length] ?? 0)));
  return {
    backend: `test-${machine}`,
    secure: true,
    encrypt: (plain) =>
      Buffer.concat([Buffer.from(machine.padEnd(8).slice(0, 8)), xor(Buffer.from(plain))]),
    decrypt: (data) => {
      if (data.subarray(0, 8).toString() !== machine.padEnd(8).slice(0, 8))
        throw new Error('wrong keychain');
      return xor(data.subarray(8)).toString();
    },
  };
}

describe('app lock', () => {
  it('locks on start, verifies the PIN, and backs off after repeated failures', async () => {
    const db = openDatabase(':memory:');
    let now = 1_000_000;
    const lock = new AppLock(db.db, () => now);
    expect(lock.enabled).toBe(false);
    await lock.setPin('2468', null);
    expect(lock.locked).toBe(false); // setting a PIN doesn't lock immediately

    const fresh = new AppLock(db.db, () => now); // as after a restart
    expect(fresh.locked).toBe(true);
    await expect(fresh.unlock('0000')).rejects.toThrow(/Wrong PIN/);
    await fresh.unlock('2468');
    expect(fresh.locked).toBe(false);

    fresh.lock();
    for (let i = 0; i < 4; i++) await expect(fresh.unlock('1111')).rejects.toThrow(/^Wrong PIN\.$/);
    await expect(fresh.unlock('1111')).rejects.toThrow(/Try again in 30 seconds/);
    await expect(fresh.unlock('2468')).rejects.toThrow(/Too many attempts/);
    now += 31_000;
    await fresh.unlock('2468');

    await expect(fresh.setPin('9999', 'wrong')).rejects.toThrow(/current PIN/);
    await fresh.setPin('99999', '2468');
    await expect(fresh.disable('2468')).rejects.toThrow(/Wrong PIN/);
    await fresh.disable('99999');
    expect(fresh.enabled).toBe(false);
    db.close();
  });
});

describe('backup and restore', () => {
  it('restores messages, files and identity onto another computer with the passphrase', async () => {
    const lan = new FakeLan();
    const aliceDir = join(dir.path, 'alice');
    const alicePaths = appPaths(aliceDir);
    const alice = await createNode('Alice', lan, {
      dbPath: alicePaths.database,
      filesDir: alicePaths.files,
    });
    const bob = await createNode('Bob', lan);
    nodes.push(alice, bob);
    await befriend(alice, bob);
    const conv = bob.chat.openDirect(alice.identity.deviceId);
    const data = randomBytes(300_000);
    const file = await bob.transfers.sendBytes(
      conv.id,
      'photo.png',
      'image/png',
      'file',
      null,
      data,
    );
    bob.chat.send(conv.id, 'Remember this', null);
    await until(() => alice.chat.getMessage(file.id) !== null);
    await alice.transfers.accept(file.attachment?.fileId ?? '');
    await until(() => alice.chat.getMessage(file.id)?.attachment?.state === 'complete', 8000);

    const realKey = await alice.identity.loadOrCreate();
    const backupsWithKey = new BackupService({
      database: alice.database,
      paths: alicePaths,
      secrets: keychain('laptop-1'),
      logger: silentLogger(),
      appVersion: 'test',
      credentials: () => realKey,
    });
    await expect(backupsWithKey.create(dir.path, 'short')).rejects.toThrow(/at least 8/);
    const { path, manifest } = await backupsWithKey.create(
      join(dir.path, 'out'),
      'correct horse battery',
    );
    expect(manifest).toMatchObject({ hasIdentity: true, deviceId: alice.identity.deviceId });
    expect(manifest.fileCount).toBe(1);

    // A different computer: its keychain cannot read the key stored in the DB.
    const newDir = join(dir.path, 'new-laptop');
    const newPaths = appPaths(newDir);
    const otherKeychain = keychain('laptop-2');
    const restorer = new BackupService({
      database: openDatabase(':memory:'),
      paths: newPaths,
      secrets: otherKeychain,
      logger: silentLogger(),
      appVersion: 'test',
      credentials: () => realKey,
    });
    expect(await restorer.stageRestore(path, null)).toEqual({ needsPassphrase: true });
    await expect(restorer.stageRestore(path, 'wrong passphrase')).rejects.toThrow(
      /Wrong passphrase/,
    );
    expect(await restorer.stageRestore(path, 'correct horse battery')).toEqual({
      needsPassphrase: false,
    });
    expect(await applyPendingDataOperations(newPaths, silentLogger())).toBe('restored');

    const restored = openDatabase(newPaths.database);
    const identity = new IdentityService(restored.db, otherKeychain, silentLogger());
    expect((await identity.loadOrCreate()).deviceId).toBe(alice.identity.deviceId);
    const bodies = restored.sqlite.prepare('SELECT body FROM messages').pluck().all();
    expect(bodies).toContain('Remember this');
    const stored = restored.sqlite
      .prepare('SELECT stored_path FROM files WHERE stored_path IS NOT NULL')
      .pluck()
      .get() as string;
    expect(readFileSync(join(newPaths.files, stored)).equals(data)).toBe(true);
    restored.close();
  });

  it('refuses folders that are not backups and wipes data on request', async () => {
    const paths = appPaths(join(dir.path, 'user'));
    const db = openDatabase(paths.database);
    const svc = new BackupService({
      database: db,
      paths,
      secrets: keychain('x'),
      logger: silentLogger(),
      appVersion: 'test',
      credentials: () => ({ deviceId: 'D', certPem: '', keyPem: '' }),
    });
    await expect(svc.inspect(dir.path)).rejects.toThrow(/not a MeshTalk backup/);
    db.close();
    await svc.requestWipe();
    expect(await applyPendingDataOperations(paths, silentLogger())).toBe('wiped');
    expect(existsSync(paths.database)).toBe(false);
    expect(await applyPendingDataOperations(paths, silentLogger())).toBeNull();
  });
});
