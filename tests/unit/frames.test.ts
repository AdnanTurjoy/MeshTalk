import { describe, expect, it } from 'vitest';
import {
  encodeBinaryFrame,
  encodeJsonFrame,
  FrameDecoder,
  FrameError,
  MAX_FRAME_BYTES,
} from '../../src/main/peer/frames';

describe('FrameDecoder', () => {
  it('round-trips JSON and binary frames split across arbitrary chunks', () => {
    const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    const wire = Buffer.concat([
      encodeJsonFrame({ t: 'hello', n: 1 }),
      encodeBinaryFrame({ chunk: 3 }, data),
      encodeJsonFrame({ t: 'ping' }),
    ]);
    const decoder = new FrameDecoder();
    const frames = [];
    for (let i = 0; i < wire.length; i += 7) frames.push(...decoder.push(wire.subarray(i, i + 7)));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({ kind: 1, json: { t: 'hello', n: 1 } });
    expect(frames[1]).toMatchObject({ kind: 2, header: { chunk: 3 } });
    expect(frames[1]?.kind === 2 && frames[1].data.equals(data)).toBe(true);
    expect(frames[2]).toEqual({ kind: 1, json: { t: 'ping' } });
  });

  it('rejects oversized length prefixes before buffering the payload', () => {
    const head = Buffer.alloc(5);
    head.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(head)).toThrow(FrameError);
  });

  it.each([
    ['zero length', Buffer.from([0, 0, 0, 0])],
    ['unknown kind', Buffer.from([0, 0, 0, 2, 9, 0])],
    ['malformed JSON', Buffer.from([0, 0, 0, 3, 1, 0x7b, 0x7b])],
    ['truncated binary header', Buffer.from([0, 0, 0, 3, 2, 0, 0])],
    ['binary header longer than frame', Buffer.from([0, 0, 0, 6, 2, 0, 0, 0, 99, 0])],
  ])('rejects %s', (_label, bytes) => {
    expect(() => new FrameDecoder().push(bytes)).toThrow(FrameError);
  });

  it('refuses to encode oversized frames', () => {
    expect(() => encodeBinaryFrame({}, new Uint8Array(MAX_FRAME_BYTES))).toThrow(FrameError);
  });
});
