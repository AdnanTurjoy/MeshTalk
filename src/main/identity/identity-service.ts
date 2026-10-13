import { eq } from 'drizzle-orm';
import {
  accountInputSchema,
  type AccountInput,
  type DeviceIdentityInfo,
  type LocalAccount,
} from '../../shared/peers';
import type { AppDatabase } from '../db/connection';
import { deviceIdentity, localAccount } from '../db/schema';
import type { Logger } from '../logger';
import type { SecretStore } from '../secrets/secret-store';
import { generateDeviceCredentials, type DeviceCredentials } from './certificate';
import { formatFingerprint } from './device-id';

export class IdentityUnavailableError extends Error {
  constructor(cause: unknown) {
    super('The device key could not be decrypted with the system keychain.', { cause });
    this.name = 'IdentityUnavailableError';
  }
}

export class IdentityService {
  private credentials: DeviceCredentials | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly secrets: SecretStore,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Loads the device credentials, creating them on first run. Never silently
   * regenerates an existing identity: that would change the device ID and
   * break every contact's pinned trust.
   */
  async loadOrCreate(): Promise<DeviceCredentials> {
    if (this.credentials) return this.credentials;
    const row = this.db.select().from(deviceIdentity).where(eq(deviceIdentity.id, 1)).get();
    if (row) {
      let keyPem: string;
      try {
        keyPem = this.secrets.decrypt(row.encryptedKey);
      } catch (error) {
        throw new IdentityUnavailableError(error);
      }
      this.credentials = { deviceId: row.deviceId, certPem: row.certPem, keyPem };
      return this.credentials;
    }

    const created = await generateDeviceCredentials(new Date(this.now()));
    if (!this.secrets.secure) {
      this.logger.warn('identity.insecure_key_storage', { backend: this.secrets.backend });
    }
    this.db
      .insert(deviceIdentity)
      .values({
        id: 1,
        deviceId: created.deviceId,
        certPem: created.certPem,
        keyBackend: this.secrets.backend,
        encryptedKey: this.secrets.encrypt(created.keyPem),
        createdAt: this.now(),
      })
      .run();
    this.logger.info('identity.created');
    this.credentials = created;
    return created;
  }

  info(): DeviceIdentityInfo {
    const creds = this.require();
    return {
      deviceId: creds.deviceId,
      fingerprint: formatFingerprint(creds.deviceId),
      secretStorage: { backend: this.secrets.backend, secure: this.secrets.secure },
    };
  }

  get deviceId(): string {
    return this.require().deviceId;
  }

  getAccount(): LocalAccount | null {
    const row = this.db.select().from(localAccount).where(eq(localAccount.id, 1)).get();
    if (!row) return null;
    return {
      displayName: row.displayName,
      emailLabel: row.emailLabel,
      emailVerified: false,
      createdAt: row.createdAt,
    };
  }

  saveAccount(input: AccountInput): LocalAccount {
    const { displayName, emailLabel } = accountInputSchema.parse(input);
    const now = this.now();
    this.db
      .insert(localAccount)
      .values({ id: 1, displayName, emailLabel, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: localAccount.id,
        set: { displayName, emailLabel, updatedAt: now },
      })
      .run();
    const account = this.getAccount();
    if (!account) throw new Error('Account was not saved');
    return account;
  }

  private require(): DeviceCredentials {
    if (!this.credentials) throw new Error('Identity not loaded');
    return this.credentials;
  }
}
