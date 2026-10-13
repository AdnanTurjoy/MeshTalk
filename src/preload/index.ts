import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { MeshTalkApi } from '../shared/api';
import type { AppEvent } from '../shared/events';
import { IPC_EVENT_CHANNEL, ipcChannelNames, PreloadChannel } from '../shared/ipc';

// Forwarding only. Main validates every payload; this just refuses channels
// outside the contract so the renderer cannot reach any other IPC handler.
const api: MeshTalkApi = {
  invoke: ((channel: string, payload?: unknown) => {
    if (!ipcChannelNames.has(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'invalid_request', message: 'Unknown request.' },
      });
    }
    return ipcRenderer.invoke(channel, payload);
  }) as MeshTalkApi['invoke'],
  sendFile: (conversationId, file) => {
    // Throws for anything that isn't a real File; returns '' for in-memory files.
    let path = '';
    try {
      path = webUtils.getPathForFile(file);
    } catch {
      path = '';
    }
    if (!path) {
      return Promise.resolve({
        ok: false,
        error: { code: 'invalid_request', message: 'That file could not be read from disk.' },
      });
    }
    return ipcRenderer.invoke(PreloadChannel.filesSendPath, { conversationId, path });
  },
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: AppEvent) => listener(payload);
    ipcRenderer.on(IPC_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IPC_EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld('meshtalk', api);
