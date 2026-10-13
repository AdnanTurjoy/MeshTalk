import type { Screen } from '../../shared/ipc';
import type { LocalAccount } from '../../shared/peers';
import { Avatar } from './components/Avatar';
import { Badge } from './components/Badge';
import { Icon, type IconName } from './components/Icon';
import { call } from './lib/api';
import { useLiveQuery } from './lib/useLiveQuery';

const items: readonly { screen: Screen; label: string; icon: IconName; shortcut: string }[] = [
  { screen: 'chats', label: 'Chats', icon: 'chat', shortcut: 'CmdOrCtrl+1' },
  { screen: 'calls', label: 'Calls', icon: 'phone', shortcut: 'CmdOrCtrl+2' },
  { screen: 'people', label: 'People', icon: 'people', shortcut: 'CmdOrCtrl+3' },
  { screen: 'skills', label: 'Skills', icon: 'skills', shortcut: 'CmdOrCtrl+4' },
  { screen: 'files', label: 'Files', icon: 'files', shortcut: 'CmdOrCtrl+5' },
  { screen: 'network', label: 'Network', icon: 'network', shortcut: 'CmdOrCtrl+6' },
  { screen: 'settings', label: 'Settings', icon: 'settings', shortcut: 'CmdOrCtrl+,' },
  {
    screen: 'diagnostics',
    label: 'Diagnostics',
    icon: 'diagnostics',
    shortcut: 'CmdOrCtrl+Shift+D',
  },
];

const isMac = navigator.userAgent.includes('Mac');

export function Sidebar({
  current,
  onNavigate,
  account,
  inert,
}: {
  current: Screen;
  onNavigate(screen: Screen): void;
  account: LocalAccount;
  inert?: boolean;
}) {
  const contacts = useLiveQuery(() => call('contacts:list'), ['contacts-changed']);
  const conversations = useLiveQuery(
    () => call('chat:list-conversations', { archived: false }),
    ['conversations-changed'],
  );
  const pendingRequests = contacts.data?.filter((c) => c.state === 'incoming').length ?? 0;
  const unread = conversations.data?.reduce((n, c) => n + (c.muted ? 0 : c.unreadCount), 0) ?? 0;
  const callHistory = useLiveQuery(() => call('call:history'), ['calls-changed']);
  const counts: Partial<Record<Screen, number>> = {
    chats: unread,
    calls: callHistory.data?.missed ?? 0,
    people: pendingRequests,
  };

  return (
    <nav className="sidebar" aria-label="Primary" inert={inert}>
      <div className="sidebar__brand">
        <Icon name="mesh" size={22} />
        <span className="sidebar__label">MeshTalk</span>
      </div>
      <div className="sidebar__nav">
        {items.map((item) => {
          const count = counts[item.screen] ?? 0;
          return (
            <button
              key={item.screen}
              type="button"
              className="nav-item"
              aria-current={current === item.screen ? 'page' : undefined}
              aria-keyshortcuts={item.shortcut.replace('CmdOrCtrl', isMac ? 'Meta' : 'Control')}
              title={item.label}
              onClick={() => onNavigate(item.screen)}
            >
              <Icon name={item.icon} />
              <span className="sidebar__label">{item.label}</span>
              {count > 0 && (
                <span className="sidebar__count sidebar__label" aria-label={`${count} pending`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="sidebar__footer stack">
        <div className="row">
          <Avatar name={account.displayName} />
          <span className="sidebar__label list-item__main">
            <strong className="list-item__title">{account.displayName}</strong>
            <span className="list-item__meta">{account.emailLabel ?? 'No email'}</span>
          </span>
        </div>
        <span className="sidebar__label">
          <Badge tone="info">LAN-only mode</Badge>
        </span>
      </div>
    </nav>
  );
}
