import { z } from 'zod';
import { deviceIdSchema } from './peers';

export const SKILL_LEVELS = ['beginner', 'intermediate', 'advanced', 'expert'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];
export type Visibility = 'private' | 'contacts';

export const SKILL_CATEGORIES = [
  'Software',
  'Data',
  'Design',
  'Hardware',
  'Science',
  'Languages',
  'Management',
  'Other',
] as const;

/** Only https links: they open in the system browser, nothing else does. */
export const linkSchema = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => u.startsWith('https://'), 'Links must start with https://');

export const skillInputSchema = z
  .object({
    id: z.string().uuid().nullable(),
    kind: z.enum(['skill', 'interest']),
    title: z.string().trim().min(1, 'Enter a title').max(80),
    description: z.string().trim().max(1000),
    category: z.enum(SKILL_CATEGORIES),
    level: z.enum(SKILL_LEVELS).nullable(),
    links: z.array(linkSchema).max(5),
    visibility: z.enum(['private', 'contacts']),
  })
  .strict();
export type SkillInput = z.infer<typeof skillInputSchema>;

export const updateInputSchema = z
  .object({
    title: z.string().trim().min(1, 'Enter a title').max(120),
    body: z.string().trim().max(4000),
    visibility: z.enum(['private', 'contacts']),
  })
  .strict();

export const skillRequestInputSchema = z
  .object({
    deviceId: deviceIdSchema,
    kind: z.enum(['mentorship', 'collaboration']),
    topic: z.string().trim().min(1).max(80),
    note: z.string().trim().max(500),
  })
  .strict();

export const bookmarkInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    url: linkSchema,
    note: z.string().trim().max(500),
    sourceDeviceId: deviceIdSchema.nullable(),
  })
  .strict();

export interface Skill {
  id: string;
  kind: 'skill' | 'interest';
  title: string;
  description: string;
  category: (typeof SKILL_CATEGORIES)[number];
  level: SkillLevel | null;
  links: string[];
  visibility: Visibility;
  updatedAt: number;
}

export interface ProjectUpdate {
  id: string;
  title: string;
  body: string;
  visibility: Visibility;
  createdAt: number;
}

/** What a contact sees: only items marked visible to contacts. */
export interface SharedProfile {
  skills: Omit<Skill, 'visibility'>[];
  updates: Omit<ProjectUpdate, 'visibility'>[];
  updatedAt: number;
}

export interface PeerProfile extends SharedProfile {
  deviceId: string;
  displayName: string;
  online: boolean;
  fetchedAt: number;
}

export interface SkillMatch {
  deviceId: string;
  displayName: string;
  skill: Omit<Skill, 'visibility'>;
}

export interface SimilarPerson {
  deviceId: string;
  displayName: string;
  shared: string[];
  score: number;
}

export interface SkillRequest {
  id: string;
  direction: 'incoming' | 'outgoing';
  peerDeviceId: string;
  peerName: string;
  kind: 'mentorship' | 'collaboration';
  topic: string;
  note: string;
  state: 'pending' | 'accepted' | 'declined';
  createdAt: number;
}

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  note: string;
  sourceName: string | null;
  createdAt: number;
}
