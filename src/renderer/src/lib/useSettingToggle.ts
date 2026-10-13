import { useState } from 'react';
import type { SettingKey, SettingUpdate, Settings } from '../../../shared/settings';
import { useToast } from '../components/Toast';
import { errorMessage } from './api';

type BooleanKey = { [K in SettingKey]: Settings[K] extends boolean ? K : never }[SettingKey];

/** Optimistic boolean setting, reverting with a toast if saving fails. */
export function useSettingToggle(
  settings: Settings,
  onUpdate: (change: SettingUpdate) => Promise<Settings>,
  key: BooleanKey,
) {
  const notify = useToast();
  const [pending, setPending] = useState<boolean | null>(null);
  const set = async (value: boolean) => {
    setPending(value);
    try {
      await onUpdate({ key, value } as SettingUpdate);
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setPending(null);
    }
  };
  return [pending ?? settings[key], set] as const;
}
