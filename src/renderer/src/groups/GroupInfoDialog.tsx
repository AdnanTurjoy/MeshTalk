import { useState } from 'react';
import type { GroupDetails, GroupMember } from '../../../shared/groups';
import { Avatar } from '../components/Avatar';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Switch } from '../components/Switch';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { call, errorMessage } from '../lib/api';
import { useLiveQuery } from '../lib/useLiveQuery';

export function GroupInfoDialog({
  groupId,
  open,
  onClose,
}: {
  groupId: string;
  open: boolean;
  onClose(): void;
}) {
  const group = useLiveQuery(() => call('groups:get', { groupId }), ['groups-changed'], [groupId]);
  const g = group.data;
  return (
    <Dialog
      open={open}
      title={g?.name ?? 'Group'}
      onClose={onClose}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      {g && <GroupInfo group={g} onClose={onClose} />}
    </Dialog>
  );
}

function GroupInfo({ group: g, onClose }: { group: GroupDetails; onClose(): void }) {
  const notify = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(g.name);
  const [description, setDescription] = useState(g.description);
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<'leave' | 'delete' | null>(null);

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) notify(success, 'success');
      return true;
    } catch (error) {
      notify(errorMessage(error), 'error');
      return false;
    }
  };

  return (
    <div className="stack">
      {editing ? (
        <div className="stack">
          <TextField
            label="Group name"
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label="Description"
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="row">
            <Button
              variant="primary"
              onClick={() =>
                void run(() => call('groups:update', { groupId: g.id, name, description })).then(
                  (ok) => ok && setEditing(false),
                )
              }
            >
              Save
            </Button>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="row row--between">
          <p className="muted">{g.description || 'No description.'}</p>
          {g.canEdit && (
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
      )}

      {g.myStatus !== 'active' && (
        <p className="notice">
          {g.myStatus === 'invited'
            ? 'You have not joined this group yet.'
            : g.myStatus === 'left'
              ? 'You left this group.'
              : g.myStatus === 'removed'
                ? 'You were removed from this group.'
                : 'This group was deleted.'}
        </p>
      )}

      {g.canEdit && (
        <>
          <Switch
            label="Only admins can post"
            checked={g.policy === 'admins'}
            onChange={(v) =>
              void run(() =>
                call('groups:update', { groupId: g.id, policy: v ? 'admins' : 'everyone' }),
              )
            }
          />
          <Switch
            label="Let my contacts find this group"
            checked={g.discoverable}
            onChange={(v) =>
              void run(() => call('groups:update', { groupId: g.id, discoverable: v }))
            }
          />
        </>
      )}

      {g.joinRequests.length > 0 && (
        <div className="stack">
          <strong>Requests to join</strong>
          <ul className="list">
            {g.joinRequests.map((r) => (
              <li key={r.deviceId} className="list-item">
                <Avatar name={r.displayName} />
                <div className="list-item__main">
                  <span className="list-item__title">{r.displayName}</span>
                  {r.note && <span className="list-item__meta">“{r.note}”</span>}
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    void run(() =>
                      call('groups:decide-join', {
                        groupId: g.id,
                        deviceId: r.deviceId,
                        approve: true,
                      }),
                    )
                  }
                >
                  Add
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    void run(() =>
                      call('groups:decide-join', {
                        groupId: g.id,
                        deviceId: r.deviceId,
                        approve: false,
                      }),
                    )
                  }
                >
                  Ignore
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="row row--between">
        <strong>{g.members.length} members</strong>
        {g.canInvite && (
          <Button size="sm" onClick={() => setInviting((v) => !v)}>
            {inviting ? 'Done' : 'Invite contacts'}
          </Button>
        )}
      </div>
      {inviting && <InvitePicker group={g} />}
      <ul className="list" aria-label="Members">
        {g.members.map((m) => (
          <MemberRow key={m.deviceId} group={g} member={m} run={run} />
        ))}
      </ul>

      <div className="row">
        {g.myStatus === 'active' &&
          (confirm === 'leave' ? (
            <>
              <span>Leave “{g.name}”?</span>
              <Button
                variant="danger"
                onClick={() =>
                  void run(() => call('groups:leave', { groupId: g.id })).then(
                    (ok) => ok && onClose(),
                  )
                }
              >
                Leave
              </Button>
              <Button onClick={() => setConfirm(null)}>Stay</Button>
            </>
          ) : (
            <Button variant="danger" onClick={() => setConfirm('leave')}>
              Leave group
            </Button>
          ))}
        {g.canDelete &&
          (confirm === 'delete' ? (
            <>
              <span>Delete for everyone? Members keep their history but can’t post.</span>
              <Button
                variant="danger"
                onClick={() =>
                  void run(() => call('groups:delete', { groupId: g.id })).then(
                    (ok) => ok && onClose(),
                  )
                }
              >
                Delete
              </Button>
              <Button onClick={() => setConfirm(null)}>Keep</Button>
            </>
          ) : (
            confirm === null && (
              <Button variant="danger" onClick={() => setConfirm('delete')}>
                Delete group
              </Button>
            )
          ))}
      </div>
    </div>
  );
}

function MemberRow({
  group: g,
  member: m,
  run,
}: {
  group: GroupDetails;
  member: GroupMember;
  run(fn: () => Promise<unknown>, success?: string): Promise<boolean>;
}) {
  return (
    <li className="list-item">
      <Avatar name={m.displayName} online={m.online} />
      <div className="list-item__main">
        <span className="list-item__title">
          {m.displayName}
          {m.isMe && ' (you)'}
          {m.role !== 'member' && (
            <Badge tone="info">{m.role === 'owner' ? 'Owner' : 'Admin'}</Badge>
          )}
          {m.status === 'invited' && <Badge>Invited</Badge>}
        </span>
        <span className="list-item__meta">
          {m.online ? 'Online' : 'Offline'}
          {!m.isMe && !m.isContact && ' · not in your contacts'}
        </span>
      </div>
      <div className="list-item__actions">
        {m.canChangeRole && m.role !== 'owner' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void run(() =>
                call('groups:set-role', {
                  groupId: g.id,
                  deviceId: m.deviceId,
                  role: m.role === 'admin' ? 'member' : 'admin',
                }),
              )
            }
          >
            {m.role === 'admin' ? 'Remove admin' : 'Make admin'}
          </Button>
        )}
        {m.canChangeRole && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void run(
                () => call('groups:transfer-ownership', { groupId: g.id, deviceId: m.deviceId }),
                'Ownership transferred.',
              )
            }
          >
            Make owner
          </Button>
        )}
        {m.canRemove && (
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              void run(() => call('groups:remove-member', { groupId: g.id, deviceId: m.deviceId }))
            }
          >
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}

function InvitePicker({ group: g }: { group: GroupDetails }) {
  const notify = useToast();
  const contacts = useLiveQuery(() => call('contacts:list'), ['contacts-changed']);
  const candidates = (contacts.data ?? []).filter(
    (c) => c.state === 'accepted' && !g.members.some((m) => m.deviceId === c.deviceId),
  );
  if (candidates.length === 0)
    return <p className="muted">All your contacts are already in this group.</p>;
  return (
    <ul className="list">
      {candidates.map((c) => (
        <li key={c.deviceId} className="list-item">
          <Avatar name={c.displayName} />
          <span className="list-item__main">{c.displayName}</span>
          <Button
            size="sm"
            onClick={() =>
              void call('groups:invite', { groupId: g.id, deviceIds: [c.deviceId] }).then(
                () => notify(`Invited ${c.displayName}.`, 'success'),
                (e: unknown) => notify(errorMessage(e), 'error'),
              )
            }
          >
            Invite
          </Button>
        </li>
      ))}
    </ul>
  );
}
