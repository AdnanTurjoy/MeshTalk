import { useState } from 'react';
import type { Screen } from '../../shared/ipc';
import { Button } from './components/Button';
import { Spinner } from './components/Spinner';
import { call } from './lib/api';
import { useAppEvent } from './lib/events';
import { useLiveQuery } from './lib/useLiveQuery';
import { useSettings } from './lib/useSettings';
import { CallButtons } from './calls/CallButtons';
import { useCall } from './calls/call-controller';
import { CallOverlay } from './calls/CallOverlay';
import { GroupHeaderButton } from './groups/GroupHeaderButton';
import { CallsScreen } from './screens/CallsScreen';
import { ChatsScreen } from './screens/ChatsScreen';
import { DiagnosticsScreen } from './screens/DiagnosticsScreen';
import { FilesScreen } from './screens/FilesScreen';
import { NetworkScreen } from './screens/NetworkScreen';
import { PeopleScreen } from './screens/PeopleScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SkillsScreen } from './screens/SkillsScreen';
import { WelcomeScreen } from './screens/WelcomeScreen';
import { Sidebar } from './Sidebar';

export function App() {
  const settings = useSettings();
  const account = useLiveQuery(() => call('account:get'), ['account-changed']);
  const [screen, setScreen] = useState<Screen>('chats');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const callPhase = useCall().phase;
  // The full-screen call view is modal: everything behind it is inert.
  const inCall = callPhase !== 'idle' && callPhase !== 'incoming';

  const openChat = async (deviceId: string) => {
    try {
      const conversation = await call('chat:open-direct', { deviceId });
      setConversationId(conversation.id);
      setScreen('chats');
    } catch {
      // The contact may have just been removed; People will refresh.
    }
  };

  useAppEvent(['navigate'], (event) => {
    if (event.type === 'navigate') setScreen(event.screen);
  });

  if (settings.status === 'loading' || account.status === 'loading') {
    return (
      <div className="center-fill">
        <Spinner label="Loading MeshTalk…" />
      </div>
    );
  }

  if (!settings.data || account.status === 'error') {
    return (
      <div className="center-fill">
        <div className="stack" role="alert">
          <h2>Something went wrong</h2>
          <p className="muted">{settings.error ?? account.error ?? 'MeshTalk could not load.'}</p>
          <div>
            <Button
              variant="primary"
              onClick={() => {
                void settings.reload();
                void account.reload();
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!settings.data.onboardingCompleted || !account.data) {
    return (
      <WelcomeScreen
        settings={settings.data}
        account={account.data}
        onUpdate={settings.update}
        onAccountSaved={() => void account.reload()}
      />
    );
  }

  return (
    <div className="shell">
      <CallOverlay />
      <Sidebar current={screen} onNavigate={setScreen} account={account.data} inert={inCall} />
      <main className={`main ${screen === 'chats' ? 'main--flush' : ''}`} id="main" inert={inCall}>
        {screen === 'chats' && (
          <ChatsScreen
            conversationId={conversationId}
            onSelect={setConversationId}
            headerExtras={(c) => (
              <>
                <CallButtons conversation={c} />
                <GroupHeaderButton conversation={c} />
              </>
            )}
          />
        )}
        {screen === 'people' && (
          <PeopleScreen
            settings={settings.data}
            onUpdate={settings.update}
            onOpenChat={(deviceId) => void openChat(deviceId)}
          />
        )}
        {screen === 'calls' && <CallsScreen />}
        {screen === 'skills' && <SkillsScreen onMessage={(id) => void openChat(id)} />}
        {screen === 'files' && <FilesScreen />}
        {screen === 'network' && (
          <NetworkScreen settings={settings.data} onUpdate={settings.update} />
        )}
        {screen === 'settings' && (
          <SettingsScreen
            settings={settings.data}
            account={account.data}
            onUpdate={settings.update}
          />
        )}
        {screen === 'diagnostics' && <DiagnosticsScreen />}
      </main>
    </div>
  );
}
