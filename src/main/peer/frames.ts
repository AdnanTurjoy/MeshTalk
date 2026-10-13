/**
 * PeerLink framing: `[u32 length][u8 kind][payload]`, big-endian.
 *  kind 1: UTF-8 JSON message
 *  kind 2: binary: `[u32 headerLength][header JSON][bytes]` (file chunks)
 */
export const FRAME_JSON = 1;
export const FRAME_BINARY = 2;
export const MAX_JSON_BYTES = 256 * 1024;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export type Frame =
  | { kind: typeof FRAME_JSON; json: unknown }
  | { kind: typeof FRAME_BINARY; header: unknown; data: Buffer };

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

export function encodeJsonFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_JSON_BYTES) throw new FrameError('JSON frame too large');
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out.writeUInt8(FRAME_JSON, 4);
  body.copy(out, 5);
  return out;
}

export function encodeBinaryFrame(header: unknown, data: Uint8Array): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  if (head.length > MAX_JSON_BYTES) throw new FrameError('Binary frame header too large');
  const length = 1 + 4 + head.length + data.length;
  if (length > MAX_FRAME_BYTES) throw new FrameError('Binary frame too large');
  const out = Buffer.allocUnsafe(4 + length);
  out.writeUInt32BE(length, 0);
  out.writeUInt8(FRAME_BINARY, 4);
  out.writeUInt32BE(head.length, 5);
  head.copy(out, 9);
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 9 + head.length);
  return out;
}

/** Incremental decoder; throws FrameError on anything malformed or oversized. */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Buffer): Frame[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const frames: Frame[] = [];
    for (;;) {
      if (this.buffered < 4) break;
      const head = this.peek(4);
      const length = head.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES)
        throw new FrameError(`Invalid frame length ${length}`);
      if (this.buffered < 4 + length) break;
      const frame = this.take(4 + length).subarray(4);
      frames.push(parse(frame));
    }
    return frames;
  }

  private peek(n: number): Buffer {
    if (this.chunks[0] && this.chunks[0].length >= n) return this.chunks[0];
    const merged = Buffer.concat(this.chunks);
    this.chunks = [merged];
    return merged;
  }

  private take(n: number): Buffer {
    const merged = this.peek(n);
    const out = merged.subarray(0, n);
    const rest = merged.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.buffered -= n;
    return out;
  }
}

function parse(frame: Buffer): Frame {
  const kind = frame.readUInt8(0);
  if (kind === FRAME_JSON) {
    if (frame.length - 1 > MAX_JSON_BYTES) throw new FrameError('JSON frame too large');
    return { kind, json: parseJson(frame.subarray(1)) };
  }
  if (kind === FRAME_BINARY) {
    if (frame.length < 5) throw new FrameError('Truncated binary frame');
    const headLength = frame.readUInt32BE(1);
    if (headLength > MAX_JSON_BYTES || 5 + headLength > frame.length) {
      throw new FrameError('Invalid binary header length');
    }
    return {
      kind,
      header: parseJson(frame.subarray(5, 5 + headLength)),
      data: Buffer.from(frame.subarray(5 + headLength)),
    };
  }
  throw new FrameError(`Unknown frame kind ${kind}`);
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new FrameError('Malformed JSON frame');
  }
}
