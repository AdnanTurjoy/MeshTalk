import { useState, type ReactNode } from 'react';
import type { ChatMessage } from '../../../shared/chat';
import { Button } from '../components/Button';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const;

interface MessageBubbleProps {
  message: ChatMessage;
  showSender: boolean;
  highlighted: boolean;
  canInteract: boolean;
  onReply(): void;
  onEdit(): void;
  onDelete(forEveryone: boolean): void;
  onReact(emoji: string, on: boolean): void;
  onJumpTo(messageId: string): void;
  renderAttachment?(message: ChatMessage): ReactNode;
}

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function MessageBubble({
  message: m,
  showSender,
  highlighted,
  canInteract,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onJumpTo,
  renderAttachment,
}: MessageBubbleProps) {
  const [menu, setMenu] = useState<'none' | 'react' | 'delete'>('none');
  const deleted = m.deletedAt !== null;

  return (
    <li
      id={`msg-${m.id}`}
      className={`msg ${m.fromMe ? 'msg--mine' : ''} ${highlighted ? 'msg--highlight' : ''} ${m.mentionsMe ? 'msg--mention' : ''}`}
      aria-label={`${m.fromMe ? 'You' : m.senderName}, ${time.format(m.sentAt)}`}
    >
      <div className="msg__bubble">
        {showSender && !m.fromMe && <div className="msg__sender">{m.senderName}</div>}
        {m.replyTo && (
          <button
            type="button"
            className="msg__reply"
            onClick={() => m.replyTo && onJumpTo(m.replyTo.id)}
          >
            <strong>{m.replyTo.senderName}</strong>
            <span>{m.replyTo.deleted ? 'Message deleted' : m.replyTo.excerpt}</span>
          </button>
        )}
        {deleted ? (
          <p className="msg__body msg__body--deleted">
            {m.fromMe ? 'You deleted this message' : 'This message was deleted'}
          </p>
        ) : (
          <>
            {m.attachment && renderAttachment?.(m)}
            {m.body && <p className="msg__body">{m.body}</p>}
          </>
        )}
        <div className="msg__meta">
          {m.editedAt && !deleted && <span>edited</span>}
          <time dateTime={new Date(m.sentAt).toISOString()}>{time.format(m.sentAt)}</time>
          {m.fromMe && <StatusTick status={m.status} />}
        </div>
      </div>

      {m.reactions.length > 0 && (
        <div className="msg__reactions">
          {m.reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              className={`reaction ${r.mine ? 'reaction--mine' : ''}`}
              title={r.names.join(', ')}
              aria-pressed={r.mine}
              aria-label={`${r.emoji} ${r.count}, ${r.names.join(', ')}`}
              disabled={!canInteract}
              onClick={() => onReact(r.emoji, !r.mine)}
            >
              {r.emoji} {r.count}
            </button>
          ))}
        </div>
      )}

      {!deleted && (
        <div className="msg__actions" role="toolbar" aria-label="Message actions">
          {menu === 'react' ? (
            <>
              {QUICK_REACTIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="reaction"
                  aria-label={`React with ${e}`}
                  onClick={() => {
                    setMenu('none');
                    onReact(e, !(m.reactions.find((r) => r.emoji === e)?.mine ?? false));
                  }}
                >
                  {e}
                </button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setMenu('none')}>
                Cancel
              </Button>
            </>
          ) : menu === 'delete' ? (
            <>
              <Button size="sm" variant="danger" onClick={() => onDelete(false)}>
                Delete for me
              </Button>
              {m.fromMe && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => onDelete(true)}
                  title="Removes it from their device too, if they haven't already copied it."
                >
                  Delete for everyone
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setMenu('none')}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {canInteract && (
                <Button size="sm" variant="ghost" onClick={() => setMenu('react')}>
                  React
                </Button>
              )}
              {canInteract && (
                <Button size="sm" variant="ghost" onClick={onReply}>
                  Reply
                </Button>
              )}
              {canInteract && m.fromMe && m.kind === 'text' && (
                <Button size="sm" variant="ghost" onClick={onEdit}>
                  Edit
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setMenu('delete')}>
                Delete
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function StatusTick({ status }: { status: ChatMessage['status'] }) {
  switch (status) {
    case 'pending':
      return (
        <span
          className="msg__status"
          title="Waiting to be delivered. It will send when they are online."
        >
          🕓<span className="visually-hidden">Not delivered yet</span>
        </span>
      );
    case 'delivered':
      return (
        <span className="msg__status" title="Delivered">
          ✓<span className="visually-hidden">Delivered</span>
        </span>
      );
    case 'read':
      return (
        <span className="msg__status msg__status--read" title="Read">
          ✓✓<span className="visually-hidden">Read</span>
        </span>
      );
    case 'failed':
      return <span className="msg__status msg__status--failed">Failed</span>;
    default:
      return null;
  }
}
