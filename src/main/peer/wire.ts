import { z } from 'zod';
import { callMessages } from '../calls/call-wire';
import { chatMessages } from '../chat/chat-wire';
import { transferMessages } from '../files/transfer-wire';
import { groupMessages } from '../groups/group-wire';
import { skillMessages } from '../skills/skills-wire';
import { controlMessages } from './protocol';

/** The full PeerLink JSON vocabulary. Feature modules append their schemas here. */
export const wireMessageSchema = z.discriminatedUnion('t', [
  ...controlMessages,
  ...chatMessages,
  ...transferMessages,
  ...callMessages,
  ...groupMessages,
  ...skillMessages,
]);

export type WireMessage = z.infer<typeof wireMessageSchema>;
export type WireMessageType = WireMessage['t'];
export type WireMessageOf<T extends WireMessageType> = Extract<WireMessage, { t: T }>;
