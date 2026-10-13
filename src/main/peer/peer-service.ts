import { EventEmitter } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import tls, { type TLSSocket } from 'node:tls';
import type { ConnectionTestResult, ConnectionTestStage } from '../../shared/peers';
import { deviceIdFromCertificate, formatFingerprint } from '../identity/device-id';
import type { DeviceCredentials } from '../identity/certificate';
import type { Logger } from '../logger';
import { PeerConnection, normalizeAddress, type PeerConnectionOptions } from './peer-connection';
import { PROTOCOL_VERSION, UNTRUSTED_ALLOWED } from './protocol';
import type { WireMessage } from './wire';

export const DEFAULT_PEER_PORT = 47820;

export type PeerAccess = 'trusted' | 'untrusted' | 'blocked';

export interface PeerServiceOptions {
  credentials: DeviceCredentials;
  logger: Logger;
  /** Consulted on every connection and message, so trust changes apply immediately. */
  access(deviceId: string): PeerAccess;
  preferredPort?: number;
  /** Bind address; defaults to all interfaces. */
  bindHost?: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxUntrustedConnections?: number;
  maxInboundPerMinutePerIp?: number;
  connection?: PeerConnectionOptions;
}

export interface PeerServiceEvents {
  connected: [PeerConnection];
  disconnected: [deviceId: string, reason: string];
  message: [deviceId: string, message: WireMessage, connection: PeerConnection];
  binary: [deviceId: string, header: unknown, data: Buffer];
  listening: [port: number];
}

export class PeerConnectError extends Error {
  constructor(
    readonly stage: ConnectionTestStage,
    message: string,
    readonly deviceId: string | null = null,
  ) {
    super(message);
    this.name = 'PeerConnectError';
  }
}

const STAGE_MESSAGES: Record<ConnectionTestStage, string> = {
  ok: 'Connected. This is a MeshTalk device.',
  dns: 'That host name could not be found.',
  tcp_refused:
    'The device answered but refused the connection. MeshTalk may not be running there, or the port is wrong.',
  tcp_timeout:
    'No answer. A firewall may be blocking MeshTalk, or the network isolates devices from each other.',
  unreachable: 'That address cannot be reached from this network.',
  tls: 'A secure connection could not be set up. The other side may not be MeshTalk.',
  identity_mismatch:
    'The device that answered is not the one expected. Someone may be impersonating it. Do not continue.',
  self: 'That address is this device.',
  protocol: 'The other side is not speaking the MeshTalk protocol.',
};

/**
 * Owns the PeerLink listener and every peer connection (ADR-0003). Transport
 * only: trust decisions come from `access`, feature logic subscribes to events.
 */
export class PeerService extends EventEmitter<PeerServiceEvents> {
  private server: tls.Server | null = null;
  private readonly connections = new Map<string, PeerConnection>();
  private readonly pending = new Set<PeerConnection>();
  private readonly inboundAttempts = new Map<string, number[]>();
  private port: number | null = null;
  private stopped = false;
  private readonly rawSockets = new Set<Socket>();

  constructor(private readonly options: PeerServiceOptions) {
    super();
  }

  get localDeviceId(): string {
    return this.options.credentials.deviceId;
  }

  get listenPort(): number | null {
    return this.port;
  }

