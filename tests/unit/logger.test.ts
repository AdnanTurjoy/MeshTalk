import { describe, expect, it } from 'vitest';
import { createLogger, parseLogLevel, redact } from '../../src/main/logger';

describe('redact', () => {
  it('redacts sensitive field names at any depth', () => {
    const out = redact({
      setting: 'theme',
      password: 'hunter2',
      nested: { accessToken: 'abc', privateKey: 'k', authorization: 'Bearer x' },
      list: [{ body: 'hello' }],
    });
    expect(out).toEqual({
      setting: 'theme',
      password: '[redacted]',
      nested: { accessToken: '[redacted]', privateKey: '[redacted]', authorization: '[redacted]' },
      list: [{ body: '[redacted]' }],
    });
  });

  it('serializes errors without losing the message', () => {
    const out = redact(new Error('boom')) as { name: string; message: string };
    expect(out.name).toBe('Error');
    expect(out.message).toBe('boom');
  });

  it('stops at a bounded depth', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(JSON.stringify(redact(deep))).toContain('[depth]');
  });
});

describe('createLogger', () => {
  it('writes JSON lines at or above the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      sink: (l) => lines.push(l),
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    logger.debug('hidden');
    logger.info('shown', { token: 'secret', count: 2 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      event: 'shown',
      token: '[redacted]',
      count: 2,
    });
  });

  it('parses log levels with a fallback', () => {
    expect(parseLogLevel('warn', 'info')).toBe('warn');
    expect(parseLogLevel('verbose', 'info')).toBe('info');
    expect(parseLogLevel(undefined, 'debug')).toBe('debug');
  });
});
