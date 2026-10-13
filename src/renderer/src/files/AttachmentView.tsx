import type { ChatMessage } from '../../../shared/chat';
import { Button } from '../components/Button';
import { useToast } from '../components/Toast';
import { call, errorMessage } from '../lib/api';
import { formatBytes } from '../lib/format';
import { VoicePlayer } from '../media/VoicePlayer';
import { formatEta, formatRate, useTransferProgress } from './useTransferProgress';

/** A file inside a message: preview, live progress and the actions its state allows. */
export function AttachmentView({ message, peerName }: { message: ChatMessage; peerName: string }) {
  const a = message.attachment;
  const notify = useToast();
  const live = useTransferProgress(a?.fileId ?? '');
  if (!a) return null;

  const state = live && live.state === a.state ? live.state : a.state;
  const bytesDone = live && live.state === 'transferring' ? live.bytesDone : a.bytesDone;
  const rate = live?.state === 'transferring' ? live.bytesPerSecond : null;
  const incoming = a.direction === 'incoming';
  const pct = a.size > 0 ? Math.min(100, Math.floor((bytesDone / a.size) * 100)) : 100;
  const src = `meshtalk-file://${a.fileId}`;

  const fileId = a.fileId;
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  };
  const saveAs = () =>
    run(async () => {
      if ((await call('files:save-as', { fileId })).saved) notify('Saved.', 'success');
    });

  if (message.kind === 'voice' && a.available) {
    return <VoicePlayer src={src} durationMs={a.durationMs} />;
  }

  return (
    <div className="attachment" data-testid="attachment">
      {a.available && a.previewKind === 'image' && (
        <img className="attachment__image" src={src} alt={a.name} loading="lazy" />
      )}
      {a.available && a.previewKind === 'video' && (
        <video className="attachment__video" src={src} controls preload="metadata">
          <track kind="captions" />
        </video>
      )}
      {a.available && a.previewKind === 'audio' && <audio src={src} controls preload="metadata" />}

      <div className="attachment__info">
        <span className="attachment__icon" aria-hidden="true">
          {a.previewKind === 'image'
            ? '🖼'
            : a.previewKind === 'video'
              ? '🎞'
              : a.previewKind === 'audio'
                ? '🎵'
                : '📄'}
        </span>
        <div className="list-item__main">
          <span className="list-item__title" title={a.name}>
            {a.name}
          </span>
          <span className="list-item__meta">
            {formatBytes(a.size)} ·{' '}
            <StateLabel state={state} incoming={incoming} peerName={peerName} />
          </span>
        </div>
      </div>

      {(state === 'transferring' || state === 'paused' || state === 'waiting') && a.size > 0 && (
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`${a.name} progress`}
        >
          <div className="progress__bar" style={{ width: `${pct}%` }} />
          <span className="progress__text">
            {pct}% · {formatBytes(bytesDone)} of {formatBytes(a.size)}
            {rate ? ` · ${formatRate(rate)} · ${formatEta(a.size - bytesDone, rate)}` : ''}
          </span>
        </div>
      )}

      {a.error && state !== 'complete' && <p className="field__error">{a.error}</p>}
      {a.executable && incoming && state === 'offered' && (
        <p className="notice notice--danger">
          This is a program or script. Only accept it if you trust {peerName} and expected it.
          MeshTalk will never run it for you.
        </p>
      )}

      <div className="row">
        {incoming && state === 'offered' && (
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void run(() => call('files:accept', { fileId }))}
            >
              Download
            </Button>
            <Button size="sm" onClick={() => void run(() => call('files:decline', { fileId }))}>
              Decline
            </Button>
          </>
        )}
        {incoming && (state === 'transferring' || state === 'waiting') && (
          <Button size="sm" onClick={() => void run(() => call('files:pause', { fileId }))}>
            Pause
          </Button>
        )}
        {incoming && state === 'paused' && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void run(() => call('files:resume', { fileId }))}
          >
            Resume
          </Button>
        )}
        {(state === 'transferring' ||
          state === 'waiting' ||
          state === 'paused' ||
          (!incoming && state === 'offered')) && (
          <Button
            size="sm"
            variant="danger"
            onClick={() => void run(() => call('files:cancel', { fileId }))}
          >
            Cancel
          </Button>
        )}
        {incoming && (state === 'failed' || state === 'cancelled') && (
          <Button size="sm" onClick={() => void run(() => call('files:accept', { fileId }))}>
            Retry
          </Button>
        )}
        {a.available && (
          <>
            <Button size="sm" onClick={() => void saveAs()}>
              Save as…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void run(() => call('files:show-in-folder', { fileId }))}
            >
              Show in folder
            </Button>
            {!a.executable && !a.previewKind && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void run(() => call('files:open', { fileId }))}
              >
                Open
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StateLabel({
  state,
  incoming,
  peerName,
}: {
  state: string;
  incoming: boolean;
  peerName: string;
}) {
  switch (state) {
    case 'offered':
      return <>{incoming ? 'Not downloaded' : `Waiting for ${peerName} to accept`}</>;
    case 'waiting':
      return <>Waiting for {peerName} to come online</>;
    case 'transferring':
      return <>{incoming ? 'Downloading' : 'Sending'}</>;
    case 'paused':
      return <>Paused</>;
    case 'complete':
      return <>{incoming ? 'Downloaded and verified' : 'Delivered'}</>;
    case 'failed':
      return <>Failed</>;
    case 'cancelled':
      return <>Cancelled</>;
    case 'declined':
      return <>{incoming ? 'Declined' : `${peerName} declined`}</>;
    default:
      return null;
  }
}
