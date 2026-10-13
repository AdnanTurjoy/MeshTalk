import { ZodError, type ZodType } from 'zod';
import type { IpcErrorCode, IpcResponses, IpcResult } from '../../shared/ipc';
import { UserFacingError } from '../errors';
import type { Logger } from '../logger';

type Channel = keyof IpcResponses;

export interface IpcRoute<C extends Channel, Req> {
  channel: C;
  schema: ZodType<Req>;
  handle(request: Req): IpcResponses[C] | Promise<IpcResponses[C]>;
}

/** Minimal view of an IPC event; lets the router be tested without Electron. */
export interface IpcInvokeEvent {
  senderFrame: { url: string } | null;
}

export type IpcHandler = (event: IpcInvokeEvent, payload: unknown) => Promise<IpcResult<unknown>>;

export class IpcRequestError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IpcRequestError';
  }
}

export function route<C extends Channel, Req>(r: IpcRoute<C, Req>): IpcRoute<C, Req> {
  return r;
}

/**
 * Wraps a route so that it: rejects senders outside the app, validates the
 * payload, and converts every failure into a sanitized IpcResult. Internal
 * error details are logged but never sent to the renderer.
 */
export function createHandler<C extends Channel, Req>(
  r: IpcRoute<C, Req>,
  isTrustedSender: (url: string) => boolean,
  logger: Logger,
  /** Returns a reason to refuse the request right now (e.g. the app is locked), or null. */
  gate: (channel: Channel) => string | null = () => null,
): IpcHandler {
  return async (event, payload) => {
    const url = event.senderFrame?.url ?? '';
    if (!isTrustedSender(url)) {
      logger.warn('ipc.untrusted_sender', { channel: r.channel });
      return fail('unavailable', 'Request rejected.');
    }
    const refused = gate(r.channel);
    if (refused) return fail('unavailable', refused);
    const parsed = r.schema.safeParse(payload);
    if (!parsed.success) {
      logger.warn('ipc.invalid_request', {
        channel: r.channel,
        issues: parsed.error.issues.length,
      });
      return fail('invalid_request', 'The request was not valid.');
    }
    try {
      return { ok: true, data: await r.handle(parsed.data) };
    } catch (error) {
      if (error instanceof IpcRequestError) return fail(error.code, error.message);
      if (error instanceof UserFacingError) return fail('rejected', error.message);
      if (error instanceof ZodError) return fail('invalid_request', 'The request was not valid.');
      logger.error('ipc.handler_failed', { channel: r.channel, error });
      return fail('internal', 'Something went wrong. Details were written to the log.');
    }
  };
}

function fail(code: IpcErrorCode, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

/** A route with its request type erased, so routes of different shapes can share a list. */
export interface RouteEntry {
  channel: Channel;
  handler(
    isTrustedSender: (url: string) => boolean,
    logger: Logger,
    gate?: (channel: Channel) => string | null,
  ): IpcHandler;
}

/** Defines a typed route and erases it for registration. */
export function entry<C extends Channel, Req>(r: IpcRoute<C, Req>): RouteEntry {
  return {
    channel: r.channel,
    handler: (trusted, logger, gate) => createHandler(r, trusted, logger, gate),
  };
}
