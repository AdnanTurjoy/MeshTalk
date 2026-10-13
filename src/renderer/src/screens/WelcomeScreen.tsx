import { useState } from 'react';
import type { LocalAccount } from '../../../shared/peers';
import type { SettingUpdate, Settings, Theme } from '../../../shared/settings';
import { Button } from '../components/Button';
import { Icon, type IconName } from '../components/Icon';
import { SegmentedControl } from '../components/SegmentedControl';
import { Switch } from '../components/Switch';
import { useToast } from '../components/Toast';
import { errorMessage } from '../lib/api';
import { useSettingToggle } from '../lib/useSettingToggle';
import { useThemeSetting } from '../lib/useThemeSetting';
import { ProfileForm } from './ProfileForm';
import { themeOptions } from './SettingsScreen';

const points: readonly { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'network',
    title: 'Local network first',
    body: 'When you and your contacts share a network, messages, files and calls go straight between your devices.',
  },
  {
    icon: 'database',
    title: 'Your data stays on your device',
    body: 'History and files are stored on this computer. MeshTalk has no cloud copy unless you set one up.',
  },
  {
    icon: 'lock',
    title: 'You decide who connects',
    body: 'Being visible on the network gives nobody access. You approve each contact yourself.',
  },
];

const STEPS = 3;

interface WelcomeScreenProps {
  settings: Settings;
  account: LocalAccount | null;
  onUpdate(change: SettingUpdate): Promise<Settings>;
  onAccountSaved(): void;
}

export function WelcomeScreen({ settings, account, onUpdate, onAccountSaved }: WelcomeScreenProps) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const notify = useToast();
  const { theme, setTheme } = useThemeSetting(settings, onUpdate);
  const [discovery, setDiscovery] = useSettingToggle(settings, onUpdate, 'discoveryEnabled');

  const finish = async () => {
    setSaving(true);
    try {
      await onUpdate({ key: 'onboardingCompleted', value: true });
      onAccountSaved();
    } catch (error) {
      notify(errorMessage(error), 'error');
      setSaving(false);
    }
  };

  return (
    <main className="welcome">
      <div className="welcome__panel">
        <div className="steps" aria-label={`Step ${step + 1} of ${STEPS}`}>
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} data-active={i === step} />
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="stack">
              <h1>Welcome to MeshTalk</h1>
              <p className="muted">
                Private chat, file sharing and calls for people on the same network.
              </p>
            </div>
            <ul className="welcome__points">
              {points.map((p) => (
                <li key={p.title}>
                  <span className="icon-tile">
                    <Icon name={p.icon} />
                  </span>
                  <div>
                    <strong>{p.title}</strong>
                    <p className="muted">{p.body}</p>
                  </div>
                </li>
              ))}
            </ul>
            <div>
              <Button variant="primary" size="lg" onClick={() => setStep(1)}>
                Continue
              </Button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div className="stack">
              <h1>Create your profile</h1>
              <p className="muted">
                Your profile lives on this computer. MeshTalk also creates a unique key for this
                device. Contacts use it to recognize you.
              </p>
            </div>
            <ProfileForm
              account={account}
              submitLabel="Continue"
              onSaved={() => {
                onAccountSaved();
                setStep(2);
              }}
            />
            <div>
              <Button variant="ghost" onClick={() => setStep(0)}>
                Back
              </Button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="stack">
              <h1>Privacy and look</h1>
              <p className="muted">You can change these any time in Settings.</p>
            </div>
            <Switch
              label="Let people on this network find me"
              description="Announces that this device runs MeshTalk, so it shows up in nearby lists. Only a random device code is shared, never your name or email. Anyone on the network can see the announcement."
              checked={discovery}
              onChange={(v) => void setDiscovery(v)}
            />
            <div className="stack">
              <strong>Theme</strong>
              <SegmentedControl<Theme>
                label="Theme"
                value={theme}
                options={themeOptions}
                onChange={(next) => void setTheme(next)}
              />
            </div>
            <div className="row">
              <Button variant="ghost" onClick={() => setStep(1)} disabled={saving}>
                Back
              </Button>
              <Button variant="primary" size="lg" loading={saving} onClick={() => void finish()}>
                Get started
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
