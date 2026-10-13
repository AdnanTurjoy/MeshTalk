import { useState } from 'react';
import type { SettingUpdate, Settings, Theme } from '../../../shared/settings';
import { useToast } from '../components/Toast';
import { errorMessage } from './api';

/**
 * Theme selection that updates immediately and persists in the background.
 * On failure the saved value is shown again and the user is told why.
 */
export function useThemeSetting(
  settings: Settings,
  onUpdate: (change: SettingUpdate) => Promise<Settings>,
) {
  const notify = useToast();
  const [pending, setPending] = useState<Theme | null>(null);

  const setTheme = async (theme: Theme) => {
    setPending(theme);
    try {
      await onUpdate({ key: 'theme', value: theme });
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setPending((current) => (current === theme ? null : current));
    }
  };

  return { theme: pending ?? settings.theme, setTheme };
}
