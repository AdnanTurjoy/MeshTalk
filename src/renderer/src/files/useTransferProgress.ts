import { useSyncExternalStore } from 'react';
import type { TransferProgress } from '../../../shared/files';

/**
 * Latest progress per file, fed by main-process `transfer-progress` events.
 * A module-level store so every view of the same file shares one subscription.
 */
const latest = new Map<string, TransferProgress>();
const listeners = new Set<() => void>();
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  window.meshtalk.onEvent((event) => {
    if (event.type !== 'transfer-progress') return;
    latest.set(event.progress.fileId, event.progress);
    listeners.forEach((l) => l());
  });
}

function subscribe(listener: () => void): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTransferProgress(fileId: string): TransferProgress | undefined {
  return useSyncExternalStore(subscribe, () => latest.get(fileId));
}

export function formatRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || bytesPerSecond <= 0) return '';
  const mb = bytesPerSecond / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

export function formatEta(remaining: number, bytesPerSecond: number | null): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '';
  const s = Math.ceil(remaining / bytesPerSecond);
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
}
