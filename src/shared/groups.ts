import { z } from 'zod';
import { deviceIdSchema, DISPLAY_NAME_MAX } from './peers';

export type GroupRole = 'owner' | 'admin' | 'member';
export type GroupPolicy = 'everyone' | 'admins';
/** My relationship to a group on this device. */
export type MyGroupStatus = 'invited' | 'active' | 'left' | 'removed' | 'deleted';

export const groupIdSchema = z.string().uuid();
export const groupNameSchema = z
  .string()
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Enter a group name').max(DISPLAY_NAME_MAX));
export const groupDescriptionSchema = z.string().trim().max(500);

export const createGroupSchema = z
  .object({
    name: groupNameSchema,
    description: groupDescriptionSchema,
    memberIds: z.array(deviceIdSchema).max(100),
    policy: z.enum(['everyone', 'admins']),
    discoverable: z.boolean(),
  })
  .strict();

export const groupRefSchema = z.object({ groupId: groupIdSchema }).strict();
export const updateGroupSchema = z
  .object({
    groupId: groupIdSchema,
    name: groupNameSchema.optional(),
    description: groupDescriptionSchema.optional(),
    policy: z.enum(['everyone', 'admins']).optional(),
    discoverable: z.boolean().optional(),
  })
  .strict();
export const groupMembersSchema = z
  .object({ groupId: groupIdSchema, deviceIds: z.array(deviceIdSchema).min(1).max(100) })
  .strict();
export const groupMemberSchema = z
  .object({ groupId: groupIdSchema, deviceId: deviceIdSchema })
  .strict();
export const setRoleSchema = z
  .object({ groupId: groupIdSchema, deviceId: deviceIdSchema, role: z.enum(['admin', 'member']) })
  .strict();
export const joinRequestSchema = z
  .object({
    groupId: groupIdSchema,
    adminDeviceId: deviceIdSchema,
    note: z.string().trim().max(280),
  })
  .strict();
export const decideJoinSchema = z
  .object({ groupId: groupIdSchema, deviceId: deviceIdSchema, approve: z.boolean() })
  .strict();

export interface GroupMember {
  deviceId: string;
  displayName: string;
  role: GroupRole;
  status: 'active' | 'invited';
  online: boolean;
  isMe: boolean;
  isContact: boolean;
  /** Whether *I* may remove this member / change their role. */
  canRemove: boolean;
  canChangeRole: boolean;
}

export interface GroupDetails {
  id: string;
  conversationId: string;
  name: string;
  description: string;
  policy: GroupPolicy;
  discoverable: boolean;
  myStatus: MyGroupStatus;
  myRole: GroupRole | null;
  invitedBy: string | null;
  invitedByName: string | null;
  canPost: boolean;
  canEdit: boolean;
  canInvite: boolean;
  canDelete: boolean;
  members: GroupMember[];
  joinRequests: { deviceId: string; displayName: string; note: string; at: number }[];
  createdAt: number;
}

export interface DiscoveredGroup {
  groupId: string;
  name: string;
  description: string;
  memberCount: number;
  adminDeviceId: string;
  adminName: string;
}

export function groupConversationId(groupId: string): string {
  return `g:${groupId}`;
}
