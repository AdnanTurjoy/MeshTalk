import { useState } from 'react';
import type { TransferListItem } from '../../../shared/files';
import { Badge, type BadgeTone } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { KeyValueList } from '../components/KeyValueList';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { formatEta, formatRate, useTransferProgress } from '../files/useTransferProgress';
import { call, errorMessage } from '../lib/api';
import { formatBytes, formatRelativeTime } from '../lib/format';
import { useLiveQuery } from '../lib/useLiveQuery';

const tone: Record<TransferListItem['state'], BadgeTone> = {
  offered: 'neutral',
  waiting: 'warning',
  transferring: 'info',
  paused: 'warning',
  complete: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  declined: 'neutral',
};

const label: Record<TransferListItem['state'], string> = {
  offered: 'Not accepted yet',
  waiting: 'Waiting for device',
  transferring: 'In progress',
  paused: 'Paused',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
  declined: 'Declined',
};

export function FilesScreen() {
  const transfers = useLiveQuery(() => call('transfers:list'), ['files-changed']);
  const usage = useLiveQuery(() => call('storage:usage'), ['files-changed']);
  const notify = useToast();
  const [confirm, setConfirm] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) notify(success, 'success');
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  };

  const active = (transfers.data ?? []).filter((t) =>
    ['offered', 'waiting', 'transferring', 'paused'].includes(t.state),
  );
  const done = (transfers.data ?? []).filter((t) => !active.includes(t)).slice(0, 50);
  const u = usage.data;

  return (
    <div className="page">
      <header className="page__header">
        <h1>Files</h1>
        <p className="muted">
          Transfers between your devices and your contacts, and the space they use on this computer.
        </p>
      </header>

      <Card title="Active transfers">
        {transfers.status === 'loading' ? (
          <Spinner label="Loading…" />
        ) : active.length === 0 ? (
          <p className="empty">Nothing is transferring right now.</p>
        ) : (
          <ul className="list">
            {active.map((t) => (
              <TransferRow key={`${t.fileId}|${t.peerDeviceId}`} item={t} onRun={run} />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Storage"
        description="Files are kept in MeshTalk’s data folder, never inside the database."
      >
        {!u ? (
          <Spinner label="Measuring…" />
        ) : (
          <>
            <KeyValueList
              items={[
                ['Received files', formatBytes(u.receivedBytes)],
                ['Voice notes and pasted files you sent', formatBytes(u.sentCopiesBytes)],
                ['Unfinished downloads', formatBytes(u.partialBytes)],
                ['Message database', formatBytes(u.databaseBytes)],
                ['Free disk space', u.freeBytes === null ? 'Unknown' : formatBytes(u.freeBytes)],
              ]}
            />
            <div>
              <Button
                disabled={u.partialBytes === 0}
                onClick={() =>
                  void run(async () => {
                    const { removed } = await call('storage:clear-partial');
                    notify(
                      removed
                        ? `Removed ${removed} unfinished download(s).`
                        : 'Nothing to clean up.',
                      'success',
                    );
                  })
                }
              >
                Clean up failed downloads
              </Button>
            </div>
            {u.largest.length > 0 && (
              <>
                <h3>Largest files</h3>
                <ul className="list">
                  {u.largest.map((f) => (
                    <li key={f.fileId} className="list-item">
                      <div className="list-item__main">
                        <span className="list-item__title">{f.name}</span>
                        <span className="list-item__meta">
                          {formatBytes(f.size)} · {f.direction === 'incoming' ? 'from' : 'to'}{' '}
                          {f.conversationTitle}
                        </span>
                      </div>
                      {confirm === f.fileId ? (
                        <div className="list-item__actions">
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() =>
                              void run(
                                () => call('files:remove', { fileId: f.fileId }),
                                'Removed from this device.',
                              ).then(() => setConfirm(null))
                            }
                          >
                            Remove
                          </Button>
                          <Button size="sm" onClick={() => setConfirm(null)}>
                            Keep
                          </Button>
                        </div>
                      ) : (
                        <div className="list-item__actions">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              void run(() => call('files:show-in-folder', { fileId: f.fileId }))
                            }
                          >
                            Show
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setConfirm(f.fileId)}>
                            Remove…
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="field__hint">
                  Removing deletes the copy on this computer. The message stays in the conversation.
                </p>
              </>
            )}
          </>
        )}
      </Card>

      <Card title="History">
        {done.length === 0 ? (
          <p className="empty">No finished transfers yet.</p>
        ) : (
          <ul className="list">
            {done.map((t) => (
              <TransferRow key={`${t.fileId}|${t.peerDeviceId}`} item={t} onRun={run} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function TransferRow({
  item: t,
  onRun,
}: {
  item: TransferListItem;
  onRun(fn: () => Promise<unknown>, success?: string): Promise<void>;
}) {
  const live = useTransferProgress(t.fileId);
  const bytes = live?.state === 'transferring' ? live.bytesDone : t.bytesDone;
  const rate = live?.state === 'transferring' ? live.bytesPerSecond : null;
  const incoming = t.direction === 'incoming';
  return (
    <li className="list-item">
      <span aria-hidden="true">{incoming ? '⬇' : '⬆'}</span>
      <div className="list-item__main">
        <span className="list-item__title">
          {t.name} <Badge tone={tone[t.state]}>{label[t.state]}</Badge>
        </span>
        <span className="list-item__meta">
          {incoming ? 'From' : 'To'} {t.peerName} · {formatBytes(bytes)} of {formatBytes(t.size)}
          {rate ? ` · ${formatRate(rate)} · ${formatEta(t.size - bytes, rate)}` : ''} ·{' '}
          {formatRelativeTime(t.updatedAt)}
          {t.error ? ` · ${t.error}` : ''}
        </span>
      </div>
      <div className="list-item__actions">
        {incoming && t.state === 'offered' && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void onRun(() => call('files:accept', { fileId: t.fileId }))}
          >
            Download
          </Button>
        )}
        {incoming && (t.state === 'transferring' || t.state === 'waiting') && (
          <Button
            size="sm"
            onClick={() => void onRun(() => call('files:pause', { fileId: t.fileId }))}
          >
            Pause
          </Button>
        )}
        {incoming && t.state === 'paused' && (
          <Button
            size="sm"
            onClick={() => void onRun(() => call('files:resume', { fileId: t.fileId }))}
          >
            Resume
          </Button>
        )}
        {['offered', 'waiting', 'transferring', 'paused'].includes(t.state) && (
          <Button
            size="sm"
            variant="danger"
            onClick={() => void onRun(() => call('files:cancel', { fileId: t.fileId }))}
          >
            Cancel
          </Button>
        )}
        {incoming && (t.state === 'failed' || t.state === 'cancelled') && (
          <Button
            size="sm"
            onClick={() => void onRun(() => call('files:accept', { fileId: t.fileId }))}
          >
            Retry
          </Button>
        )}
      </div>
    </li>
  );
}
