import type { ChatMessage } from './chat';
import type { AppEvent } from './events';
import type { IpcChannelName, IpcRequests, IpcResponses, IpcResult } from './ipc';

/** Shape of `window.meshtalk`, exposed by the preload script. */
export interface MeshTalkApi {
  invoke<C extends IpcChannelName>(
    channel: C,
    ...payload: IpcRequests[C] extends undefined ? [] : [IpcRequests[C]]
  ): Promise<IpcResult<IpcResponses[C]>>;
  /**
   * Sends a file the user dropped or picked. Only works for genuine File
   * objects backed by a file on disk; returns an error for anything else.
   */
  sendFile(conversationId: string, file: File): Promise<IpcResult<ChatMessage>>;
  /** Subscribes to main-process events. Returns an unsubscribe function. */
  onEvent(listener: (event: AppEvent) => void): () => void;
}
