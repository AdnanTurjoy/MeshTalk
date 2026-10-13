import { useState, type FormEvent } from 'react';
import {
  addressSchema,
  type ConnectionTestResult,
  type ConnectionTestStage,
} from '../../../shared/peers';
import type { SettingUpdate, Settings } from '../../../shared/settings';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Fingerprint } from '../components/Fingerprint';
import { KeyValueList } from '../components/KeyValueList';
import { Spinner } from '../components/Spinner';
import { Switch } from '../components/Switch';
import { TextField } from '../components/TextField';
import { call, errorMessage } from '../lib/api';
import { useLiveQuery } from '../lib/useLiveQuery';
import { useSettingToggle } from '../lib/useSettingToggle';

const tips: Partial<Record<ConnectionTestStage, string[]>> = {
  tcp_timeout: [
    'Make sure both devices are on the same Wi-Fi or wired network.',
    'Guest and public Wi-Fi often stop devices from reaching each other ("client isolation").',
    'On Windows, set the network to Private and allow MeshTalk through the firewall.',
    'On macOS, allow MeshTalk in System Settings → Privacy & Security → Local Network.',
  ],
  tcp_refused: [
    'Check that MeshTalk is open on the other device.',
    'Check the port: it is shown on the other device’s Network screen.',
  ],
  unreachable: [
    'This address is on a network your computer cannot reach. Check for typos or VPNs.',
  ],
  dns: ['Try the numeric IP address instead of the host name.'],
  identity_mismatch: [
    'A different device answered than the one you expected. Do not accept requests from it until you have checked fingerprints in person.',
  ],
};

interface NetworkScreenProps {
  settings: Settings;
  onUpdate(change: SettingUpdate): Promise<Settings>;
}

export function NetworkScreen({ settings, onUpdate }: NetworkScreenProps) {
  const status = useLiveQuery(() => call('network:status'), ['network-changed']);
  const identity = useLiveQuery(() => call('identity:get'));
  const [discovery, setDiscovery] = useSettingToggle(settings, onUpdate, 'discoveryEnabled');
  const s = status.data;

  return (
    <div className="page">
      <header className="page__header">
        <h1>Network</h1>
        <p className="muted">
          How this device is reachable, and tools to find out why a connection fails.
        </p>
      </header>

      {!s && <Spinner label="Checking network…" />}

      {s && (
        <Card title="This device">
          {s.listener ? (
            <KeyValueList
              items={[
                [
                  'Others can add you at',
                  s.listener.addresses.length ? (
                    <span className="stack" style={{ gap: 2 }}>
                      {s.listener.addresses.map((a) => (
                        <code key={a}>
                          {a}:{s.listener?.port}
                        </code>
                      ))}
                    </span>
                  ) : (
                    'Not connected to a network'
                  ),
                ],
                ['Connected devices', String(s.connectedPeers)],
                [
                  'Key storage',
                  identity.data?.secretStorage.secure ? (
                    <Badge tone="success">Protected by {identity.data.secretStorage.backend}</Badge>
                  ) : (
                    <Badge tone="warning">Not protected by a system keychain</Badge>
                  ),
                ],
              ]}
            />
          ) : (
            <p className="notice notice--danger" role="alert">
              {s.listenerError ?? 'Not accepting connections.'}
            </p>
          )}
          {identity.data && (
            <div className="stack">
              <strong>Your fingerprint</strong>
              <Fingerprint value={identity.data.fingerprint} label="Your fingerprint" />
            </div>
          )}
          {identity.data && !identity.data.secretStorage.secure && (
            <p className="notice">
              No system keychain is available, so this device’s private key is stored without
              encryption. Anyone who can read your files could impersonate this device. On Linux,
              install and unlock GNOME Keyring or KWallet.
            </p>
          )}
        </Card>
      )}

      {s && (
        <Card title="Discovery">
          <Switch
            label="Let people on this network find me"
            description="Announces a random device code over mDNS and lists other MeshTalk devices. Your name is never announced."
            checked={discovery}
            onChange={(v) => void setDiscovery(v)}
          />
          <div className="row">
            Status:
            {s.discovery === 'on' && <Badge tone="success">Running</Badge>}
            {s.discovery === 'off' && <Badge>Off</Badge>}
            {s.discovery === 'error' && <Badge tone="danger">Not working</Badge>}
          </div>
          {s.discoveryError && <p className="notice notice--danger">{s.discoveryError}</p>}
        </Card>
      )}

      <ConnectionTestCard />
    </div>
  );
}

function ConnectionTestCard() {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('47820');
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = addressSchema.safeParse({ host, port: Number(port) });
    if (!parsed.success) {
      setError('Enter an IP address or host name and a port between 1 and 65535.');
      return;
    }
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      setResult(await call('network:test', parsed.data));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Test a connection"
      description="Checks, step by step, whether this device can reach MeshTalk at an address. Nothing is sent except the connection itself."
    >
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <div className="form-grid form-grid--address">
          <TextField
            label="Address"
            placeholder="192.168.1.20"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
          <TextField
            label="Port"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" loading={busy}>
            Run test
          </Button>
        </div>
      </form>
      {result && (
        <div className="stack" role="status" data-testid="connection-test-result">
          <div className="row">
            {result.stage === 'ok' ? (
              <Badge tone="success">Reachable</Badge>
            ) : (
              <Badge tone="danger">Failed</Badge>
            )}
            {result.latencyMs !== null && <span className="muted">{result.latencyMs} ms</span>}
          </div>
          <p>{result.message}</p>
          {result.fingerprint && (
            <>
              <span className="field__hint">Device fingerprint at that address:</span>
              <Fingerprint value={result.fingerprint} />
            </>
          )}
          {tips[result.stage] && (
            <ul>
              {tips[result.stage]?.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
