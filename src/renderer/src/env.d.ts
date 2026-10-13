import type { MeshTalkApi } from '../../shared/api';

declare global {
  interface Window {
    readonly meshtalk: MeshTalkApi;
  }
}
