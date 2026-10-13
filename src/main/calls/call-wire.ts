import { z } from 'zod';
import { CALL_END_REASONS, callIdSchema, callSignalSchema } from '../../shared/calls';

/** WebRTC signaling over PeerLink. Media itself never touches this channel. */
export const callMessages = [
  z.object({
    t: z.literal('call_invite'),
    callId: callIdSchema,
    kind: z.enum(['audio', 'video']),
    sdp: z
      .string()
      .min(1)
      .max(64 * 1024),
  }),
  z.object({ t: z.literal('call_signal'), callId: callIdSchema, signal: callSignalSchema }),
  z.object({ t: z.literal('call_end'), callId: callIdSchema, reason: z.enum(CALL_END_REASONS) }),
] as const;
