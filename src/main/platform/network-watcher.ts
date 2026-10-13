import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';

/** Fingerprint of the current non-internal interface addresses. */
export function addressSignature(): string {
  const parts: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const info of list ?? []) if (!info.internal) parts.push(`${name}/${info.address}`);
  }
  return parts.sort().join(',');
}

/**
 * Emits `changed` when the machine joins/leaves a network or its addresses
 * change. Node has no portable event for this, so it polls cheaply.
 */
export class NetworkWatcher extends EventEmitter<{ changed: [] }> {
  private timer: NodeJS.Timeout | null = null;
  private last = addressSignature();

  constructor(
    private readonly intervalMs = 5000,
    private readonly signature: () => string = addressSignature,
  ) {
    super();
  }

  start(): void {
    this.timer ??= setInterval(() => this.check(), this.intervalMs);
    this.timer.unref();
  }

  check(): void {
    const next = this.signature();
    if (next !== this.last) {
      this.last = next;
      this.emit('changed');
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
