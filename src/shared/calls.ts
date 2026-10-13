import { z } from 'zod';
import { conversationIdSchema } from './chat';

export type CallKind = 'audio' | 'video';

export const CALL_END_REASONS = [
  'hangup',
  'declined',
  'busy',
  'no_answer',
  'cancelled',
  'connection_lost',
  'unavailable',
  'error',
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

export const callIdSchema = z.string().uuid();
const sdpSchema = z
  .string()
  .min(1)
  .max(64 * 1024);

/** What a renderer may ask main to forward to the other side of a call. */
export const callSignalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('offer'), sdp: sdpSchema, restart: z.boolean() }).strict(),
  z.object({ type: z.literal('answer'), sdp: sdpSchema }).strict(),
  z
    .object({
      type: z.literal('ice'),
      candidate: z.string().max(2048),
      sdpMid: z.string().max(64).nullable(),
      sdpMLineIndex: z.number().int().min(0).max(64).nullable(),
    })
    .strict(),
]);
export type CallSignal = z.infer<typeof callSignalSchema>;

export const startCallSchema = z
  .object({ conversationId: conversationIdSchema, kind: z.enum(['audio', 'video']) })
  .strict();
export const callRefSchema = z.object({ callId: callIdSchema }).strict();
export const sendSignalSchema = z
  .object({ callId: callIdSchema, signal: callSignalSchema })
  .strict();
export const endCallSchema = z
  .object({ callId: callIdSchema, reason: z.enum(CALL_END_REASONS) })
  .strict();
export const markConnectedSchema = z
  .object({ callId: callIdSchema, relayed: z.boolean() })
  .strict();

export interface IncomingCall {
  callId: string;
  peerDeviceId: string;
  peerName: string;
  kind: CallKind;
  conversationId: string;
  offerSdp: string;
}

export interface CallRecord {
  id: string;
  conversationId: string;
  peerDeviceId: string;
  peerName: string;
  kind: CallKind;
  direction: 'incoming' | 'outgoing';
  createdAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  endReason: CallEndReason | null;
  /** True if media went through a TURN relay (only possible with an account server). */
  relayed: boolean;
}
