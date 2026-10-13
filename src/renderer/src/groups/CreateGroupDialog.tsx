import { useState } from 'react';
import { groupNameSchema } from '../../../shared/groups';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Switch } from '../components/Switch';
import { TextField } from '../components/TextField';
import { call, errorMessage } from '../lib/api';
import { useLiveQuery } from '../lib/useLiveQuery';

export function CreateGroupDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  onCreated(conversationId: string): void;
}) {
  const contacts = useLiveQuery(() => call('contacts:list'), ['contacts-changed']);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [adminsOnly, setAdminsOnly] = useState(false);
  const [discoverable, setDiscoverable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accepted = (contacts.data ?? []).filter((c) => c.state === 'accepted');

  const reset = () => {
    setName('');
    setDescription('');
    setMembers(new Set());
    setAdminsOnly(false);
    setDiscoverable(false);
    setError(null);
  };

  const create = async () => {
    const parsed = groupNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a group name');
      return;
    }
    setBusy(true);
    try {
      const g = await call('groups:create', {
        name: parsed.data,
        description: description.trim(),
        memberIds: [...members],
        policy: adminsOnly ? 'admins' : 'everyone',
        discoverable,
      });
      reset();
      onCreated(g.conversationId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="New group"
      onClose={() => {
        reset();
        onClose();
      }}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void create()}>
            Create group
          </Button>
        </>
      }
    >
      <TextField
        label="Group name"
        value={name}
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
        error={error}
      />
      <TextField
        label="Description (optional)"
        value={description}
        maxLength={500}
        onChange={(e) => setDescription(e.target.value)}
      />
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field__label">Invite contacts</legend>
        {accepted.length === 0 ? (
          <p className="muted">Add contacts first; you can only invite people you have accepted.</p>
        ) : (
          <div className="check-list">
            {accepted.map((c) => (
              <label key={c.deviceId} className="check-row">
                <input
                  type="checkbox"
                  checked={members.has(c.deviceId)}
                  onChange={(e) => {
                    const next = new Set(members);
                    if (e.target.checked) next.add(c.deviceId);
                    else next.delete(c.deviceId);
                    setMembers(next);
                  }}
                />
                {c.displayName}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <Switch label="Only admins can post" checked={adminsOnly} onChange={setAdminsOnly} />
      <Switch
        label="Let my contacts find this group"
        description="Contacts can see the name and description and ask to join. Others on the network cannot."
        checked={discoverable}
        onChange={setDiscoverable}
      />
      <p className="field__hint">
        This is a local-network group: members exchange messages directly. Someone who is offline
        receives messages once they and the sender are online at the same time.
      </p>
    </Dialog>
  );
}