  /** Starts listening on the preferred port, falling back to any free port. */
  async start(): Promise<number> {
    const server = tls.createServer({
      ...this.tlsOptions(),
      requestCert: true,
      rejectUnauthorized: false,
    });
    server.on('connection', (socket: Socket) => {
      this.rawSockets.add(socket);
      socket.once('close', () => this.rawSockets.delete(socket));
      // Resets before/while handshaking are normal on a LAN; never let them crash main.
      socket.on('error', () => undefined);
    });
    server.on('secureConnection', (socket) => this.onInbound(socket));
    server.on('tlsClientError', (error) => {
      this.options.logger.debug('peer.tls_client_error', {
        code: (error as NodeJS.ErrnoException).code,
      });
    });
    this.server = server;
    const host = this.options.bindHost;
    const preferred = this.options.preferredPort ?? DEFAULT_PEER_PORT;
    try {
      await listen(server, preferred, host);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || preferred === 0) throw error;
      this.options.logger.info('peer.port_in_use', { port: preferred });
      await listen(server, 0, host);
    }
    this.port = (server.address() as AddressInfo).port;
    this.options.logger.info('peer.listening', { port: this.port });
    this.emit('listening', this.port);
    return this.port;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const conn of [...this.connections.values(), ...this.pending]) conn.close('shutdown');
    this.connections.clear();
    this.pending.clear();
    // Sockets still in the TLS handshake are not PeerConnections yet; without
    // this, server.close() would wait for them indefinitely.
    for (const socket of this.rawSockets) socket.destroy();
    this.rawSockets.clear();
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  get(deviceId: string): PeerConnection | undefined {
    const conn = this.connections.get(deviceId);
    return conn?.isOpen ? conn : undefined;
  }

  isConnected(deviceId: string): boolean {
    return this.get(deviceId) !== undefined;
  }

  connectedDeviceIds(): string[] {
    return [...this.connections.keys()];
  }

  send(deviceId: string, message: WireMessage): boolean {
    return this.get(deviceId)?.send(message) ?? false;
  }

  disconnect(deviceId: string, reason: string): void {
    this.get(deviceId)?.close(reason);
  }

  /**
   * Opens (or reuses) an authenticated link. When `expectedDeviceId` is given
   * the remote certificate must hash to it; otherwise the caller is doing trust
   * on first use and must show the fingerprint to the user.
   */
  async connect(
    host: string,
    port: number,
    expectedDeviceId: string | null,
  ): Promise<PeerConnection> {
    if (expectedDeviceId) {
      const existing = this.get(expectedDeviceId);
      if (existing) return existing;
    }
    const socket = await this.openSocket(host, port);
    const remoteId = this.remoteId(socket);
    if (!remoteId) {
      socket.destroy();
      throw new PeerConnectError('tls', STAGE_MESSAGES.tls);
    }
    if (remoteId === this.localDeviceId) {
      socket.destroy();
      throw new PeerConnectError('self', STAGE_MESSAGES.self, remoteId);
    }
    if (expectedDeviceId && remoteId !== expectedDeviceId) {
      socket.destroy();
      this.options.logger.warn('peer.identity_mismatch', { host });
      throw new PeerConnectError('identity_mismatch', STAGE_MESSAGES.identity_mismatch, remoteId);
    }
    if (this.options.access(remoteId) === 'blocked') {
      socket.destroy();
      throw new PeerConnectError('protocol', 'This device is blocked.', remoteId);
    }
    const existing = this.get(remoteId);
    if (existing) {
      socket.destroy();
      return existing;
    }
    return this.handshake(
      new PeerConnection(
        socket,
        remoteId,
        'outbound',
        this.options.logger,
        this.options.connection,
      ),
    );
  }

  /** Layer-by-layer reachability check that never registers a connection. */
  async testConnection(host: string, port: number): Promise<ConnectionTestResult> {
    const started = Date.now();
    let socket: TLSSocket | null = null;
    try {
      socket = await this.openSocket(host, port);
      const remoteId = this.remoteId(socket);
      if (!remoteId) throw new PeerConnectError('tls', STAGE_MESSAGES.tls);
      if (remoteId === this.localDeviceId)
        throw new PeerConnectError('self', STAGE_MESSAGES.self, remoteId);
      await waitForHello(socket, this.options.handshakeTimeoutMs ?? 5000);
      return result('ok', remoteId, Date.now() - started);
    } catch (error) {
      if (error instanceof PeerConnectError) return result(error.stage, error.deviceId, null);
      return result('protocol', null, null);
    } finally {
      socket?.destroy();
    }
  }

  private tlsOptions() {
    return {
      key: this.options.credentials.keyPem,
      cert: this.options.credentials.certPem,
      minVersion: 'TLSv1.3' as const,
    };
  }

  private remoteId(socket: TLSSocket): string | null {
    const cert = socket.getPeerCertificate(true);
    if (!cert || !cert.raw) return null;
    return deviceIdFromCertificate(cert.raw);
  }

  private openSocket(host: string, port: number): Promise<TLSSocket> {
    const timeoutMs = this.options.connectTimeoutMs ?? 8000;
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        ...this.tlsOptions(),
        host,
        port,
        // Identity is checked by certificate hash, not by CA or host name.
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new PeerConnectError('tcp_timeout', STAGE_MESSAGES.tcp_timeout));
      }, timeoutMs);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        // Until a PeerConnection takes over (or the probe ends), swallow late resets.
        socket.on('error', () => undefined);
        resolve(socket);
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new PeerConnectError(classify(error), STAGE_MESSAGES[classify(error)]));
      });
    });
  }

  private onInbound(socket: TLSSocket): void {
    if (this.stopped) {
      socket.destroy();
      return;
    }
    const ip = normalizeAddress(socket.remoteAddress ?? '');
    if (!this.allowInbound(ip)) {
      this.options.logger.warn('peer.rate_limited');
      socket.destroy();
      return;
    }
    const remoteId = this.remoteId(socket);
    if (!remoteId || remoteId === this.localDeviceId) {
      socket.destroy();
      return;
    }
    const access = this.options.access(remoteId);
    if (access === 'blocked') {
      socket.destroy();
      return;
    }
    if (
      access === 'untrusted' &&
      this.untrustedCount() >= (this.options.maxUntrustedConnections ?? 32)
    ) {
      socket.destroy();
      return;
    }
    const conn = new PeerConnection(
      socket,
      remoteId,
      'inbound',
      this.options.logger,
      this.options.connection,
    );
    this.handshake(conn).catch(() => undefined);
  }

  private handshake(conn: PeerConnection): Promise<PeerConnection> {
    this.pending.add(conn);
    conn.send({ t: 'hello', app: 'meshtalk', protocol: PROTOCOL_VERSION, listenPort: this.port });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => conn.close('handshake_timeout'),
        this.options.handshakeTimeoutMs ?? 10_000,
      );
      timer.unref();
      const onClose = (reason: string) => {
        clearTimeout(timer);
        this.pending.delete(conn);
        reject(
          new PeerConnectError(
            'protocol',
            `${STAGE_MESSAGES.protocol} (${reason})`,
            conn.remoteDeviceId,
          ),
        );
      };
      conn.once('close', onClose);
      conn.once('message', (message) => {
        if (message.t !== 'hello') {
          conn.close('protocol_error');
          return;
        }
        clearTimeout(timer);
        conn.off('close', onClose);
        this.pending.delete(conn);
        if (this.stopped) {
          conn.close('shutdown');
          return;
        }
        conn.helloReceived = true;
        conn.remoteListenPort = message.listenPort;
        this.register(conn);
        // A simultaneous connection may have won the tie-break; hand back the survivor.
        resolve(this.get(conn.remoteDeviceId) ?? conn);
      });
    });
  }

  private register(conn: PeerConnection): void {
    const id = conn.remoteDeviceId;
    const existing = this.get(id);
    if (existing) {
      if (keepExisting(existing, conn, this.localDeviceId)) {
        conn.close('duplicate');
        return;
      }
      existing.removeAllListeners('close');
      existing.close('duplicate');
    }
    this.connections.set(id, conn);
    conn.on('message', (message) => {
      const access = this.options.access(id);
      if (access === 'blocked' || (access === 'untrusted' && !UNTRUSTED_ALLOWED.has(message.t))) {
        this.options.logger.warn('peer.unauthorized_message', { type: message.t });
        conn.close('unauthorized');
        return;
      }
      this.emit('message', id, message, conn);
    });
    conn.on('binary', (header, data) => {
      if (this.options.access(id) !== 'trusted') {
        conn.close('unauthorized');
        return;
      }
      this.emit('binary', id, header, data);
    });
    conn.once('close', (reason) => {
      if (this.connections.get(id) === conn) {
        this.connections.delete(id);
        this.emit('disconnected', id, reason);
      }
    });
    this.options.logger.info('peer.connected', { direction: conn.direction });
    this.emit('connected', conn);
  }

  private untrustedCount(): number {
    let count = this.pending.size;
    for (const id of this.connections.keys()) if (this.options.access(id) === 'untrusted') count++;
    return count;
  }

  private allowInbound(ip: string): boolean {
    const limit = this.options.maxInboundPerMinutePerIp ?? 30;
    const now = Date.now();
    const recent = (this.inboundAttempts.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.inboundAttempts.set(ip, recent);
    return recent.length <= limit;
  }
}

