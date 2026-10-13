import { Button } from '../components/Button';
import { useToast } from '../components/Toast';
import { call, errorMessage } from '../lib/api';
import { useLiveQuery } from '../lib/useLiveQuery';

/** Pending group invitations, shown above the conversation list. */
export function GroupInvites({ onJoined }: { onJoined(conversationId: string): void }) {
  const groups = useLiveQuery(() => call('groups:list'), ['groups-changed']);
  const notify = useToast();
  const invites = (groups.data ?? []).filter((g) => g.myStatus === 'invited');
  if (invites.length === 0) return null;
  return (
    <section className="invites" aria-label="Group invitations">
      {invites.map((g) => (
        <div key={g.id} className="invite">
          <div className="list-item__main">
            <strong className="list-item__title">{g.name}</strong>
            <span className="list-item__meta">
              {g.invitedByName ?? 'A contact'} invited you · {g.members.length} members
            </span>
          </div>
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              void call('groups:accept-invite', { groupId: g.id }).then(
                (d) => onJoined(d.conversationId),
                (e: unknown) => notify(errorMessage(e), 'error'),
              )
            }
          >
            Join
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void call('groups:decline-invite', { groupId: g.id }).catch((e: unknown) =>
                notify(errorMessage(e), 'error'),
              )
            }
          >
            Decline
          </Button>
        </div>
      ))}
    </section>
  );
}
