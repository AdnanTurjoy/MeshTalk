import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { emptyRequestSchema } from '../../src/shared/ipc-schemas';
import { createHandler, IpcRequestError, route } from '../../src/main/ipc/router';
import type { Logger } from '../../src/main/logger';
import { defaultSettings } from '../../src/shared/settings';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const trusted = (url: string) => url.startsWith('file:///app/');
const event = (url: string) => ({ senderFrame: { url } });

const echo = route({
  channel: 'settings:set',
  schema: z.object({ key: z.literal('theme'), value: z.enum(['light', 'dark']) }),
  handle: () => ({ ...defaultSettings, theme: 'dark' as const }),
});

describe('createHandler', () => {
  it('returns data for a valid request from a trusted sender', async () => {
    const handler = createHandler(echo, trusted, logger);
    await expect(
      handler(event('file:///app/index.html'), { key: 'theme', value: 'dark' }),
    ).resolves.toEqual({
      ok: true,
      data: { ...defaultSettings, theme: 'dark' },
    });
  });

  it('rejects untrusted senders before validating or handling', async () => {
    const handle = vi.fn();
    const handler = createHandler({ ...echo, handle }, trusted, logger);
    const result = await handler(event('https://evil.example/'), { key: 'theme', value: 'dark' });
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects a missing sender frame', async () => {
    const handler = createHandler(echo, trusted, logger);
    expect(await handler({ senderFrame: null }, undefined)).toMatchObject({ ok: false });
  });

  it('rejects invalid payloads without calling the handler', async () => {
    const handle = vi.fn();
    const handler = createHandler({ ...echo, handle }, trusted, logger);
    const result = await handler(event('file:///app/'), { key: 'theme', value: 'neon' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(handle).not.toHaveBeenCalled();
  });

  it('requires empty payloads on no-argument channels', async () => {
    const handler = createHandler(
      route({ channel: 'system:info', schema: emptyRequestSchema, handle: () => ({}) as never }),
      trusted,
      logger,
    );
    expect(await handler(event('file:///app/'), { sneaky: true })).toMatchObject({ ok: false });
  });

  it('hides internal error details from the renderer', async () => {
    const handler = createHandler(
      {
        ...echo,
        handle: () => {
          throw new Error('SQLITE_CORRUPT at /Users/secret/path');
        },
      },
      trusted,
      logger,
    );
    const result = await handler(event('file:///app/'), { key: 'theme', value: 'dark' });
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(JSON.stringify(result)).not.toContain('/Users/secret');
    expect(logger.error).toHaveBeenCalled();
  });

  it('passes through deliberate, user-facing errors', async () => {
    const handler = createHandler(
      {
        ...echo,
        handle: () => {
          throw new IpcRequestError('unavailable', 'Could not open the data folder.');
        },
      },
      trusted,
      logger,
    );
    expect(await handler(event('file:///app/'), { key: 'theme', value: 'dark' })).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'Could not open the data folder.' },
    });
  });
});
