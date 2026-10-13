import { useEffect } from 'react';
import type { CallRecord } from '../../../shared/calls';
import { Avatar } from '../components/Avatar';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';
import { calls, useCall } from '../calls/call-controller';
import { call } from '../lib/api';
import { formatRelativeTime } from '../lib/format';
import { useLiveQuery } from '../lib/useLiveQuery';
import { formatDuration } from '../media/waveform';

export function CallsScreen() {
  const history = useLiveQuery(() => call('call:history'), ['calls-changed']);
  const state = useCall();
  const missed = history.data?.missed ?? 0;

  useEffect(() => {
    if (missed > 0) void call('call:mark-seen');
  }, [missed]);

  const busy = state.phase !== 'idle' && state.phase !== 'ended';
  return (
    <div className="page">
      <header className="page__header">
        <h1>Calls</h1>
        <p className="muted">
          Calls go directly between devices and are encrypted end to end. Start a call from a
          conversation with a contact who is online.
        </p>
      </header>
      <Card title="Recent calls">
        {history.status === 'loading' ? (
          <Spinner label="Loading…" />
        ) : (history.data?.calls ?? []).length === 0 ? (
          <p className="empty">No calls yet.</p>
        ) : (
          <ul className="list">
            {history.data?.calls.map((c) => (
              <li key={c.id} className="list-item">
                <Avatar name={c.peerName} />
                <div className="list-item__main">
                  <span className="list-item__title">
                    {c.peerName} <CallBadge record={c} />
                  </span>
                  <span className="list-item__meta">
                    {c.direction === 'incoming' ? 'Incoming' : 'Outgoing'} {c.kind} call ·{' '}
                    {formatRelativeTime(c.createdAt)}
                    {c.answeredAt && c.endedAt
                      ? ` · ${formatDuration(c.endedAt - c.answeredAt)}`
                      : ''}
                  </span>
                </div>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void calls.startCall(c.conversationId, c.peerName, c.kind)}
                >
                  Call back
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CallBadge({ record: c }: { record: CallRecord }) {
  if (c.direction === 'incoming' && !c.answeredAt && c.endReason !== 'declined')
    return <Badge tone="danger">Missed</Badge>;
  if (c.endReason === 'declined') return <Badge>Declined</Badge>;
  if (c.endReason === 'busy') return <Badge>Busy</Badge>;
  if (c.endReason === 'connection_lost') return <Badge tone="warning">Dropped</Badge>;
  if (c.relayed) return <Badge tone="warning">Relayed</Badge>;
  return null;
}
