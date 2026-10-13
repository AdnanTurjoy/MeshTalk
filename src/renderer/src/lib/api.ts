import type { IpcChannelName, IpcRequests, IpcResponses } from '../../../shared/ipc';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Calls a main-process channel, throwing a user-presentable ApiError on failure. */
export async function call<C extends IpcChannelName>(
  channel: C,
  ...payload: IpcRequests[C] extends undefined ? [] : [IpcRequests[C]]
): Promise<IpcResponses[C]> {
  const result = await window.meshtalk.invoke(channel, ...payload);
  if (!result.ok) throw new ApiError(result.error.code, result.error.message);
  return result.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong.';
}
