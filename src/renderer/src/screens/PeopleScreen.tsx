import { useState, type FormEvent } from 'react';
import { addressSchema, type Contact, type NearbyDevice } from '../../../shared/peers';
import type { SettingUpdate, Settings } from '../../../shared/settings';
import { Avatar } from '../components/Avatar';
import { DiscoverGroupsCard } from '../groups/DiscoverGroupsCard';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Dialog } from '../components/Dialog';
import { Fingerprint } from '../components/Fingerprint';
import { Spinner } from '../components/Spinner';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { call, errorMessage } from '../lib/api';
import { formatRelativeTime } from '../lib/format';
import { useLiveQuery } from '../lib/useLiveQuery';
import { useSettingToggle } from '../lib/useSettingToggle';

interface PeopleScreenProps {
  settings: Settings;
  onUpdate(change: SettingUpdate): Promise<Settings>;
  onOpenChat?(deviceId: string): void;
}

export function PeopleScreen({ settings, onUpdate, onOpenChat }: PeopleScreenProps) {
  const contacts = useLiveQuery(() => call('contacts:list'), ['contacts-changed']);
  const nearby = useLiveQuery(() => call('nearby:list'), ['nearby-changed', 'contacts-changed']);
  const [selected, setSelected] = useState<string | null>(null);

  const list = contacts.data ?? [];
  const incoming = list.filter((c) => c.state === 'incoming');
  const accepted = list.filter((c) => c.state === 'accepted');
  const sent = list.filter((c) => c.state === 'outgoing' || c.state === 'declined');
  const blocked = list.filter((c) => c.state === 'blocked');
  const selectedContact = list.find((c) => c.deviceId === selected) ?? null;

  return (
    <div className="page">
      <header className="page__header">
        <h1>People</h1>
        <p className="muted">Contacts are people you have approved. Only they can message you.</p>
      </header>

      {contacts.status === 'loading' && <Spinner label="Loading contacts…" />}
      {contacts.error && (
        <p className="notice notice--danger" role="alert">
          {contacts.error}
        </p>
      )}

      {incoming.length > 0 && (
        <Card title="Contact requests" description="Check who this is before you accept.">
          <ul className="list">
            {incoming.map((c) => (
              <IncomingRequest key={c.deviceId} contact={c} />
            ))}
          </ul>
        </Card>
      )}

      <Card title="Contacts">
        {accepted.length === 0 ? (
          <p className="empty">
            No contacts yet. Find people nearby, or add someone by their address below.
          </p>
        ) : (
          <ul className="list">
            {accepted.map((c) => (
              <li key={c.deviceId} className="list-item">
                <Avatar name={c.displayName} online={c.online} />
                <div className="list-item__main">
                  <span className="list-item__title">
                    {c.displayName}
                    {c.verified && <Badge tone="success">Verified</Badge>}
                    {c.nameCollision && <Badge tone="warning">Same name as another contact</Badge>}
                  </span>
                  <span className="list-item__meta">
                    {c.online
                      ? 'Online'
                      : c.lastSeenAt
                        ? `Last seen ${formatRelativeTime(c.lastSeenAt)}`
                        : 'Offline'}
                    {c.emailLabel ? ` · ${c.emailLabel} (unverified)` : ''}
                  </span>
                </div>
                <div className="list-item__actions">
                  {onOpenChat && (
                    <Button size="sm" variant="primary" onClick={() => onOpenChat(c.deviceId)}>
                      Message
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setSelected(c.deviceId)}>
                    Details
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <NearbyCard
        settings={settings}
        onUpdate={onUpdate}
        devices={nearby.data ?? []}
        loading={nearby.status === 'loading'}
      />

      <AddByAddressCard />

      <DiscoverGroupsCard />

      {sent.length > 0 && (
        <Card title="Sent requests">
          <ul className="list">
            {sent.map((c) => (
              <SentRequest key={c.deviceId} contact={c} />
            ))}
          </ul>
        </Card>
      )}

      {blocked.length > 0 && (
        <Card title="Blocked" description="Blocked devices cannot connect to you or send requests.">
          <ul className="list">
            {blocked.map((c) => (
              <BlockedRow key={c.deviceId} contact={c} />
            ))}
          </ul>
        </Card>
      )}

      <ContactDetailsDialog contact={selectedContact} onClose={() => setSelected(null)} />
    </div>
  );
}

function useAction() {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await action();
      if (success) notify(success, 'success');
      return true;
    } catch (error) {
      notify(errorMessage(error), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function IncomingRequest({ contact }: { contact: Contact }) {
  const { busy, run } = useAction();
  return (
    <li className="list-item" style={{ alignItems: 'flex-start' }}>
      <Avatar name={contact.displayName} />
      <div className="list-item__main stack" style={{ gap: 'var(--space-2)' }}>
        <span className="list-item__title">{contact.displayName}</span>
        <span className="list-item__meta">
          {contact.emailLabel ? `${contact.emailLabel} (unverified)` : 'No email given'} ·{' '}
          {formatRelativeTime(contact.createdAt)}
        </span>
        {contact.requestNote && <p>“{contact.requestNote}”</p>}
        {contact.nameCollision && (
          <p className="notice notice--danger">
            You already have a contact called “{contact.displayName}” on a different device. This
            could be someone pretending to be them. Ask them in person before accepting.
          </p>
        )}
        <div className="stack" style={{ gap: 'var(--space-1)' }}>
          <span className="field__hint">
            Device fingerprint, ask them to confirm it matches theirs:
          </span>
          <Fingerprint value={contact.fingerprint} label="Fingerprint" />
        </div>
        <div className="row">
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            onClick={() =>
              void run(
                () => call('contacts:accept', { deviceId: contact.deviceId }),
                `${contact.displayName} added.`,
              )
            }
          >
            Accept
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(() => call('contacts:decline', { deviceId: contact.deviceId }))}
          >
            Decline
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() =>
              void run(
                () => call('contacts:block', { deviceId: contact.deviceId }),
                'Device blocked.',
              )
            }
          >
            Block
          </Button>
        </div>
      </div>
    </li>
  );
}

function SentRequest({ contact }: { contact: Contact }) {
  const { busy, run } = useAction();
  return (
    <li className="list-item">
      <Avatar name={contact.displayName} />
      <div className="list-item__main">
        <span className="list-item__title">
          {contact.displayName}
          {contact.state === 'declined' ? (
            <Badge tone="danger">Declined</Badge>
          ) : (
            <Badge>Waiting</Badge>
          )}
        </span>
        <span className="list-item__meta mono">{contact.fingerprint.slice(0, 19)}…</span>
      </div>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => void run(() => call('contacts:remove', { deviceId: contact.deviceId }))}
      >
        {contact.state === 'declined' ? 'Dismiss' : 'Cancel'}
      </Button>
    </li>
  );
}

function BlockedRow({ contact }: { contact: Contact }) {
  const { busy, run } = useAction();
  return (
    <li className="list-item">
      <Avatar name={contact.displayName} />
      <div className="list-item__main">
        <span className="list-item__title">{contact.displayName}</span>
        <span className="list-item__meta mono">{contact.fingerprint.slice(0, 19)}…</span>
      </div>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => void run(() => call('contacts:unblock', { deviceId: contact.deviceId }))}
      >
        Unblock
      </Button>
    </li>
  );
}

function NearbyCard({
  settings,
  onUpdate,
  devices,
  loading,
}: {
  settings: Settings;
  onUpdate(change: SettingUpdate): Promise<Settings>;
  devices: NearbyDevice[];
  loading: boolean;
}) {
  const [enabled, setEnabled] = useSettingToggle(settings, onUpdate, 'discoveryEnabled');
  const visible = devices.filter((d) => d.contactState !== 'blocked');

  if (!enabled) {
    return (
      <Card
        title="Nearby"
        description="Discovery is off. Turn it on to see other MeshTalk devices on this network and be seen by them. Only a random device code is announced, never your name."
        actions={
          <Button variant="primary" onClick={() => void setEnabled(true)}>
            Turn on discovery
          </Button>
        }
      />
    );
  }

  return (
    <Card
      title="Nearby"
      description="MeshTalk devices announcing themselves on this network. Names appear only for contacts."
    >
      {loading ? (
        <Spinner label="Looking for devices…" />
      ) : visible.length === 0 ? (
        <p className="empty">
          No other devices found yet. If you expect some, check the Network screen. Some Wi-Fi
          networks block devices from seeing each other.
        </p>
      ) : (
        <ul className="list">
          {visible.map((d) => (
            <NearbyRow key={d.deviceId} device={d} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function NearbyRow({ device }: { device: NearbyDevice }) {
  const { busy, run } = useAction();
  const label = device.displayName ?? `Unknown device ${device.fingerprint.slice(0, 9)}`;
  return (
    <li className="list-item">
      <Avatar name={device.displayName ?? '?'} />
      <div className="list-item__main">
        <span className="list-item__title">{label}</span>
        <span className="list-item__meta">
          {device.host}:{device.port} · seen {formatRelativeTime(device.lastSeenAt)}
        </span>
      </div>
      {device.contactState === null && (
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          onClick={() =>
            void run(
              () => call('contacts:request-nearby', { deviceId: device.deviceId, note: null }),
              'Request sent.',
            )
          }
        >
          Send request
        </Button>
      )}
      {device.contactState === 'outgoing' && <Badge>Request sent</Badge>}
      {device.contactState === 'incoming' && <Badge tone="info">Wants to connect</Badge>}
      {device.contactState === 'accepted' && <Badge tone="success">Contact</Badge>}
    </li>
  );
}

function AddByAddressCard() {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('47820');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Contact | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = addressSchema.safeParse({ host, port: Number(port) });
    if (!parsed.success) {
      setError('Enter an IP address or host name and a port between 1 and 65535.');
      return;
    }
    setError(null);
    setSent(null);
    setBusy(true);
    try {
      setSent(await call('contacts:request-address', { ...parsed.data, note: note || null }));
      setNote('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Add by address"
      description="Use this when discovery doesn't work. The other person can find their address on their Network screen."
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
        <TextField
          label="Message (optional)"
          maxLength={280}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" loading={busy}>
            Send request
          </Button>
        </div>
      </form>
      {sent && (
        <div className="notice notice--info stack" role="status">
          <span>
            Request sent to the device at that address. Before trusting it, ask the other person to
            read out their fingerprint and check it matches:
          </span>
          <Fingerprint value={sent.fingerprint} label="Their fingerprint" />
        </div>
      )}
    </Card>
  );
}

function ContactDetailsDialog({ contact, onClose }: { contact: Contact | null; onClose(): void }) {
  const identity = useLiveQuery(() => call('identity:get'));
  const { busy, run } = useAction();
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <Dialog
      open={contact !== null}
      title={contact?.displayName ?? ''}
      onClose={() => {
        setConfirmRemove(false);
        onClose();
      }}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      {contact && (
        <>
          <p className="muted">
            Compare fingerprints in person or over a call you trust. If both match, mark this
            contact as verified. If their fingerprint ever changes, it is a different device.
          </p>
          <div className="stack">
            <strong>Their fingerprint</strong>
            <Fingerprint value={contact.fingerprint} label="Their fingerprint" />
            <strong>Your fingerprint</strong>
            {identity.data && (
              <Fingerprint value={identity.data.fingerprint} label="Your fingerprint" />
            )}
          </div>
          <div className="row">
            <Button
              variant={contact.verified ? 'secondary' : 'primary'}
              loading={busy}
              onClick={() =>
                void run(() =>
                  call('contacts:set-verified', {
                    deviceId: contact.deviceId,
                    verified: !contact.verified,
                  }),
                )
              }
            >
              {contact.verified ? 'Mark as not verified' : 'Fingerprints match: mark verified'}
            </Button>
          </div>
          <div className="row">
            {confirmRemove ? (
              <>
                <span>Remove {contact.displayName}? They will need to send a new request.</span>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(() => call('contacts:remove', { deviceId: contact.deviceId })).then(
                      onClose,
                    )
                  }
                >
                  Remove
                </Button>
                <Button onClick={() => setConfirmRemove(false)}>Keep</Button>
              </>
            ) : (
              <>
                <Button variant="danger" onClick={() => setConfirmRemove(true)}>
                  Remove contact
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => call('contacts:block', { deviceId: contact.deviceId }),
                      'Device blocked.',
                    ).then(onClose)
                  }
                >
                  Block
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
