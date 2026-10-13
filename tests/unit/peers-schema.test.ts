import { describe, expect, it } from 'vitest';
import { base32, formatFingerprint } from '../../src/main/identity/device-id';
import { keepExisting } from '../../src/main/peer/peer-service';
import { parseAnnouncement } from '../../src/main/discovery/discovery-service';
import { accountInputSchema, addressSchema, displayNameSchema } from '../../src/shared/peers';
import type { PeerConnection } from '../../src/main/peer/peer-connection';

describe('base32', () => {
  it('matches RFC 4648 test vectors (unpadded)', () => {
    const enc = (s: string) => base32(Buffer.from(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('MY');
    expect(enc('fo')).toBe('MZXQ');
    expect(enc('foo')).toBe('MZXW6');
    expect(enc('foob')).toBe('MZXW6YQ');
    expect(enc('fooba')).toBe('MZXW6YTB');
    expect(enc('foobar')).toBe('MZXW6YTBOI');
  });

  it('formats fingerprints in groups of four', () => {
    expect(formatFingerprint('ABCDEFGHIJ')).toBe('ABCD-EFGH-IJ');
  });
});

describe('account input', () => {
  it('normalizes names and lowercases email labels', () => {
    expect(
      accountInputSchema.parse({
        displayName: '  Ada   Lovelace ',
        emailLabel: 'Ada@Example.ORG ',
      }),
    ).toEqual({
      displayName: 'Ada Lovelace',
      emailLabel: 'ada@example.org',
    });
    expect(accountInputSchema.parse({ displayName: 'Ada', emailLabel: '' }).emailLabel).toBeNull();
  });

  it.each(['', '   ', 'a\u0000b', 'x'.repeat(65)])('rejects display name %j', (name) => {
    expect(displayNameSchema.safeParse(name).success).toBe(false);
  });

  it('rejects invalid emails and unknown fields', () => {
    expect(accountInputSchema.safeParse({ displayName: 'A', emailLabel: 'nope' }).success).toBe(
      false,
    );
    expect(
      accountInputSchema.safeParse({ displayName: 'A', emailLabel: null, admin: true }).success,
    ).toBe(false);
  });
});

describe('address input', () => {
  it.each([
    [{ host: '192.168.1.20', port: 47820 }, true],
    [{ host: 'laptop.local', port: 1 }, true],
    [{ host: 'fe80::1%en0', port: 47820 }, true],
    [{ host: 'evil host', port: 47820 }, false],
    [{ host: '1.2.3.4', port: 0 }, false],
    [{ host: '1.2.3.4', port: 70000 }, false],
  ])('%j → %s', (input, ok) => {
    expect(addressSchema.safeParse(input).success).toBe(ok);
  });
});

describe('parseAnnouncement', () => {
  const id = 'A'.repeat(52);
  it('prefers an IPv4 address', () => {
    expect(
      parseAnnouncement({
        name: 'n',
        host: 'h.local',
        addresses: ['fe80::1', '10.0.0.5'],
        port: 47820,
        txt: { v: '1', id },
      }),
    ).toEqual({ deviceId: id, host: '10.0.0.5', port: 47820 });
  });
  it('ignores other protocol versions', () => {
    expect(
      parseAnnouncement({ name: 'n', host: 'h', addresses: [], port: 1, txt: { v: '2', id } }),
    ).toBeNull();
  });
});

describe('keepExisting (simultaneous connect tie-break)', () => {
  const conn = (direction: 'inbound' | 'outbound', remote: string) =>
    ({ direction, remoteDeviceId: remote }) as unknown as PeerConnection;

  it('both sides keep the link initiated by the lower device ID', () => {
    // From A's view: existing outbound (A→B), incoming inbound (B→A).
    const aKeeps = keepExisting(conn('outbound', 'B'), conn('inbound', 'B'), 'A');
    // From B's view: existing outbound (B→A), incoming inbound (A→B).
    const bKeeps = keepExisting(conn('outbound', 'A'), conn('inbound', 'A'), 'B');
    expect(aKeeps).toBe(true); // keeps A→B
    expect(bKeeps).toBe(false); // switches to A→B
  });

  it('replaces a stale link from the same initiator', () => {
    expect(keepExisting(conn('outbound', 'B'), conn('outbound', 'B'), 'A')).toBe(false);
  });
});
