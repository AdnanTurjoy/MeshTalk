import { describe, expect, it } from 'vitest';
import { defaultSettings, settingKeys, settingUpdateSchema } from '../../src/shared/settings';

describe('settingUpdateSchema', () => {
  it('accepts a valid update for each key', () => {
    expect(settingUpdateSchema.parse({ key: 'theme', value: 'dark' })).toEqual({
      key: 'theme',
      value: 'dark',
    });
    expect(settingUpdateSchema.parse({ key: 'onboardingCompleted', value: true }).value).toBe(true);
  });

  it.each([
    ['unknown key', { key: 'nodeIntegration', value: true }],
    ['wrong value type', { key: 'theme', value: 42 }],
    ['value outside enum', { key: 'theme', value: 'neon' }],
    ['extra fields', { key: 'theme', value: 'dark', extra: 1 }],
    ['prototype pollution attempt', { key: '__proto__', value: {} }],
    ['missing value', { key: 'theme' }],
    ['non-object', 'theme=dark'],
  ])('rejects %s', (_label, input) => {
    expect(settingUpdateSchema.safeParse(input).success).toBe(false);
  });

  it('has a default for every declared key', () => {
    for (const key of settingKeys) expect(defaultSettings).toHaveProperty(key);
  });
});
