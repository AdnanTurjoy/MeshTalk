import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit Unix ms timestamp + random bits. Sortable by
 * creation time, generated without coordination on any device.
 */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Hybrid logical clock (milliseconds). Never goes backwards and always moves
 * past timestamps received from peers, so a reply always sorts after the
 * message it answers even when device clocks disagree.
 */
export class HybridClock {
  private last: number;

  constructor(
    initial = 0,
    private readonly wall: () => number = Date.now,
  ) {
    this.last = initial;
  }

  now(): number {
    this.last = Math.max(this.wall(), this.last + 1);
    return this.last;
  }

  /** Observes a remote timestamp; bounded so a wildly wrong clock can't poison ours. */
  observe(remote: number): void {
    const ceiling = this.wall() + 24 * 60 * 60 * 1000;
    if (remote > this.last && remote <= ceiling) this.last = remote;
  }
}
