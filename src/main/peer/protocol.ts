import { z } from 'zod';
import { displayNameSchema, emailLabelSchema, REQUEST_NOTE_MAX } from '../../shared/peers';

export const PROTOCOL_VERSION = 1;

const profileFields = {
  displayName: displayNameSchema,
  emailLabel: emailLabelSchema.nullable(),
};

/**
 * Every JSON message a peer may send. Anything that doesn't match is a
 * protocol error and closes the connection.
 */
export const controlMessages = [
  z.object({
    t: z.literal('hello'),
    app: z.literal('meshtalk'),
    protocol: z.number().int().positive(),
    /** Where the sender accepts connections, so we can call back. */
    listenPort: z.number().int().min(1).max(65535).nullable(),
  }),
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('pong') }),
  z.object({ t: z.literal('bye'), reason: z.string().max(64) }),
  z.object({
    t: z.literal('contact_request'),
    ...profileFields,
    note: z.string().max(REQUEST_NOTE_MAX).nullable(),
  }),
  z.object({ t: z.literal('contact_accept'), ...profileFields }),
  z.object({ t: z.literal('contact_decline') }),
  z.object({ t: z.literal('contact_remove') }),
  z.object({ t: z.literal('profile'), ...profileFields }),
] as const;

/** Messages an untrusted (not yet accepted) peer may send. */
export const UNTRUSTED_ALLOWED = new Set([
  'hello',
  'ping',
  'pong',
  'bye',
  'contact_request',
  'contact_accept',
  'contact_decline',
  'contact_remove',
]);

export type ControlMessage = z.infer<(typeof controlMessages)[number]>;
