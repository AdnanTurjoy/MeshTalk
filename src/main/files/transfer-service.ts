import { createHash, randomUUID, type Hash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fsyncSync, openSync, writeSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { AttachmentSummary, ChatMessage } from '../../shared/chat';
import type { AppEvent } from '../../shared/events';
import {
  AUTO_ACCEPT_VOICE_BYTES,
  MAX_FILE_BYTES,
  type StorageUsage,
  type TransferListItem,
  type TransferProgress,
  type TransferState,
} from '../../shared/files';
import type { ChatEventFile, ChatService } from '../chat/chat-service';
import type { AppDatabase } from '../db/connection';
import { contacts, conversations, files, transfers } from '../db/schema';
import { UserFacingError } from '../errors';
import type { Logger } from '../logger';
import type { PeerService } from '../peer/peer-service';
import type { WireMessage } from '../peer/wire';
import { isExecutableName, previewMime, sanitizeFilename } from './filename';
import { chunkHeaderSchema } from './transfer-wire';

export const CHUNK_BYTES = 512 * 1024;
/** Persist progress at least this often, so a crash loses little. */
const PERSIST_EVERY_BYTES = 8 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
/** Keep this much disk free beyond the file itself. */
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

type FileRow = typeof files.$inferSelect;
type TransferRow = typeof transfers.$inferSelect;

export class TransferError extends UserFacingError {
  override name = 'TransferError';
}

interface Receiving {
  fileId: string;
  from: string;
  fd: number;
  hash: Hash;
  offset: number;
  size: number;
  persistedAt: number;
}

interface Sending {
  aborted: boolean;
}

export interface TransferServiceDeps {
  db: AppDatabase;
  sqlite: Database.Database;
  peers: PeerService;
  chat: ChatService;
  logger: Logger;
  emit(event: AppEvent): void;
  /** Root of managed file storage (<userData>/files). */
  filesDir: string;
  freeSpace?: (dir: string) => Promise<number | null>;
  /** Maximum bytes received files may occupy; null = no limit. */
  quotaBytes?: () => number | null;
  now?: () => number;
}

/**
 * Direct file transfer over PeerLink (ADR-0003).
 *
 * The sender offers a file inside a chat message (name, size, SHA-256). The
 * receiver accepts explicitly (voice notes are auto-accepted) and pulls bytes
 * with `file_req {offset}`; every chunk carries its own SHA-256 and is written
 * sequentially to `partial/<id>.part`. When the last byte arrives the whole
 * file hash is checked and the file is atomically renamed into
 * `received/<id>/<sanitized name>`. Resume re-requests from the last byte
 * written. Nothing is ever uploaded anywhere else, and nothing is opened.
 */
export class TransferService {
  private readonly now: () => number;
  private readonly receiving = new Map<string, Receiving>();
  private readonly sending = new Map<string, Sending>();
  private readonly lastProgress = new Map<
    string,
    { at: number; bytes: number; rate: number | null }
  >();

  constructor(private readonly deps: TransferServiceDeps) {
    this.now = deps.now ?? Date.now;
    deps.chat.onIncomingFile = (from, conversationId, messageId, file, kind) =>
      this.registerIncoming(from, conversationId, messageId, file, kind);
    deps.chat.attachmentSummary = (fileId) => this.summary(fileId);
    deps.peers.on('message', (from, msg) => this.onMessage(from, msg));
    deps.peers.on('binary', (from, header, data) => this.onChunk(from, header, data));
    deps.peers.on('connected', (conn) => this.onConnected(conn.remoteDeviceId));
    deps.peers.on('disconnected', (id) => this.onDisconnected(id));
    // Anything that was moving when the app stopped resumes when the peer is back.
    deps.db
      .update(transfers)
      .set({ state: 'waiting' })
      .where(eq(transfers.state, 'transferring'))
      .run();
  }

  // ------------------------------------------------------------- sending

  /** Offers a file on disk. The original stays where it is and is re-read on resume. */
  async sendPath(
    conversationId: string,
    sourcePath: string,
    kind: 'file' | 'voice' = 'file',
  ): Promise<ChatMessage> {
    let info;
    try {
      info = await stat(sourcePath);
    } catch {
      throw new TransferError('That file could not be read.');
    }
    if (!info.isFile())
      throw new TransferError(
        'Only regular files can be sent. Folders are not supported; zip them first.',
      );
    if (info.size > MAX_FILE_BYTES)
      throw new TransferError('That file is larger than MeshTalk’s 20 GB limit.');
    const sha256 = await hashFile(sourcePath);
    const name = sanitizeFilename(sourcePath.split(/[\\/]/).pop() ?? 'file');
    return this.offer(conversationId, {
      name,
      size: info.size,
      mime: previewMime(name) ?? 'application/octet-stream',
      sha256,
      durationMs: null,
      kind,
      sourcePath,
      sourceMtime: Math.floor(info.mtimeMs),
      storedPath: null,
    });
  }

  /** Offers bytes created in the app (voice notes, pasted images), stored in managed storage. */
  async sendBytes(
    conversationId: string,
    rawName: string,
    mime: string,
    kind: 'file' | 'voice',
    durationMs: number | null,
    data: Uint8Array,
  ): Promise<ChatMessage> {
    const fileId = randomUUID();
    const name = sanitizeFilename(rawName);
    const rel = join('outgoing', fileId, name);
    const abs = this.abs(rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
    return this.offer(
      conversationId,
      {
        name,
        size: data.byteLength,
        mime: previewMime(name) ?? mime,
        sha256: createHash('sha256').update(data).digest('hex'),
        durationMs,
        kind,
        sourcePath: abs,
        sourceMtime: Math.floor((await stat(abs)).mtimeMs),
        storedPath: rel,
      },
      fileId,
    );
  }

  private offer(
    conversationId: string,
    f: {
      name: string;
      size: number;
      mime: string;
      sha256: string;
      durationMs: number | null;
      kind: 'file' | 'voice';
      sourcePath: string;
      sourceMtime: number;
      storedPath: string | null;
    },
    fileId: string = randomUUID(),
  ): ChatMessage {
    const now = this.now();
    this.deps.db
      .insert(files)
      .values({
        id: fileId,
        messageId: '',
        conversationId,
        direction: 'outgoing',
        name: f.name,
        size: f.size,
        mime: f.mime,
        sha256: f.sha256,
        durationMs: f.durationMs,
        sourcePath: f.sourcePath,
        sourceMtime: f.sourceMtime,
        storedPath: f.storedPath,
        createdAt: now,
      })
      .run();
    let message: ChatMessage;
    try {
      message = this.deps.chat.send(conversationId, '', null, {
        kind: f.kind,
        attachmentId: fileId,
        file: {
          fileId,
          name: f.name,
          size: f.size,
          mime: f.mime,
          sha256: f.sha256,
          durationMs: f.durationMs,
        },
      });
    } catch (error) {
      this.deps.db.delete(files).where(eq(files.id, fileId)).run();
      throw error;
    }
    const conversation = this.deps.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    this.deps.sqlite.transaction(() => {
      this.deps.db.update(files).set({ messageId: message.id }).where(eq(files.id, fileId)).run();
      for (const peer of conversation ? this.deps.chat.recipients(conversation) : []) {
        this.deps.db
          .insert(transfers)
          .values({
            fileId,
            peerDeviceId: peer,
            direction: 'outgoing',
            state: 'offered',
            updatedAt: now,
          })
          .run();
      }
    })();
    this.filesChanged(conversationId);
    return this.deps.chat.getMessage(message.id) ?? message;
  }

  private async startSending(fileId: string, to: string, offset: number): Promise<void> {
    const key = `${fileId}|${to}`;
    const previous = this.sending.get(key);
    if (previous) previous.aborted = true;
    const file = this.file(fileId);
    const transfer = this.transfer(fileId, to);
    if (!file || file.direction !== 'outgoing' || !transfer) return;
    if (
      transfer.state === 'cancelled' ||
      transfer.state === 'declined' ||
      transfer.state === 'complete'
    )
      return;
    const source = file.sourcePath;
    if (!source || offset > file.size) {
      this.deps.peers.send(to, {
        t: 'file_error',
        fileId,
        reason: 'The file is no longer available.',
      });
      this.setTransfer(fileId, to, { state: 'failed', error: 'The file is no longer available.' });
      return;
    }
    try {
      const info = await stat(source);
      if (info.size !== file.size || Math.floor(info.mtimeMs) !== file.sourceMtime)
        throw new Error('changed');
    } catch {
      const reason = 'The file was moved, deleted or changed on the sender’s computer.';
      this.deps.peers.send(to, { t: 'file_error', fileId, reason });
      this.setTransfer(fileId, to, { state: 'failed', error: reason });
      return;
    }

    const job: Sending = { aborted: false };
    this.sending.set(key, job);
    this.setTransfer(fileId, to, { state: 'transferring', bytesDone: offset, error: null });
    const fh = await open(source, 'r');
    try {
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let position = offset;
      while (position < file.size && !job.aborted) {
        const conn = this.deps.peers.get(to);
        if (!conn) throw new Error('disconnected');
        const { bytesRead } = await fh.read(
          buffer,
          0,
          Math.min(CHUNK_BYTES, file.size - position),
          position,
        );
        if (bytesRead === 0) throw new Error('short read');
        const chunk = buffer.subarray(0, bytesRead);
        const h = createHash('sha256').update(chunk).digest('hex');
        await conn.sendBinary({ f: fileId, o: position, h }, chunk);
        position += bytesRead;
        this.progress(fileId, to, 'outgoing', 'transferring', position, file.size, false);
        if (position - (this.transfer(fileId, to)?.bytesDone ?? 0) >= PERSIST_EVERY_BYTES) {
          this.deps.db
            .update(transfers)
            .set({ bytesDone: position, updatedAt: this.now() })
            .where(and(eq(transfers.fileId, fileId), eq(transfers.peerDeviceId, to)))
            .run();
        }
      }
      if (!job.aborted) {
        // Bytes are sent; completion is confirmed by the receiver's file_done.
        this.deps.db
          .update(transfers)
          .set({ bytesDone: position, updatedAt: this.now() })
          .where(and(eq(transfers.fileId, fileId), eq(transfers.peerDeviceId, to)))
          .run();
      }
    } catch (error) {
      if (!job.aborted) {
        this.deps.logger.info('transfer.send_interrupted', { reason: (error as Error).message });
        const current = this.transfer(fileId, to);
        if (current?.state === 'transferring') this.setTransfer(fileId, to, { state: 'waiting' });
      }
    } finally {
      await fh.close();
      if (this.sending.get(key) === job) this.sending.delete(key);
    }
  }

  // ----------------------------------------------------------- receiving

  private registerIncoming(
    from: string,
    conversationId: string,
    messageId: string,
    file: ChatEventFile,
    kind: 'text' | 'file' | 'voice',
  ): string | null {
    if (this.file(file.fileId)) return file.fileId;
    const now = this.now();
    const name = sanitizeFilename(file.name);
    this.deps.db
      .insert(files)
      .values({
        id: file.fileId,
        messageId,
        conversationId,
        direction: 'incoming',
        name,
        size: file.size,
        // Never trust the sender's MIME type for anything that renders.
        mime: previewMime(name) ?? 'application/octet-stream',
        sha256: file.sha256,
        durationMs: file.durationMs,
        createdAt: now,
      })
      .run();
    this.deps.db
      .insert(transfers)
      .values({
        fileId: file.fileId,
        peerDeviceId: from,
        direction: 'incoming',
        state: 'offered',
        updatedAt: now,
      })
      .run();
    if (kind === 'voice' && file.size <= AUTO_ACCEPT_VOICE_BYTES) {
      setTimeout(() => void this.accept(file.fileId).catch(() => undefined), 0);
    }
    return file.fileId;
  }

  /** Accepts (or retries) an incoming file. */
  async accept(fileId: string): Promise<void> {
    const file = this.requireIncoming(fileId);
    const transfer = this.incomingTransfer(fileId);
    if (!transfer) throw new TransferError('Transfer not found.');
    if (transfer.state === 'complete') return;
    if (file.size > MAX_FILE_BYTES)
      throw new TransferError('That file is larger than MeshTalk’s 20 GB limit.');
    const free = await (this.deps.freeSpace ?? defaultFreeSpace)(this.deps.filesDir);
    const remaining = file.size - transfer.bytesDone;
    if (free !== null && free < remaining + FREE_SPACE_MARGIN) {
      throw new TransferError(
        'There isn’t enough free disk space for this file. Free up space and try again.',
      );
    }
    const quota = this.deps.quotaBytes?.() ?? null;
    if (quota !== null) {
      const used = this.deps.sqlite
        .prepare(
          "SELECT coalesce(sum(size), 0) FROM files WHERE direction = 'incoming' AND stored_path IS NOT NULL AND removed_at IS NULL",
        )
        .pluck()
        .get() as number;
      if (used + remaining > quota) {
        throw new TransferError(
          'This file would go over your storage limit for received files. Remove some files in Files, or raise the limit in Settings.',
        );
      }
    }

    // Already have identical bytes? Copy locally instead of transferring.
    const twin = this.deps.db
      .select()
      .from(files)
      .where(
        and(eq(files.sha256, file.sha256), isNotNull(files.storedPath), isNull(files.removedAt)),
      )
      .all()
      .find((f) => f.id !== fileId && f.storedPath && existsSync(this.abs(f.storedPath)));
    if (twin?.storedPath) {
      const rel = join('received', fileId, file.name);
      await mkdir(dirname(this.abs(rel)), { recursive: true });
      await copyFile(this.abs(twin.storedPath), this.abs(rel));
      this.complete(file, transfer.peerDeviceId, rel);
      return;
    }

    if (
      transfer.state === 'failed' ||
      transfer.state === 'cancelled' ||
      transfer.state === 'declined'
    ) {
      await rm(this.partPath(fileId), { force: true });
      this.setTransfer(fileId, transfer.peerDeviceId, { bytesDone: 0 });
    }
    this.setTransfer(fileId, transfer.peerDeviceId, { state: 'waiting', error: null });
    await this.startReceiving(fileId);
  }

  decline(fileId: string): void {
    const transfer = this.incomingTransfer(fileId);
    if (!transfer || transfer.state !== 'offered')
      throw new TransferError('This file can no longer be declined.');
    this.setTransfer(fileId, transfer.peerDeviceId, { state: 'declined' });
    this.deps.peers.send(transfer.peerDeviceId, { t: 'file_decline', fileId });
  }

  pause(fileId: string): void {
    const transfer = this.incomingTransfer(fileId);
    if (!transfer || (transfer.state !== 'transferring' && transfer.state !== 'waiting')) return;
    this.stopReceiving(fileId);
    this.setTransfer(fileId, transfer.peerDeviceId, { state: 'paused' });
    this.deps.peers.send(transfer.peerDeviceId, { t: 'file_pause', fileId });
  }

  async resume(fileId: string): Promise<void> {
    const transfer = this.incomingTransfer(fileId);
    if (!transfer || transfer.state !== 'paused') return;
    this.setTransfer(fileId, transfer.peerDeviceId, { state: 'waiting' });
    await this.startReceiving(fileId);
  }

  /** Cancels every unfinished transfer of this file, on either side. */
  async cancel(fileId: string): Promise<void> {
    const file = this.file(fileId);
    if (!file) throw new TransferError('File not found.');
    for (const t of this.transfersOf(fileId)) {
      if (t.state === 'complete' || t.state === 'cancelled' || t.state === 'declined') continue;
      const job = this.sending.get(`${fileId}|${t.peerDeviceId}`);
      if (job) job.aborted = true;
      this.deps.peers.send(t.peerDeviceId, { t: 'file_cancel', fileId, reason: 'Cancelled' });
      this.setTransfer(fileId, t.peerDeviceId, { state: 'cancelled' });
    }
    if (file.direction === 'incoming') {
      this.stopReceiving(fileId);
      await rm(this.partPath(fileId), { force: true });
    }
  }

  private async startReceiving(fileId: string): Promise<void> {
    const file = this.file(fileId);
    const transfer = this.incomingTransfer(fileId);
    if (!file || !transfer || transfer.state !== 'waiting') return;
    if (!this.deps.peers.isConnected(transfer.peerDeviceId)) return; // resumes on connect
    if (this.receiving.has(fileId)) return;

    const part = this.partPath(fileId);
    await mkdir(dirname(part), { recursive: true });
    // Rebuild the running hash from what is already on disk (resume).
    const hash = createHash('sha256');
    let offset = 0;
    if (existsSync(part)) {
      const onDisk = (await stat(part)).size;
      // Every byte on disk passed its chunk hash before it was written, so resume from the end.
      offset = Math.min(onDisk, file.size);
      await new Promise<void>((res, rej) => {
        if (offset === 0) return res();
        createReadStream(part, { start: 0, end: offset - 1 })
          .on('data', (c) => hash.update(c))
          .on('end', () => res())
          .on('error', rej);
      });
    }
    const current = this.incomingTransfer(fileId);
    if (current?.state !== 'waiting' || this.receiving.has(fileId)) return;
    const fd = openSync(part, existsSync(part) ? 'r+' : 'w');
    this.receiving.set(fileId, {
      fileId,
      from: transfer.peerDeviceId,
      fd,
      hash,
      offset,
      size: file.size,
      persistedAt: offset,
    });
    this.setTransfer(fileId, transfer.peerDeviceId, { state: 'transferring', bytesDone: offset });
    if (offset === file.size) {
      this.finishReceiving(fileId);
      return;
    }
    this.deps.peers.send(transfer.peerDeviceId, { t: 'file_req', fileId, offset });
  }

  private onChunk(from: string, header: unknown, data: Buffer): void {
    const parsed = chunkHeaderSchema.safeParse(header);
    if (!parsed.success) return;
    const { f: fileId, o: offset, h } = parsed.data;
    const rx = this.receiving.get(fileId);
    if (!rx || rx.from !== from) return; // not expecting this (paused, cancelled, or unsolicited)
    if (offset !== rx.offset) return; // stale chunk from before a pause/resume
    if (
      rx.offset + data.length > rx.size ||
      createHash('sha256').update(data).digest('hex') !== h
    ) {
      void this.failReceiving(fileId, 'The file was damaged in transit. Try again.');
      return;
    }
    writeSync(rx.fd, data, 0, data.length, offset);
    rx.hash.update(data);
    rx.offset += data.length;
    if (rx.offset - rx.persistedAt >= PERSIST_EVERY_BYTES) {
      rx.persistedAt = rx.offset;
      this.deps.db
        .update(transfers)
        .set({ bytesDone: rx.offset, updatedAt: this.now() })
        .where(and(eq(transfers.fileId, fileId), eq(transfers.peerDeviceId, from)))
        .run();
    }
    this.progress(fileId, from, 'incoming', 'transferring', rx.offset, rx.size, false);
    if (rx.offset === rx.size) this.finishReceiving(fileId);
  }

  private finishReceiving(fileId: string): void {
    const rx = this.receiving.get(fileId);
    const file = this.file(fileId);
    if (!rx || !file) return;
    fsyncSync(rx.fd);
    closeSync(rx.fd);
    this.receiving.delete(fileId);
    if (rx.hash.digest('hex') !== file.sha256) {
      void this.failReceiving(
        fileId,
        'The received file did not match what was sent. It was discarded.',
      );
      return;
    }
    const rel = join('received', fileId, file.name);
    void (async () => {
      try {
        await mkdir(dirname(this.abs(rel)), { recursive: true });
        await rename(this.partPath(fileId), this.abs(rel));
        this.complete(file, rx.from, rel);
      } catch (error) {
        this.deps.logger.error('transfer.finalize_failed', { error });
        await this.failReceiving(fileId, 'The file could not be saved.');
      }
    })();
  }

  private complete(file: FileRow, from: string, rel: string): void {
    this.deps.db.update(files).set({ storedPath: rel }).where(eq(files.id, file.id)).run();
    this.setTransfer(file.id, from, { state: 'complete', bytesDone: file.size, error: null });
    this.deps.peers.send(from, { t: 'file_done', fileId: file.id });
  }

  private async failReceiving(fileId: string, reason: string): Promise<void> {
    const transfer = this.incomingTransfer(fileId);
    this.stopReceiving(fileId);
    await rm(this.partPath(fileId), { force: true });
    if (transfer) {
      this.setTransfer(fileId, transfer.peerDeviceId, {
        state: 'failed',
        error: reason,
        bytesDone: 0,
      });
      this.deps.peers.send(transfer.peerDeviceId, {
        t: 'file_cancel',
        fileId,
        reason: 'Verification failed',
      });
    }
  }

  private stopReceiving(fileId: string): void {
    const rx = this.receiving.get(fileId);
    if (!rx) return;
    this.receiving.delete(fileId);
    try {
      fsyncSync(rx.fd);
      closeSync(rx.fd);
    } catch {
      // already closed
    }
    this.deps.db
      .update(transfers)
      .set({ bytesDone: rx.offset, updatedAt: this.now() })
      .where(and(eq(transfers.fileId, fileId), eq(transfers.peerDeviceId, rx.from)))
      .run();
  }

  // ------------------------------------------------------------- events

  private onMessage(from: string, msg: WireMessage): void {
    switch (msg.t) {
      case 'file_req':
        void this.startSending(msg.fileId, from, msg.offset);
        return;
      case 'file_pause': {
        const job = this.sending.get(`${msg.fileId}|${from}`);
        if (job) job.aborted = true;
        if (this.transfer(msg.fileId, from)?.direction === 'outgoing')
          this.setTransfer(msg.fileId, from, { state: 'paused' });
        return;
      }
      case 'file_decline':
        if (this.transfer(msg.fileId, from)?.direction === 'outgoing')
          this.setTransfer(msg.fileId, from, { state: 'declined' });
        return;
      case 'file_done': {
        const t = this.transfer(msg.fileId, from);
        const f = this.file(msg.fileId);
        if (t?.direction === 'outgoing' && f)
          this.setTransfer(msg.fileId, from, { state: 'complete', bytesDone: f.size });
        return;
      }
      case 'file_cancel': {
        const t = this.transfer(msg.fileId, from);
        if (!t || t.state === 'complete') return;
        const job = this.sending.get(`${msg.fileId}|${from}`);
        if (job) job.aborted = true;
        if (t.direction === 'incoming') {
          this.stopReceiving(msg.fileId);
          void rm(this.partPath(msg.fileId), { force: true });
        }
        this.setTransfer(msg.fileId, from, {
          state: 'cancelled',
          error: 'Cancelled by the other person.',
        });
        return;
      }
      case 'file_error': {
        const t = this.transfer(msg.fileId, from);
        if (t?.direction !== 'incoming' || t.state === 'complete') return;
        this.stopReceiving(msg.fileId);
        this.setTransfer(msg.fileId, from, { state: 'failed', error: msg.reason });
        return;
      }
      default:
        return;
    }
  }

  private onConnected(peer: string): void {
    const waiting = this.deps.db
      .select()
      .from(transfers)
      .where(
        and(
          eq(transfers.peerDeviceId, peer),
          eq(transfers.direction, 'incoming'),
          eq(transfers.state, 'waiting'),
        ),
      )
      .all();
    for (const t of waiting) void this.startReceiving(t.fileId);
  }

  private onDisconnected(peer: string): void {
    for (const rx of [...this.receiving.values()]) {
      if (rx.from === peer) {
        this.stopReceiving(rx.fileId);
        this.setTransfer(rx.fileId, peer, { state: 'waiting' });
      }
    }
    for (const t of this.deps.db
      .select()
      .from(transfers)
      .where(and(eq(transfers.peerDeviceId, peer), eq(transfers.state, 'transferring')))
      .all()) {
      this.setTransfer(t.fileId, peer, { state: 'waiting' });
    }
  }

  // ------------------------------------------------------------- queries

  summary(fileId: string): AttachmentSummary | null {
    const file = this.file(fileId);
    if (!file) return null;
    const list = this.transfersOf(fileId);
    let state: TransferState;
    let bytesDone: number;
    let error: string | null = null;
    if (file.direction === 'incoming') {
      const t = list[0];
      state = t?.state ?? 'failed';
      bytesDone = this.receiving.get(fileId)?.offset ?? t?.bytesDone ?? 0;
      error = t?.error ?? null;
    } else if (list.length === 0) {
      state = 'complete';
      bytesDone = file.size;
    } else {
      const order: TransferState[] = [
        'transferring',
        'waiting',
        'paused',
        'offered',
        'failed',
        'cancelled',
        'declined',
        'complete',
      ];
      state = order.find((s) => list.some((t) => t.state === s)) ?? 'complete';
      const relevant = list.filter((t) => t.state === state);
      bytesDone = Math.min(...relevant.map((t) => t.bytesDone));
      error = relevant.find((t) => t.error)?.error ?? null;
    }
    const mime = previewMime(file.name);
    const available =
      file.removedAt === null &&
      (file.direction === 'outgoing'
        ? file.sourcePath !== null
        : state === 'complete' && file.storedPath !== null);
    return {
      fileId,
      name: file.name,
      size: file.size,
      mime: file.mime,
      durationMs: file.durationMs,
      state,
      bytesDone,
      direction: file.direction,
      // Voice notes (WebM/Opus) always carry a duration; treat them as audio.
      previewKind:
        file.durationMs !== null && mime
          ? 'audio'
          : mime
            ? (mime.split('/')[0] as 'image' | 'audio' | 'video')
            : null,
      executable: isExecutableName(file.name),
      error: file.removedAt ? 'Removed from this device.' : error,
      available,
    };
  }

  list(): TransferListItem[] {
    const rows = this.deps.db.select().from(transfers).all();
    const out: TransferListItem[] = [];
    for (const t of rows) {
      const f = this.file(t.fileId);
      if (!f) continue;
      const peer = this.deps.db
        .select({ name: contacts.displayName })
        .from(contacts)
        .where(eq(contacts.deviceId, t.peerDeviceId))
        .get();
      out.push({
        fileId: t.fileId,
        peerDeviceId: t.peerDeviceId,
        direction: t.direction,
        state: t.state,
        bytesDone: this.receiving.get(t.fileId)?.offset ?? t.bytesDone,
        size: f.size,
        bytesPerSecond: this.lastProgress.get(`${t.fileId}|${t.peerDeviceId}`)?.rate ?? null,
        name: f.name,
        conversationId: f.conversationId,
        messageId: f.messageId,
        peerName: peer?.name ?? `Device ${t.peerDeviceId.slice(0, 7)}`,
        error: t.error,
        updatedAt: t.updatedAt,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Absolute path of a complete, previewable file, for the meshtalk-file:// protocol. */
  previewSource(fileId: string): { path: string; mime: string } | null {
    const file = this.file(fileId);
    if (!file || file.removedAt) return null;
    const mime = previewMime(file.name);
    if (!mime) return null;
    const path = this.localPath(file);
    return path ? { path, mime } : null;
  }

  /** Where the bytes of a complete file are on this device, if anywhere. */
  localPath(file: FileRow): string | null {
    if (file.removedAt) return null;
    if (file.storedPath) return this.abs(file.storedPath);
    if (file.direction === 'outgoing' && file.sourcePath && existsSync(file.sourcePath))
      return file.sourcePath;
    return null;
  }

  pathForUser(fileId: string): { path: string; name: string; executable: boolean } {
    const file = this.file(fileId);
    const path = file ? this.localPath(file) : null;
    if (!file || !path || !existsSync(path))
      throw new TransferError('This file is not available on this device.');
    return { path, name: file.name, executable: isExecutableName(file.name) };
  }

  async usage(): Promise<StorageUsage> {
    const rows = this.deps.db
      .select()
      .from(files)
      .where(and(isNotNull(files.storedPath), isNull(files.removedAt)))
      .all();
    let received = 0;
    let sent = 0;
    for (const f of rows) {
      if (f.direction === 'incoming') received += f.size;
      else sent += f.size;
    }
    let partial = 0;
    try {
      for (const name of await readdir(join(this.deps.filesDir, 'partial'))) {
        partial += (await stat(join(this.deps.filesDir, 'partial', name))).size;
      }
    } catch {
      // no partial folder yet
    }
    const titles = new Map<string, string>();
    const largest = [...rows]
      .sort((a, b) => b.size - a.size)
      .slice(0, 20)
      .map((f) => {
        if (!titles.has(f.conversationId)) {
          try {
            titles.set(f.conversationId, this.deps.chat.getConversation(f.conversationId).title);
          } catch {
            titles.set(f.conversationId, 'Unknown');
          }
        }
        return {
          fileId: f.id,
          name: f.name,
          size: f.size,
          direction: f.direction,
          conversationTitle: titles.get(f.conversationId) ?? '',
        };
      });
    return {
      receivedBytes: received,
      sentCopiesBytes: sent,
      partialBytes: partial,
      databaseBytes: 0,
      freeBytes: await (this.deps.freeSpace ?? defaultFreeSpace)(this.deps.filesDir),
      largest,
    };
  }

  /** Deletes the local copy of a file; the message stays, marked as removed. */
  async remove(fileId: string): Promise<void> {
    const file = this.file(fileId);
    if (!file) throw new TransferError('File not found.');
    await this.cancel(fileId).catch(() => undefined);
    if (file.storedPath)
      await rm(dirname(this.abs(file.storedPath)), { recursive: true, force: true });
    this.deps.db
      .update(files)
      .set({ storedPath: null, removedAt: this.now() })
      .where(eq(files.id, fileId))
      .run();
    this.filesChanged(file.conversationId);
  }

  /** Removes leftovers of transfers that will not resume. */
  async clearPartial(): Promise<number> {
    const dead = this.deps.db
      .select()
      .from(transfers)
      .where(
        and(
          eq(transfers.direction, 'incoming'),
          inArray(transfers.state, ['failed', 'cancelled', 'declined']),
        ),
      )
      .all();
    let removed = 0;
    for (const t of dead) {
      const p = this.partPath(t.fileId);
      if (existsSync(p)) {
        await rm(p, { force: true });
        removed++;
      }
    }
    this.deps.emit({ type: 'files-changed' });
    return removed;
  }

  stop(): void {
    for (const job of this.sending.values()) job.aborted = true;
    for (const id of [...this.receiving.keys()]) this.stopReceiving(id);
  }

  // ------------------------------------------------------------- helpers

  private progress(
    fileId: string,
    peer: string,
    direction: 'incoming' | 'outgoing',
    state: TransferState,
    bytesDone: number,
    size: number,
    force: boolean,
  ): void {
    const key = `${fileId}|${peer}`;
    const now = this.now();
    const last = this.lastProgress.get(key);
    if (!force && last && now - last.at < PROGRESS_INTERVAL_MS && bytesDone < size) return;
    let rate = last?.rate ?? null;
    if (last && now > last.at && bytesDone >= last.bytes) {
      const instant = ((bytesDone - last.bytes) * 1000) / (now - last.at);
      rate = rate === null ? instant : rate * 0.7 + instant * 0.3;
    }
    this.lastProgress.set(key, { at: now, bytes: bytesDone, rate });
    const progress: TransferProgress = {
      fileId,
      peerDeviceId: peer,
      direction,
      state,
      bytesDone,
      size,
      bytesPerSecond: rate,
    };
    this.deps.emit({ type: 'transfer-progress', progress });
  }

  private setTransfer(fileId: string, peer: string, fields: Partial<TransferRow>): void {
    this.deps.db
      .update(transfers)
      .set({ ...fields, updatedAt: this.now() })
      .where(and(eq(transfers.fileId, fileId), eq(transfers.peerDeviceId, peer)))
      .run();
    const t = this.transfer(fileId, peer);
    const f = this.file(fileId);
    if (t && f) {
      if (t.state !== 'transferring') this.lastProgress.delete(`${fileId}|${peer}`);
      this.progress(fileId, peer, t.direction, t.state, t.bytesDone, f.size, true);
      this.filesChanged(f.conversationId);
    }
  }

  private filesChanged(conversationId: string): void {
    this.deps.emit({ type: 'files-changed' });
    this.deps.emit({ type: 'messages-changed', conversationId });
  }

  private file(id: string): FileRow | undefined {
    return this.deps.db.select().from(files).where(eq(files.id, id)).get();
  }

  private requireIncoming(id: string): FileRow {
    const f = this.file(id);
    if (!f || f.direction !== 'incoming') throw new TransferError('File not found.');
    return f;
  }

  private transfer(fileId: string, peer: string): TransferRow | undefined {
    return this.deps.db
      .select()
      .from(transfers)
      .where(and(eq(transfers.fileId, fileId), eq(transfers.peerDeviceId, peer)))
      .get();
  }

  private incomingTransfer(fileId: string): TransferRow | undefined {
    return this.deps.db
      .select()
      .from(transfers)
      .where(and(eq(transfers.fileId, fileId), eq(transfers.direction, 'incoming')))
      .get();
  }

  private transfersOf(fileId: string): TransferRow[] {
    return this.deps.db.select().from(transfers).where(eq(transfers.fileId, fileId)).all();
  }

  private partPath(fileId: string): string {
    return this.abs(join('partial', `${fileId}.part`));
  }

  /** Resolves a path inside the managed folder; refuses anything that escapes it. */
  private abs(rel: string): string {
    const root = resolve(this.deps.filesDir);
    const full = resolve(root, rel);
    if (full !== root && !full.startsWith(root + sep))
      throw new Error('Path escapes managed storage');
    if (relative(root, full).startsWith('..')) throw new Error('Path escapes managed storage');
    return full;
  }
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((res, rej) => {
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('end', () => res())
      .on('error', rej);
  });
  return hash.digest('hex');
}

async function defaultFreeSpace(dir: string): Promise<number | null> {
  try {
    await mkdir(dir, { recursive: true });
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}