/**
 * When both sides connect simultaneously, both must keep the same link:
 * prefer the one initiated by the lower device ID; otherwise the newer one.
 */
export function keepExisting(
  existing: PeerConnection,
  incoming: PeerConnection,
  localId: string,
): boolean {
  const initiator = (c: PeerConnection) =>
    c.direction === 'outbound' ? localId : c.remoteDeviceId;
  const a = initiator(existing);
  const b = initiator(incoming);
  if (a === b) return false;
  return a < b;
}

function listen(server: tls.Server, port: number, host: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    const done = () => {
      server.off('error', onError);
      resolve();
    };
    if (host) server.listen(port, host, done);
    else server.listen(port, done);
  });
}

function waitForHello(socket: TLSSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.off('data', onData);
      reject(new PeerConnectError('protocol', STAGE_MESSAGES.protocol));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 5) return;
      const length = buffered.readUInt32BE(0);
      if (buffered.length < 4 + length) return;
      clearTimeout(timer);
      socket.off('data', onData);
      try {
        const msg = JSON.parse(buffered.subarray(5, 4 + length).toString('utf8')) as {
          t?: string;
          app?: string;
        };
        if (msg.t === 'hello' && msg.app === 'meshtalk') resolve();
        else reject(new PeerConnectError('protocol', STAGE_MESSAGES.protocol));
      } catch {
        reject(new PeerConnectError('protocol', STAGE_MESSAGES.protocol));
      }
    };
    socket.on('data', onData);
  });
}

function classify(error: NodeJS.ErrnoException): ConnectionTestStage {
  switch (error.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'dns';
    case 'ECONNREFUSED':
      return 'tcp_refused';
    case 'ETIMEDOUT':
      return 'tcp_timeout';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EADDRNOTAVAIL':
      return 'unreachable';
    default:
      return 'tls';
  }
}

function result(
  stage: ConnectionTestStage,
  deviceId: string | null,
  latencyMs: number | null,
): ConnectionTestResult {
  return {
    stage,
    message: STAGE_MESSAGES[stage],
    deviceId,
    fingerprint: deviceId ? formatFingerprint(deviceId) : null,
    latencyMs,
  };
}

export function stageMessage(stage: ConnectionTestStage): string {
  return STAGE_MESSAGES[stage];
}

/** Non-internal IPv4 addresses, for showing "connect to me at …". */
export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (!info.internal && info.family === 'IPv4') out.push(info.address);
    }
  }
  return out;
}
