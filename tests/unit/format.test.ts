import { describe, expect, it } from 'vitest';
import { formatBytes, formatPlatform } from '../../src/renderer/src/lib/format';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1536, '1.5 KB'],
    [5 * 1024 ** 3, '5.0 GB'],
    [-1, '—'],
    [Number.NaN, '—'],
  ])('%d → %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});

describe('formatPlatform', () => {
  it('names the three supported platforms', () => {
    expect(formatPlatform('darwin')).toBe('macOS');
    expect(formatPlatform('win32')).toBe('Windows');
    expect(formatPlatform('linux')).toBe('Linux');
    expect(formatPlatform('freebsd')).toBe('freebsd');
  });
});
