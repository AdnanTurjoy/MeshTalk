import { z } from 'zod';
import { SKILL_CATEGORIES, SKILL_LEVELS } from '../../shared/skills';

const sharedSkill = z.object({
  id: z.string().uuid(),
  kind: z.enum(['skill', 'interest']),
  title: z.string().max(80),
  description: z.string().max(1000),
  category: z.enum(SKILL_CATEGORIES),
  level: z.enum(SKILL_LEVELS).nullable(),
  links: z.array(z.string().max(500).startsWith('https://')).max(5),
  updatedAt: z.number().int().nonnegative(),
});

export const sharedProfileSchema = z.object({
  skills: z.array(sharedSkill).max(100),
  updates: z
    .array(
      z.object({
        id: z.string().uuid(),
        title: z.string().max(120),
        body: z.string().max(4000),
        createdAt: z.number().int().nonnegative(),
      }),
    )
    .max(20),
  updatedAt: z.number().int().nonnegative(),
});

const skillEvent = z.discriminatedUnion('k', [
  z.object({
    k: z.literal('request'),
    id: z.string().uuid(),
    kind: z.enum(['mentorship', 'collaboration']),
    topic: z.string().max(80),
    note: z.string().max(500),
  }),
  z.object({ k: z.literal('response'), id: z.string().uuid(), accepted: z.boolean() }),
]);
export type SkillEvent = z.infer<typeof skillEvent>;

export const skillMessages = [
  /** Ask a contact for the parts of their profile they share with contacts. */
  z.object({ t: z.literal('skills_req') }),
  z.object({ t: z.literal('skills_profile'), profile: sharedProfileSchema }),
  /** Tells contacts our shared profile changed, so they may refetch. */
  z.object({ t: z.literal('skills_changed'), updatedAt: z.number().int().nonnegative() }),
  /** Reliable (outbox, acked with ev_ack). */
  z.object({ t: z.literal('skill_ev'), eid: z.string().uuid(), ev: skillEvent }),
] as const;
