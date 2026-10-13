import { useCallback } from 'react';
import type { SettingUpdate, Settings } from '../../../shared/settings';
import { call } from './api';
import { useLiveQuery } from './useLiveQuery';

export function useSettings() {
  const query = useLiveQuery(() => call('settings:get-all'));
  const { reload } = query;

  /** Persists one setting; resolves with the saved settings or rejects with an ApiError. */
  const update = useCallback(
    async (change: SettingUpdate): Promise<Settings> => {
      const settings = await call('settings:set', change);
      await reload();
      return settings;
    },
    [reload],
  );

  return { ...query, update };
}
