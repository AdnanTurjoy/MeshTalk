import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { DatabaseHandle } from '../db/connection';
import { migrations } from '../db/migrations';
import { UserFacingError } from '../errors';
import type { DeviceCredentials } from '../identity/certificate';
import type { Logger } from '../logger';
import type { AppPaths } from '../platform/paths';
import type { SecretStore } from '../secrets/secret-store';

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: object,
) => Promise<Buffer>;

export const BACKUP_FORMAT = 'meshtalk-backup';
const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const STAGING = 'restore-staging';
const WIPE_MARKER = '.wipe-pending';

const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(1),
  appVersion: z.string(),
  schemaVersion: z.number().int().positive(),
  createdAt: z.number().int(),
  deviceId: z.string(),
  hasIdentity: z.boolean(),
  fileCount: z.number().int().nonnegative(),
  fileBytes: z.number().int().nonnegative(),
});
export type BackupManifest = z.infer<typeof manifestSchema>;

const wrappedIdentitySchema = z.object({
  v: z.literal(1),
  kdf: z.literal('scrypt'),
  N: z.number().int(),
  r: z.number().int(),
  p: z.number().int(),
  salt: z.string(),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

export class BackupError extends UserFacingError {
  override name = 'BackupError';
}

export interface BackupServiceDeps {
  database: DatabaseHandle;
  paths: AppPaths;
  secrets: SecretStore;
  logger: Logger;
  appVersion: string;
  credentials(): DeviceCredentials;
}

/**
 * Backups are plain folders: a consistent SQLite snapshot, the managed files,
 * and a manifest. The database and files are NOT encrypted, and the UI says
 * so. The device's private key is included only if the user sets a passphrase:
 * it is then wrapped with scrypt + AES-256-GCM (Node's crypto), which lets a
 * backup be restored on a different computer without the original keychain.
 */
export class BackupService {
  constructor(private readonly deps: BackupServiceDeps) {}

  async create(
    targetDir: string,
    passphrase: string | null,
  ): Promise<{ path: string; manifest: BackupManifest }> {
    if (passphrase !== null && passphrase.length < 8) {
      throw new BackupError('Use a passphrase of at least 8 characters.');
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const dir = join(targetDir, `MeshTalk-Backup-${stamp}`);
    if (existsSync(dir)) throw new BackupError('A backup with that name already exists there.');
    await mkdir(dir, { recursive: true });
    try {
      // better-sqlite3's online backup: consistent even while the app is running.
      await this.deps.database.sqlite.backup(join(dir, 'meshtalk.db'));
      const { count, bytes } = await this.copyFiles(this.deps.paths.files, join(dir, 'files'));
      const creds = this.deps.credentials();
      if (passphrase !== null) {
        await writeFile(
          join(dir, 'identity.json'),
          JSON.stringify(await wrap(creds.keyPem, passphrase)),
        );
      }
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        version: 1,
        appVersion: this.deps.appVersion,
        schemaVersion: this.deps.database.migration.currentVersion,
        createdAt: Date.now(),
        deviceId: creds.deviceId,
        hasIdentity: passphrase !== null,
        fileCount: count,
        fileBytes: bytes,
      };
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      this.deps.logger.info('backup.created', { files: count, withIdentity: manifest.hasIdentity });
      return { path: dir, manifest };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async inspect(dir: string): Promise<BackupManifest> {
    let manifest: BackupManifest;
    try {
      manifest = manifestSchema.parse(
        JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
      );
    } catch {
      throw new BackupError('That folder is not a MeshTalk backup.');
    }
    if (!existsSync(join(dir, 'meshtalk.db')))
      throw new BackupError('The backup is incomplete: the database is missing.');
    if (manifest.schemaVersion > migrations.length) {
      throw new BackupError(
        'This backup was made by a newer version of MeshTalk. Update MeshTalk first.',
      );
    }
    return manifest;
  }

  /**
   * Prepares a restore that is applied on the next start. If the backup's
   * device key can't be unlocked by this computer's keychain, the passphrase
   * is required to re-protect it with this keychain.
   */
  async stageRestore(
    dir: string,
    passphrase: string | null,
  ): Promise<{ needsPassphrase: boolean }> {
    const manifest = await this.inspect(dir);
    const staging = join(this.deps.paths.userData, STAGING);
    await rm(staging, { recursive: true, force: true });
    await mkdir(join(staging, 'data'), { recursive: true });
    await cp(join(dir, 'meshtalk.db'), join(staging, 'data', 'meshtalk.db'));
    try {
      const staged = new Database(join(staging, 'data', 'meshtalk.db'));
      try {
        const row = staged
          .prepare('SELECT encrypted_key FROM device_identity WHERE id = 1')
          .get() as { encrypted_key: Buffer } | undefined;
        let readable = false;
        if (row) {
          try {
            this.deps.secrets.decrypt(row.encrypted_key);
            readable = true;
          } catch {
            readable = false;
          }
        }
        if (row && !readable) {
          if (!manifest.hasIdentity) {
            throw new BackupError(
              'This backup’s device key can only be unlocked on the computer that made it. Make a new backup there with a passphrase.',
            );
          }
          if (passphrase === null) return { needsPassphrase: true };
          const wrapped = wrappedIdentitySchema.parse(
            JSON.parse(await readFile(join(dir, 'identity.json'), 'utf8')),
          );
          const keyPem = await unwrap(wrapped, passphrase);
          staged
            .prepare('UPDATE device_identity SET encrypted_key = ?, key_backend = ? WHERE id = 1')
            .run(this.deps.secrets.encrypt(keyPem), this.deps.secrets.backend);
        }
      } finally {
        staged.close();
      }
      if (existsSync(join(dir, 'files')))
        await cp(join(dir, 'files'), join(staging, 'files'), { recursive: true });
      await writeFile(join(staging, 'READY'), new Date().toISOString());
      this.deps.logger.info('backup.restore_staged');
      return { needsPassphrase: false };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  /** Writes a readable copy of the user's data (JSON), for portability. */
  async exportJson(targetDir: string, collect: () => Record<string, unknown>): Promise<string> {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const dir = join(targetDir, `MeshTalk-Export-${stamp}`);
    await mkdir(dir, { recursive: true });
    for (const [name, value] of Object.entries(collect())) {
      await writeFile(join(dir, `${name}.json`), JSON.stringify(value, null, 2));
    }
    await writeFile(
      join(dir, 'README.txt'),
      'MeshTalk data export.\nMessages, contacts, groups, calls and skills as JSON. Files are not included; ' +
        'use Backup for a complete copy.\nThis export is not encrypted.\n',
    );
    return dir;
  }

  requestWipe(): Promise<void> {
    return writeFile(join(this.deps.paths.userData, WIPE_MARKER), new Date().toISOString());
  }

  private async copyFiles(from: string, to: string): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    if (!existsSync(from)) return { count, bytes };
    await cp(from, to, {
      recursive: true,
      // Unfinished downloads are not worth backing up.
      filter: (src) => basename(dirname(src)) !== 'partial' && basename(src) !== 'partial',
    });
    for await (const f of walk(to)) {
      count++;
      bytes += (await stat(f)).size;
    }
    return { count, bytes };
  }
}

/**
 * Runs before the database is opened. Applies a staged restore (moving the
 * current data aside, never deleting it) or a requested wipe.
 */
export async function applyPendingDataOperations(
  paths: AppPaths,
  logger: Logger,
): Promise<'restored' | 'wiped' | null> {
  const root = paths.userData;
  if (existsSync(join(root, WIPE_MARKER))) {
    for (const name of ['data', 'files', STAGING])
      await rm(join(root, name), { recursive: true, force: true });
    for (const name of (await readdir(root)).filter((n) => n.startsWith('pre-restore-'))) {
      await rm(join(root, name), { recursive: true, force: true });
    }
    await rm(join(root, WIPE_MARKER), { force: true });
    logger.info('data.wiped');
    return 'wiped';
  }
  const staging = join(root, STAGING);
  if (existsSync(join(staging, 'READY'))) {
    const aside = join(root, `pre-restore-${Date.now()}`);
    await mkdir(aside, { recursive: true });
    for (const name of ['data', 'files']) {
      if (existsSync(join(root, name))) await rename(join(root, name), join(aside, name));
    }
    await rename(join(staging, 'data'), join(root, 'data'));
    if (existsSync(join(staging, 'files')))
      await rename(join(staging, 'files'), join(root, 'files'));
    await rm(staging, { recursive: true, force: true });
    logger.info('data.restored');
    return 'restored';
  }
  return null;
}

async function wrap(secret: string, passphrase: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scrypt(passphrase.normalize('NFKC'), salt, 32, KDF);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    v: 1 as const,
    kdf: 'scrypt' as const,
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

async function unwrap(
  w: z.infer<typeof wrappedIdentitySchema>,
  passphrase: string,
): Promise<string> {
  const key = await scrypt(passphrase.normalize('NFKC'), Buffer.from(w.salt, 'base64'), 32, {
    N: w.N,
    r: w.r,
    p: w.p,
    maxmem: KDF.maxmem,
  });
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(w.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(w.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(w.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new BackupError('Wrong passphrase.');
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}
