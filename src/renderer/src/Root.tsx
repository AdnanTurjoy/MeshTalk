import { App } from './App';
import { Spinner } from './components/Spinner';
import { call } from './lib/api';
import { useLiveQuery } from './lib/useLiveQuery';
import { LockScreen } from './security/LockScreen';

/** Checks the app lock before anything else is loaded. */
export function Root() {
  const lock = useLiveQuery(() => call('lock:status'), ['lock-changed']);
  if (lock.status === 'loading') {
    return (
      <div className="center-fill">
        <Spinner label="Loading MeshTalk…" />
      </div>
    );
  }
  if (lock.data?.locked) return <LockScreen onUnlocked={() => void lock.reload()} />;
  return <App />;
}
