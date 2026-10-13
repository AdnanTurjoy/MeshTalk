import { EventEmitter } from 'node:events';
import { deviceIdSchema } from '../../shared/peers';
import type { Logger } from '../logger';

export const SERVICE_TYPE = 'meshtalk';
export const ENTRY_TTL_MS = 2 * 60_000;

/** What we learn from one mDNS announcement. Never contains profile data. */
export interface Announcement {
  name: string;
  host: string;
  addresses: string[];
  port: number;
  txt: Record<string, unknown>;
}

/** Thin seam over the mDNS library so discovery logic is testable. */
export interface MdnsDriver {
  publish(opts: { name: string; port: number; txt: Record<string, string> }): void;
  browse(onUp: (a: Announcement) => void, onDown: (a: Announcement) => void): void;
  refresh(): void;
  stop(): Promise<void>;
}

export interface NearbyEntry {
  deviceId: string;
  host: string;
  port: number;
  lastSeenAt: number;
}

export interface DiscoveryEvents {
  changed: [];
  error: [message: string];
}

/**
 * Announces `_meshtalk._tcp` with only {protocol version, device ID} and
 * browses for others. Announcements are hints: a device only becomes
 * trusted after the TLS certificate hash matches (see PeerService).
 */
export class DiscoveryService extends EventEmitter<DiscoveryEvents> {
  private readonly nearby = new Map<string, NearbyEntry>();
  private driver: MdnsDriver | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private stateValue: 'off' | 'on' | 'error' = 'off';
  private lastError: string | null = null;

  constructor(
    private readonly localDeviceId: string,
    private readonly createDriver: () => MdnsDriver,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  get state() {
    return this.stateValue;
  }

  get error(): string | null {
    return this.lastError;
  }

  start(port: number): void {
    if (this.driver) return;
    try {
      const driver = this.createDriver();
      driver.publish({
        name: `MeshTalk-${this.localDeviceId.slice(0, 16)}`,
        port,
        txt: { v: '1', id: this.localDeviceId },
      });
      driver.browse(
        (a) => this.onUp(a),
        (a) => this.onDown(a),
      );
      this.driver = driver;
      this.stateValue = 'on';
      this.lastError = null;
      this.sweepTimer = setInterval(() => {
        driver.refresh();
        this.sweep();
      }, 30_000);
      this.sweepTimer.unref();
      this.logger.info('discovery.started');
    } catch (error) {
      this.stateValue = 'error';
      this.lastError =
        'Local network discovery could not start. Multicast may be blocked on this network.';
      this.logger.warn('discovery.start_failed', { error });
      this.emit('error', this.lastError);
    }
    this.emit('changed');
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    const driver = this.driver;
    this.driver = null;
    this.nearby.clear();
    this.stateValue = 'off';
    if (driver) {
      try {
        await driver.stop();
      } catch (error) {
        this.logger.warn('discovery.stop_failed', { error });
      }
      this.logger.info('discovery.stopped');
    }
    this.emit('changed');
  }

  list(): NearbyEntry[] {
    this.sweep();
    return [...this.nearby.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  get(deviceId: string): NearbyEntry | undefined {
    return this.nearby.get(deviceId);
  }

  private onUp(a: Announcement): void {
    const parsed = parseAnnouncement(a);
    if (!parsed || parsed.deviceId === this.localDeviceId) return;
    this.nearby.set(parsed.deviceId, { ...parsed, lastSeenAt: this.now() });
    this.emit('changed');
  }

  private onDown(a: Announcement): void {
    const parsed = parseAnnouncement(a);
    if (parsed && this.nearby.delete(parsed.deviceId)) this.emit('changed');
  }

  private sweep(): void {
    const cutoff = this.now() - ENTRY_TTL_MS;
    let removed = false;
    for (const [id, entry] of this.nearby) {
      if (entry.lastSeenAt < cutoff) {
        this.nearby.delete(id);
        removed = true;
      }
    }
    if (removed) this.emit('changed');
  }
}

/** Validates an announcement; anything malformed is ignored. */
export function parseAnnouncement(a: Announcement): Omit<NearbyEntry, 'lastSeenAt'> | null {
  if (a.txt.v !== '1') return null;
  const id = deviceIdSchema.safeParse(a.txt.id);
  if (!id.success) return null;
  if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) return null;
  const host =
    a.addresses.find((addr) => /^\d+\.\d+\.\d+\.\d+$/.test(addr)) ?? a.addresses[0] ?? a.host;
  if (!host) return null;
  return { deviceId: id.data, host, port: a.port };
}
