import { EventEmitter } from 'node:events';
import type { TLSSocket } from 'node:tls';
import type { Logger } from '../logger';
import { encodeBinaryFrame, encodeJsonFrame, FRAME_JSON, FrameDecoder, FrameError } from './frames';
import { wireMessageSchema, type WireMessage } from './wire';

export const PING_INTERVAL_MS = 15_000;
export const IDLE_TIMEOUT_MS = 45_000;

export type Direction = 'inbound' | 'outbound';

export interface PeerConnectionEvents {
  message: [WireMessage];
  binary: [header: unknown, data: Buffer];
  close: [reason: string];
}

export interface PeerConnectionOptions {
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
}

/**
 * One authenticated TLS link to one remote device. The remote device ID was
 * derived from its certificate before this object exists.
 */
export class PeerConnection extends EventEmitter<PeerConnectionEvents> {
  readonly connectedAt = Date.now();
  /** Port where the remote accepts connections, learned from its hello. */
  remoteListenPort: number | null = null;
  helloReceived = false;
  private readonly decoder = new FrameDecoder();
  private pingTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private lastReceivedAt = Date.now();

  constructor(
    readonly socket: TLSSocket,
    readonly remoteDeviceId: string,
    readonly direction: Direction,
    private readonly logger: Logger,
    options: PeerConnectionOptions = {},
  ) {
    super();
    const pingInterval = options.pingIntervalMs ?? PING_INTERVAL_MS;
    const idleTimeout = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error) => {
      this.logger.debug('peer.socket_error', { code: (error as NodeJS.ErrnoException).code });
      this.close('socket_error');
    });
    socket.on('close', () => this.close('closed'));
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastReceivedAt > idleTimeout) {
        this.close('idle_timeout');
        return;
      }
      this.send({ t: 'ping' });
    }, pingInterval);
    this.pingTimer.unref();
  }

  get remoteAddress(): string {
    return normalizeAddress(this.socket.remoteAddress ?? '');
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  send(message: WireMessage): boolean {
    if (this.closed) return false;
    return this.socket.write(encodeJsonFrame(message));
  }

  /** Sends a binary frame, resolving once the socket can accept more data. */
  async sendBinary(header: unknown, data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('Connection closed');
    if (!this.socket.write(encodeBinaryFrame(header, data))) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          reject(new Error('Connection closed'));
        };
        const cleanup = () => {
          this.socket.off('drain', onDrain);
          this.off('close', onClose);
        };
        this.socket.once('drain', onDrain);
        this.once('close', onClose);
      });
    }
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (!this.socket.destroyed) {
      if (reason !== 'closed' && reason !== 'socket_error') {
        try {
          this.socket.write(encodeJsonFrame({ t: 'bye', reason }));
        } catch {
          // best effort
        }
        this.socket.end();
        setTimeout(() => this.socket.destroy(), 1000).unref();
      } else {
        this.socket.destroy();
      }
    }
    this.emit('close', reason);
    this.removeAllListeners('message');
    this.removeAllListeners('binary');
  }

  private onData(chunk: Buffer): void {
    this.lastReceivedAt = Date.now();
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.logger.warn('peer.bad_frame', {
        reason: error instanceof FrameError ? error.message : 'unknown',
      });
      this.close('protocol_error');
      return;
    }
    for (const frame of frames) {
      if (this.closed) return;
      if (frame.kind === FRAME_JSON) {
        const parsed = wireMessageSchema.safeParse(frame.json);
        if (!parsed.success) {
          this.logger.warn('peer.bad_message', {
            type:
              typeof frame.json === 'object' && frame.json
                ? String((frame.json as { t?: unknown }).t)
                : 'n/a',
          });
          this.close('protocol_error');
          return;
        }
        const message = parsed.data;
        if (message.t === 'ping') {
          this.send({ t: 'pong' });
          continue;
        }
        if (message.t === 'pong') continue;
        if (message.t === 'bye') {
          this.close('closed');
          return;
        }
        this.emit('message', message);
      } else {
        this.emit('binary', frame.header, frame.data);
      }
    }
  }
}

/** Strips the IPv4-mapped IPv6 prefix so `::ffff:192.168.1.5` reads as `192.168.1.5`. */
export function normalizeAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}
