import { useState } from 'react';
import type { SettingUpdate, Settings } from '../../../shared/settings';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Dialog } from '../components/Dialog';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { call, errorMessage } from '../lib/api';
import { formatBytes } from '../lib/format';
import { useLiveQuery } from '../lib/useLiveQuery';

interface Props {
  settings: Settings;
  onUpdate(change: SettingUpdate): Promise<Settings>;
}

export function SecurityCard({ settings, onUpdate }: Props) {
  const status = useLiveQuery(() => call('lock:status'), ['lock-changed']);
  const notify = useToast();
  const [mode, setMode] = useState<'set' | 'change' | 'disable' | null>(null);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [current, setCurrent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const enabled = status.data?.enabled ?? false;

  const close = () => {
    setMode(null);
    setPin('');
    setConfirmPin('');
    setCurrent('');
    setError(null);
  };

  const submit = async () => {
    try {
      if (mode === 'disable') {
        await call('lock:disable', { pin: current });
        notify('App lock turned off.', 'success');
      } else {
        if (pin !== confirmPin) {
          setError('The two entries don’t match.');
          return;
        }
        await call('lock:set-pin', { pin, currentPin: mode === 'change' ? current : null });
        notify(mode === 'set' ? 'App lock is on.' : 'PIN changed.', 'success');
      }
      close();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Card
      title="App lock"
      description="Ask for a PIN or passphrase when MeshTalk opens, after inactivity, and when your computer locks. This hides the app; it does not encrypt data on disk."
    >
      <div className="row">
        {enabled ? (
          <>
            <Button onClick={() => void call('lock:now')}>Lock now</Button>
            <Button onClick={() => setMode('change')}>Change PIN</Button>
            <Button variant="danger" onClick={() => setMode('disable')}>
              Turn off
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => setMode('set')}>
            Turn on app lock
          </Button>
        )}
      </div>
      {enabled && (
        <label className="field">
          <span className="field__label">Lock after inactivity</span>
          <select
            className="input"
            value={settings.appLockIdleMinutes}
            onChange={(e) =>
              void onUpdate({ key: 'appLockIdleMinutes', value: Number(e.target.value) })
            }
          >
            {[1, 5, 10, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} minute{m === 1 ? '' : 's'}
              </option>
            ))}
            <option value={0}>Only when I lock it</option>
          </select>
        </label>
      )}
      <Dialog
        open={mode !== null}
        title={
          mode === 'disable'
            ? 'Turn off app lock'
            : mode === 'change'
              ? 'Change PIN'
              : 'Turn on app lock'
        }
        onClose={close}
        actions={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()}>
              {mode === 'disable' ? 'Turn off' : 'Save'}
            </Button>
          </>
        }
      >
        {(mode === 'change' || mode === 'disable') && (
          <TextField
            label="Current PIN"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        )}
        {mode !== 'disable' && (
          <>
            <TextField
              label="New PIN or passphrase"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              hint="At least 4 characters."
              autoComplete="new-password"
            />
            <TextField
              label="Repeat it"
              type="password"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              autoComplete="new-password"
            />
            <p className="notice">
              If you forget it, the only way back in is to delete MeshTalk’s data on this computer.
            </p>
          </>
        )}
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </Dialog>
    </Card>
  );
}

export function StorageLimitCard({ settings, onUpdate }: Props) {
  return (
    <Card
      title="Storage limit"
      description="Stop accepting new downloads once received files use this much space."
    >
      <label className="field">
        <span className="field__label">Limit for received files</span>
        <select
          className="input"
          value={settings.storageQuotaGb}
          onChange={(e) => void onUpdate({ key: 'storageQuotaGb', value: Number(e.target.value) })}
        >
          <option value={0}>No limit</option>
          {[1, 5, 10, 25, 50, 100, 250, 500].map((g) => (
            <option key={g} value={g}>
              {g} GB
            </option>
          ))}
        </select>
      </label>
    </Card>
  );
}

