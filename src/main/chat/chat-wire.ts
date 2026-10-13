import { z } from 'zod';
import {
  emojiSchema,
  MESSAGE_MAX_CHARS,
  messageBodySchema,
  messageIdSchema,
} from '../../shared/chat';

const timestamp = z.number().int().nonnegative();
const eventId = z.string().uuid();
const groupConversation = z.string().regex(/^g:[0-9a-f-]{36}$/);

/** Durable chat events. Applying any of them twice must be harmless. */
export const chatEventSchema = z.discriminatedUnion('k', [
  z.object({
    k: z.literal('msg'),
    id: messageIdSchema,
    kind: z.enum(['text', 'file', 'voice']),
    body: z.string().max(MESSAGE_MAX_CHARS),
    replyTo: messageIdSchema.nullable(),
    sentAt: timestamp,
    /** Device IDs mentioned with @ (groups). */
    mentions: z
      .array(z.string().regex(/^[A-Z2-7]{52}$/))
      .max(50)
      .default([]),
    file: z
      .object({
        fileId: z.string().uuid(),
        name: z.string().min(1).max(255),
        size: z.number().int().nonnegative(),
        mime: z.string().max(127),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        durationMs: z.number().int().nonnegative().nullable(),
      })
      .nullable()
      .default(null),
  }),
  z.object({
    k: z.literal('edit'),
    id: messageIdSchema,
    body: messageBodySchema,
    editedAt: timestamp,
  }),
  z.object({ k: z.literal('delete'), id: messageIdSchema, deletedAt: timestamp }),
  z.object({
    k: z.literal('react'),
    id: messageIdSchema,
    emoji: emojiSchema,
    on: z.boolean(),
    at: timestamp,
  }),
  z.object({ k: z.literal('read'), ids: z.array(messageIdSchema).min(1).max(500) }),
]);

export type ChatEvent = z.infer<typeof chatEventSchema>;

export const chatMessages = [
  /** A durable event, retried from the sender's outbox until acked. */
  z.object({
    t: z.literal('ev'),
    eid: eventId,
    /** Null for direct conversations (implied by the sender); a group ID otherwise. */
    conv: groupConversation.nullable(),
    ev: chatEventSchema,
  }),
  z.object({ t: z.literal('ev_ack'), eids: z.array(eventId).min(1).max(500) }),
  z.object({ t: z.literal('typing'), conv: groupConversation.nullable(), on: z.boolean() }),
  z.object({ t: z.literal('presence'), share: z.boolean() }),
] as const;
