import { z } from 'zod';
import { conversationIdSchema } from './chat';

export const TRANSFER_STATES = [
  'offered',
  'waiting',
  'transferring',
  'paused',
  'complete',
  'failed',
  'cancelled',
  'declined',
] as const;

/**
 * offered: waiting for the receiver to accept · waiting: accepted, peer offline
 * transferring · paused (by the user) · complete · failed · cancelled · declined
 */
export type TransferState = (typeof TRANSFER_STATES)[number];

/** Largest file MeshTalk will offer or accept. */
export const MAX_FILE_BYTES = 20 * 1024 ** 3;
/** Largest in-memory payload (voice note, pasted image) sent over IPC. */
export const MAX_INLINE_BYTES = 25 * 1024 * 1024;
/** Voice notes up to this size are accepted automatically from contacts. */
export const AUTO_ACCEPT_VOICE_BYTES = 10 * 1024 * 1024;

export const fileIdSchema = z.string().uuid();
export const fileRefSchema = z.object({ fileId: fileIdSchema }).strict();

export const sendBytesSchema = z
  .object({
    conversationId: conversationIdSchema,
    name: z.string().min(1).max(255),
    mime: z.string().max(127),
    kind: z.enum(['file', 'voice']),
    durationMs: z.number().int().nonnegative().nullable(),
    data: z.instanceof(Uint8Array).refine((d) => d.byteLength <= MAX_INLINE_BYTES, 'Too large'),
  })
  .strict();

export const sendPathSchema = z
  .object({ conversationId: conversationIdSchema, path: z.string().min(1).max(4096) })
  .strict();

export interface TransferProgress {
  fileId: string;
  peerDeviceId: string;
  direction: 'incoming' | 'outgoing';
  state: TransferState;
  bytesDone: number;
  size: number;
  bytesPerSecond: number | null;
}

export interface TransferListItem extends TransferProgress {
  name: string;
  conversationId: string;
  messageId: string;
  peerName: string;
  error: string | null;
  updatedAt: number;
}

export interface StorageUsage {
  receivedBytes: number;
  sentCopiesBytes: number;
  partialBytes: number;
  databaseBytes: number;
  freeBytes: number | null;
  largest: {
    fileId: string;
    name: string;
    size: number;
    conversationTitle: string;
    direction: 'incoming' | 'outgoing';
  }[];
}
