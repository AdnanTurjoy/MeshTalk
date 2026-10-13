import { z } from 'zod';

/** Every persisted setting is declared here; the shape is the single source of truth. */
export const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  onboardingCompleted: z.boolean(),
  /** Explicit consent to announce this device and browse for others via mDNS. */
  discoveryEnabled: z.boolean(),
  notificationsEnabled: z.boolean(),
  /** When off, contacts see neither online status nor last-seen time. */
  shareOnlineStatus: z.boolean(),
  /** When off, contacts are not told when you read their messages. */
  sendReadReceipts: z.boolean(),
  /** When off, contacts are not told when you are typing. */
  sendTypingIndicators: z.boolean(),
  /** Minutes of system inactivity before an enabled app lock engages (0 = only on demand). */
  appLockIdleMinutes: z.number().int().min(0).max(240),
  /** Maximum space received files may use, in GB (0 = no limit). */
  storageQuotaGb: z.number().int().min(0).max(100_000),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;
export type Theme = Settings['theme'];

export const defaultSettings: Settings = {
  theme: 'system',
  onboardingCompleted: false,
  discoveryEnabled: false,
  notificationsEnabled: true,
  shareOnlineStatus: true,
  sendReadReceipts: true,
  sendTypingIndicators: true,
  appLockIdleMinutes: 10,
  storageQuotaGb: 0,
};

export type SettingUpdate = { [K in SettingKey]: { key: K; value: Settings[K] } }[SettingKey];

export const settingKeys = Object.keys(settingsSchema.shape) as [SettingKey, ...SettingKey[]];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingsSchema.shape, key);
}

/** Validates an untrusted `{ key, value }` pair against that key's own schema. */
export const settingUpdateSchema = z
  .object({ key: z.enum(settingKeys), value: z.unknown() })
  .strict()
  .superRefine((update, ctx) => {
    if (!settingsSchema.shape[update.key].safeParse(update.value).success) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Invalid value for setting' });
    }
  }) as unknown as z.ZodType<SettingUpdate>;
