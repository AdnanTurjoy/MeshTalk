import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { call, errorMessage } from '../lib/api';

export function LockScreen({ onUnlocked }: { onUnlocked(): void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const status = await call('lock:unlock', { pin });
      setPin('');
      if (!status.locked) onUnlocked();
    } catch (err) {
      setError(errorMessage(err));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="center-fill lock-screen">
      <form className="lock-screen__panel stack" onSubmit={(e) => void submit(e)}>
        <span className="icon-tile">
          <Icon name="lock" />
        </span>
        <h1>MeshTalk is locked</h1>
        <label className="field">
          <span className="field__label">PIN or passphrase</span>
          <input
            className="input"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </label>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy} disabled={!pin}>
          Unlock
        </Button>
        <p className="field__hint">
          The lock hides MeshTalk on this computer. Your data on disk is protected by your
          computer’s own login and disk encryption, not by this PIN.
        </p>
      </form>
    </main>
  );
}
