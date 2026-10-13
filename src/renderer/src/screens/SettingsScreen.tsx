import type { LocalAccount } from '../../../shared/peers';
import type { SettingUpdate, Settings, Theme } from '../../../shared/settings';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { SegmentedControl } from '../components/SegmentedControl';
import { Switch } from '../components/Switch';
import { useToast } from '../components/Toast';
import { call, errorMessage } from '../lib/api';
import { useSettingToggle } from '../lib/useSettingToggle';
import { useThemeSetting } from '../lib/useThemeSetting';
import { ProfileForm } from './ProfileForm';
import { DataCard, SecurityCard, StorageLimitCard } from './SecurityDataCards';

export const themeOptions = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies readonly { value: Theme; label: string }[];

const modes = [
  {
    name: 'LAN-only',
    available: true,
    summary:
      'No server. Devices find and talk to each other directly on the local network. Your email is just a label: nobody verifies it, and two people can use the same one.',
  },
  {
    name: 'LAN-first with account server',
    available: false,
    summary:
      'Adds verified email sign-up, password reset, and connecting across networks. Messages and files still go device to device.',
  },
  {
    name: 'Self-hosted organization',
    available: false,
    summary:
      'Your organization runs the identity and connection server, with its own access rules and audit log.',
  },
] as const;

interface SettingsScreenProps {
  settings: Settings;
  account: LocalAccount;
  onUpdate(change: SettingUpdate): Promise<Settings>;
}

export function SettingsScreen({ settings, account, onUpdate }: SettingsScreenProps) {
  const notify = useToast();
  const { theme, setTheme } = useThemeSetting(settings, onUpdate);
  const [discovery, setDiscovery] = useSettingToggle(settings, onUpdate, 'discoveryEnabled');
  const [notifications, setNotifications] = useSettingToggle(
    settings,
    onUpdate,
    'notificationsEnabled',
  );
  const [online, setOnline] = useSettingToggle(settings, onUpdate, 'shareOnlineStatus');
  const [receipts, setReceipts] = useSettingToggle(settings, onUpdate, 'sendReadReceipts');
  const [typing, setTyping] = useSettingToggle(settings, onUpdate, 'sendTypingIndicators');

  const openDataFolder = async () => {
    try {
      await call('shell:open-data-directory');
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  };

  return (
    <div className="page">
      <header className="page__header">
        <h1>Settings</h1>
      </header>

      <Card title="Profile" description="Shared only with contacts you accept.">
        <ProfileForm
          account={account}
          submitLabel="Save profile"
          onSaved={() => notify('Profile saved.', 'success')}
        />
      </Card>

      <Card title="Privacy">
        <Switch
          label="Let people on this network find me"
          description="Announces a random device code over mDNS. Your name is never announced."
          checked={discovery}
          onChange={(v) => void setDiscovery(v)}
        />
        <Switch
          label="Show when I’m online"
          description="When off, contacts see neither your online status nor when you were last seen."
          checked={online}
          onChange={(v) => void setOnline(v)}
        />
        <Switch
          label="Send read receipts"
          description="When off, contacts aren’t told when you read their messages."
          checked={receipts}
          onChange={(v) => void setReceipts(v)}
        />
        <Switch
          label="Send typing indicators"
          checked={typing}
          onChange={(v) => void setTyping(v)}
        />
      </Card>

      <Card title="Notifications">
        <Switch
          label="Show notifications"
          description="System notifications for contact requests, messages and calls, when MeshTalk is not in front."
          checked={notifications}
          onChange={(v) => void setNotifications(v)}
        />
      </Card>

      <Card
        title="Appearance"
        description="System follows your operating system’s light or dark setting."
      >
        <SegmentedControl<Theme>
          label="Theme"
          value={theme}
          options={themeOptions}
          onChange={(next) => void setTheme(next)}
        />
      </Card>

      <Card
        title="Network mode"
        description="The mode decides which features exist and who you have to trust."
      >
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Mode</th>
              <th scope="col">What it means</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {modes.map((mode) => (
              <tr key={mode.name}>
                <td>
                  <strong>{mode.name}</strong>
                </td>
                <td className="muted">{mode.summary}</td>
                <td>
                  {mode.available ? (
                    <Badge tone="success">Active</Badge>
                  ) : (
                    <Badge>Not yet available</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <SecurityCard settings={settings} onUpdate={onUpdate} />

      <StorageLimitCard settings={settings} onUpdate={onUpdate} />

      <DataCard />

      <Card
        title="Data folder"
        description="Everything MeshTalk saves stays in one folder on this computer."
        actions={<Button onClick={() => void openDataFolder()}>Show data folder</Button>}
      />
    </div>
  );
}
