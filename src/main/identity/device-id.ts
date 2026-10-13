import { createHash } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Device ID = base32(SHA-256(certificate DER)): 52 characters. */
export function deviceIdFromCertificate(der: Uint8Array): string {
  return base32(createHash('sha256').update(der).digest());
}

/** `ABCD-EFGH-…` groups of four, for comparing out loud or side by side. */
export function formatFingerprint(deviceId: string): string {
  return deviceId.match(/.{1,4}/g)?.join('-') ?? deviceId;
}

export function shortDeviceId(deviceId: string): string {
  return deviceId.slice(0, 7);
}
