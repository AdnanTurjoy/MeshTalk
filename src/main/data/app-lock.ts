import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/connection';
import { appLock } from '../db/schema';
import { UserFacingError } from '../errors';

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: object,
) => Promise<Buffer>;

/** scrypt N = 2^cost. 15 → ~32 MB and ~100 ms per attempt on a laptop. */
const COST = 15;
const FREE_ATTEMPTS = 5;
const MAX_DELAY_MS = 60 * 60 * 1000;

export class AppLockError extends UserFacingError {
  override name = 'AppLockError';
}

export function validatePin(pin: string): string | null {
  if (pin.length < 4) return 'Use at least 4 characters.';
  if (pin.length > 128) return 'That is too long.';
  return null;
}

/**
 * Optional app lock. This hides MeshTalk behind a PIN or passphrase on a shared
 * or unattended computer; it does not encrypt data on disk (see the threat
 * model). While locked, main refuses every IPC request except unlocking.
 */
export class AppLock {
  private lockedState: boolean;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {
    this.lockedState = this.enabled;
  }

  get enabled(): boolean {
    return this.db.select().from(appLock).where(eq(appLock.id, 1)).get() !== undefined;
  }

  get locked(): boolean {
    return this.lockedState;
  }

  lock(): boolean {
    if (!this.enabled) return false;
    this.lockedState = true;
    return true;
  }

  /** Sets or changes the PIN. Changing requires the current one. */
  async setPin(pin: string, currentPin: string | null): Promise<void> {
    const problem = validatePin(pin);
    if (problem) throw new AppLockError(problem);
    if (this.enabled) {
      if (currentPin === null || !(await this.verify(currentPin)))
        throw new AppLockError('The current PIN is wrong.');
    }
    const salt = randomBytes(16);
    const hash = await derive(pin, salt, COST);
    this.db
      .insert(appLock)
      .values({ id: 1, salt, hash, cost: COST, failedAttempts: 0, lockedUntil: 0 })
      .onConflictDoUpdate({
        target: appLock.id,
        set: { salt, hash, cost: COST, failedAttempts: 0, lockedUntil: 0 },
      })
      .run();
  }

  async disable(pin: string): Promise<void> {
    if (!this.enabled) return;
    if (!(await this.verify(pin))) throw new AppLockError('Wrong PIN.');
    this.db.delete(appLock).where(eq(appLock.id, 1)).run();
    this.lockedState = false;
  }

  async unlock(pin: string): Promise<void> {
    if (!this.lockedState) return;
    if (!(await this.verify(pin))) throw new AppLockError(this.failureMessage());
    this.lockedState = false;
  }

  /** Milliseconds until another attempt is allowed. */
  retryAfterMs(): number {
    const row = this.db.select().from(appLock).where(eq(appLock.id, 1)).get();
    return row ? Math.max(0, row.lockedUntil - this.now()) : 0;
  }

  private async verify(pin: string): Promise<boolean> {
    const row = this.db.select().from(appLock).where(eq(appLock.id, 1)).get();
    if (!row) return true;
    const wait = row.lockedUntil - this.now();
    if (wait > 0) throw new AppLockError(`Too many attempts. Try again in ${formatWait(wait)}.`);
    const candidate = await derive(pin, row.salt, row.cost);
    const ok = candidate.length === row.hash.length && timingSafeEqual(candidate, row.hash);
    if (ok) {
      this.db
        .update(appLock)
        .set({ failedAttempts: 0, lockedUntil: 0 })
        .where(eq(appLock.id, 1))
        .run();
      return true;
    }
    const failed = row.failedAttempts + 1;
    const delay =
      failed >= FREE_ATTEMPTS ? Math.min(30_000 * 2 ** (failed - FREE_ATTEMPTS), MAX_DELAY_MS) : 0;
    this.db
      .update(appLock)
      .set({ failedAttempts: failed, lockedUntil: delay ? this.now() + delay : 0 })
      .where(eq(appLock.id, 1))
      .run();
    return false;
  }

  private failureMessage(): string {
    const wait = this.retryAfterMs();
    return wait > 0 ? `Wrong PIN. Try again in ${formatWait(wait)}.` : 'Wrong PIN.';
  }
}

function derive(pin: string, salt: Buffer, cost: number): Promise<Buffer> {
  return scrypt(pin.normalize('NFKC'), salt, 32, {
    N: 2 ** cost,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function formatWait(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`;
}