export function DataCard() {
  const notify = useToast();
  const [backupOpen, setBackupOpen] = useState(false);
  const [includeKey, setIncludeKey] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [restore, setRestore] = useState<{
    path: string;
    createdAt: number;
    fileCount: number;
    fileBytes: number;
    hasIdentity: boolean;
    sameDevice: boolean;
  } | null>(null);
  const [restorePass, setRestorePass] = useState('');
  const [needsPass, setNeedsPass] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeText, setWipeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Backup and your data"
      description="Everything MeshTalk stores lives on this computer. Keep a backup somewhere safe."
    >
      <div className="row">
        <Button variant="primary" onClick={() => setBackupOpen(true)}>
          Back up…
        </Button>
        <Button
          onClick={() =>
            void call('data:choose-backup').then(
              (r) => {
                if (r) {
                  setRestore(r);
                  setNeedsPass(false);
                }
              },
              (e: unknown) => notify(errorMessage(e), 'error'),
            )
          }
        >
          Restore…
        </Button>
        <Button
          onClick={() =>
            void call('data:export').then(
              (r) => r && notify(`Exported to ${r.path}`, 'success'),
              (e: unknown) => notify(errorMessage(e), 'error'),
            )
          }
        >
          Export my data
        </Button>
        <Button variant="danger" onClick={() => setWipeOpen(true)}>
          Delete all data…
        </Button>
      </div>

      <Dialog
        open={backupOpen}
        title="Back up MeshTalk"
        onClose={() => setBackupOpen(false)}
        actions={
          <>
            <Button onClick={() => setBackupOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                void run(async () => {
                  if (includeKey && passphrase !== passphrase2)
                    throw new Error('The passphrases don’t match.');
                  const r = await call('data:backup', {
                    passphrase: includeKey ? passphrase : null,
                  });
                  if (r) {
                    notify(
                      `Backup saved: ${r.fileCount} files, ${formatBytes(r.fileBytes)}.`,
                      'success',
                    );
                    setBackupOpen(false);
                    setPassphrase('');
                    setPassphrase2('');
                  }
                })
              }
            >
              Choose folder and back up
            </Button>
          </>
        }
      >
        <p className="notice">
          Backups are not encrypted. Anyone with the backup folder can read your messages and files.
          Store it on an encrypted drive.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={includeKey}
            onChange={(e) => setIncludeKey(e.target.checked)}
          />
          Include this device’s identity, protected by a passphrase (needed to restore on another
          computer)
        </label>
        {includeKey && (
          <>
            <TextField
              label="Passphrase"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              hint="At least 8 characters. Without it the identity can’t be restored."
            />
            <TextField
              label="Repeat passphrase"
              type="password"
              value={passphrase2}
              onChange={(e) => setPassphrase2(e.target.value)}
            />
          </>
        )}
        {error && <p className="field__error">{error}</p>}
      </Dialog>

      <Dialog
        open={restore !== null}
        title="Restore from backup"
        onClose={() => setRestore(null)}
        actions={
          <>
            <Button onClick={() => setRestore(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                restore &&
                void run(async () => {
                  const r = await call('data:restore', {
                    path: restore.path,
                    passphrase: needsPass ? restorePass : null,
                  });
                  if (r.needsPassphrase) setNeedsPass(true);
                  else notify('Restoring… MeshTalk will restart.', 'info');
                })
              }
            >
              Replace my data and restart
            </Button>
          </>
        }
      >
        {restore && (
          <>
            <p>
              Backup from {new Date(restore.createdAt).toLocaleString()} with {restore.fileCount}{' '}
              files ({formatBytes(restore.fileBytes)})
              {restore.sameDevice ? ', made on this device.' : ', made on another device.'}
            </p>
            <p className="notice">
              Your current data is moved aside (not deleted) to a “pre-restore” folder inside
              MeshTalk’s data folder.
            </p>
            {needsPass && (
              <TextField
                label="Backup passphrase"
                type="password"
                value={restorePass}
                onChange={(e) => setRestorePass(e.target.value)}
                hint="This computer can’t unlock the backed-up identity without it."
              />
            )}
            {error && <p className="field__error">{error}</p>}
          </>
        )}
      </Dialog>

      <Dialog
        open={wipeOpen}
        title="Delete all MeshTalk data on this computer"
        onClose={() => setWipeOpen(false)}
        actions={
          <>
            <Button onClick={() => setWipeOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={wipeText !== 'DELETE'}
              loading={busy}
              onClick={() =>
                void run(async () => void (await call('data:wipe', { confirm: 'DELETE' })))
              }
            >
              Delete everything and restart
            </Button>
          </>
        }
      >
        <p>
          This removes your profile, device identity, contacts, messages, files and settings from
          this computer. Copies your contacts already received stay on their devices. This cannot be
          undone.
        </p>
        <TextField
          label="Type DELETE to confirm"
          value={wipeText}
          onChange={(e) => setWipeText(e.target.value)}
        />
      </Dialog>
    </Card>
  );
}
