import { z } from 'zod';
import {
  accountInputSchema,
  deviceIdSchema,
  hostSchema,
  portSchema,
  REQUEST_NOTE_MAX,
} from './peers';

/** Channels that take no payload must receive exactly that. */
export const emptyRequestSchema = z.undefined();

export const deviceRefSchema = z.object({ deviceId: deviceIdSchema }).strict();

const noteSchema = z
  .string()
  .trim()
  .max(REQUEST_NOTE_MAX)
  .transform((s) => (s === '' ? null : s))
  .nullable();

export const requestNearbySchema = z
  .object({ deviceId: deviceIdSchema, note: noteSchema })
  .strict();
export const requestAddressSchema = z
  .object({ host: hostSchema, port: portSchema, note: noteSchema })
  .strict();
export const setVerifiedSchema = z
  .object({ deviceId: deviceIdSchema, verified: z.boolean() })
  .strict();
export const networkTestSchema = z.object({ host: hostSchema, port: portSchema }).strict();

export { accountInputSchema };
