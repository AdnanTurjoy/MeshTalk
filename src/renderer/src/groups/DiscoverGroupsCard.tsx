import { useState } from 'react';
import type { DiscoveredGroup } from '../../../shared/groups';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { useToast } from '../components/Toast';
import { call, errorMessage } from '../lib/api';

export function DiscoverGroupsCard() {
  const notify = useToast();
  const [found, setFound] = useState<DiscoveredGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState<Set<string>>(new Set());

  const look = async () => {
    setBusy(true);
    try {
      setFound(await call('groups:discover'));
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Groups"
      description="Groups your online contacts have made findable. You can ask to join; an admin decides."
      actions={
        <Button loading={busy} onClick={() => void look()}>
          Look for groups
        </Button>
      }
    >
      {found && found.length === 0 && (
        <p className="empty">None of your online contacts have findable groups.</p>
      )}
      {found && found.length > 0 && (
        <ul className="list">
          {found.map((g) => (
            <li key={g.groupId} className="list-item">
              <div className="list-item__main">
                <span className="list-item__title">{g.name}</span>
                <span className="list-item__meta">
                  {g.memberCount} members · via {g.adminName}
                  {g.description ? ` · ${g.description}` : ''}
                </span>
              </div>
              <Button
                size="sm"
                variant="primary"
                disabled={requested.has(g.groupId)}
                onClick={() =>
                  void call('groups:request-join', {
                    groupId: g.groupId,
                    adminDeviceId: g.adminDeviceId,
                    note: '',
                  }).then(
                    () => setRequested(new Set([...requested, g.groupId])),
                    (e: unknown) => notify(errorMessage(e), 'error'),
                  )
                }
              >
                {requested.has(g.groupId) ? 'Requested' : 'Ask to join'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
