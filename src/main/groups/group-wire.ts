import { z } from 'zod';
import { deviceIdSchema, displayNameSchema } from '../../shared/peers';

const groupId = z.string().uuid();
const eventId = z.string().uuid();

export const groupSnapshotSchema = z.object({
  groupId,
  version: z.number().int().positive(),
  name: z.string().min(1).max(64),
  description: z.string().max(500),
  policy: z.enum(['everyone', 'admins']),
  discoverable: z.boolean(),
  deleted: z.boolean(),
  members: z
    .array(
      z.object({
        id: deviceIdSchema,
        name: displayNameSchema,
        role: z.enum(['owner', 'admin', 'member']),
        status: z.enum(['active', 'invited']),
        /** Where the sending admin last reached this member; a hint, verified by TLS. */
        host: z.string().max(253).nullable(),
        port: z.number().int().min(1).max(65535).nullable(),
      }),
    )
    .max(256),
  createdAt: z.number().int().nonnegative(),
});
export type GroupSnapshot = z.infer<typeof groupSnapshotSchema>;

export const groupEventSchema = z.discriminatedUnion('k', [
  z.object({ k: z.literal('state'), snapshot: groupSnapshotSchema }),
  z.object({ k: z.literal('accept'), groupId }),
  z.object({ k: z.literal('decline'), groupId }),
  z.object({ k: z.literal('leave'), groupId }),
  z.object({ k: z.literal('join_req'), groupId, note: z.string().max(280) }),
]);
export type GroupEvent = z.infer<typeof groupEventSchema>;

export const groupMessages = [
  /** Reliable (outbox-delivered, acked with ev_ack). */
  z.object({ t: z.literal('group_ev'), eid: eventId, ev: groupEventSchema }),
  /** Ephemeral: ask a contact which of their groups are discoverable. */
  z.object({ t: z.literal('group_list_req') }),
  z.object({
    t: z.literal('group_list'),
    groups: z
      .array(
        z.object({
          groupId,
          name: z.string().max(64),
          description: z.string().max(500),
          memberCount: z.number().int().nonnegative(),
        }),
      )
      .max(100),
  }),
] as const;
