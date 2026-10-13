import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ConversationSummary } from '../../../shared/chat';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { call, errorMessage } from '../lib/api';
import { useAppEvent } from '../lib/events';
import { useLiveQuery } from '../lib/useLiveQuery';
import { AttachmentView } from '../files/AttachmentView';
import { AttachControls, useSendFiles } from './AttachControls';
import { findMentions } from '../lib/mentions';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';

const PAGE = 50;
const MAX_WINDOW = 2000;

interface ConversationViewProps {
  conversationId: string;
  jumpToMessageId: string | null;
  onJumped(): void;
  /** Extra header controls (calls, group info). */
  headerExtras?(conversation: ConversationSummary): React.ReactNode;
}

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

export function ConversationView({
  conversationId,
  jumpToMessageId,
  onJumped,
  headerExtras,
}: ConversationViewProps) {
  const notify = useToast();
  const sendFiles = useSendFiles(conversationId);
  const [dragging, setDragging] = useState(false);
  const conversation = useLiveQuery(
    () => call('chat:get-conversation', { conversationId }),
    ['conversations-changed'],
    [conversationId],
  );
  const [limit, setLimit] = useState(PAGE);
  const page = useLiveQuery(
    () => call('chat:list-messages', { conversationId, before: null, limit }),
    [],
    [conversationId, limit],
  );
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [typing, setTyping] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);
  const prevScrollHeight = useRef<number | null>(null);
  const pendingJump = useRef<string | null>(null);
  const { reload: reloadPage } = page;

  useAppEvent(['messages-changed', 'typing'], (event) => {
    if (event.type === 'messages-changed' && event.conversationId === conversationId)
      void reloadPage();
    if (event.type === 'typing' && event.conversationId === conversationId) setTyping(event.on);
  });

  // Tell main which conversation is visible (for read state); clear on leave.
  useEffect(() => {
    void call('chat:set-active', { conversationId });
    return () => {
      void call('chat:set-active', { conversationId: null });
    };
  }, [conversationId]);

  const messages = useMemo(() => page.data?.messages ?? [], [page.data]);
  const hasMore = page.data?.hasMore ?? false;

  // Mark read whenever new incoming messages are shown.
  const newestIncoming = [...messages].reverse().find((m) => !m.fromMe)?.id;
  useEffect(() => {
    if (newestIncoming && document.hasFocus()) void call('chat:mark-read', { conversationId });
  }, [newestIncoming, conversationId]);

  // Keep the view pinned to the bottom, stable when older messages load, or
  // centred on a message we were asked to jump to.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const target = pendingJump.current;
    if (target && messages.some((m) => m.id === target)) {
      pendingJump.current = null;
      prevScrollHeight.current = null;
      stickToBottom.current = false;
      const node = document.getElementById(`msg-${target}`);
      node?.scrollIntoView({ block: 'center' });
      node?.classList.add('msg--highlight');
      setTimeout(() => node?.classList.remove('msg--highlight'), 2500);
      return;
    }
    if (prevScrollHeight.current !== null) {
      el.scrollTop += el.scrollHeight - prevScrollHeight.current;
      prevScrollHeight.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const loadOlder = useCallback(() => {
    if (!hasMore || page.status === 'loading') return;
    prevScrollHeight.current = listRef.current?.scrollHeight ?? null;
    setLimit((l) => Math.min(l + PAGE, MAX_WINDOW));
  }, [hasMore, page.status]);

  /** Makes sure the window includes a message at `position`, then scrolls to it. */
  const applyJump = useCallback(
    (messageId: string, position: number | null) => {
      if (position === null || position > MAX_WINDOW) {
        notify('That message is no longer available here.', 'info');
        return;
      }
      pendingJump.current = messageId;
      setLimit((l) => Math.max(l, position + 10));
      void reloadPage();
    },
    [notify, reloadPage],
  );

  const jumpTo = (messageId: string) =>
    call('chat:message-position', { conversationId, messageId }).then(
      (position) => applyJump(messageId, position),
      (error: unknown) => notify(errorMessage(error), 'error'),
    );

  // Jumps requested from outside (search results).
  useEffect(() => {
    if (!jumpToMessageId) return;
    let cancelled = false;
    call('chat:message-position', { conversationId, messageId: jumpToMessageId }).then(
      (position) => {
        if (!cancelled) applyJump(jumpToMessageId, position);
      },
      () => undefined,
    );
    onJumped();
    return () => {
      cancelled = true;
    };
  }, [jumpToMessageId, conversationId, applyJump, onJumped]);

  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (error) {
      notify(errorMessage(error), 'error');
      return false;
    }
  };

  const c = conversation.data;
  if (!c) {
    return (
      <section className="conv-view conv-view--empty">
        {conversation.error ? (
          <p role="alert">{conversation.error}</p>
        ) : (
          <Spinner label="Opening conversation…" />
        )}
      </section>
    );
  }

  const canInteract = c.cannotSendReason === null;
  const status = typing ? 'typing…' : c.kind === 'direct' ? (c.online ? 'Online' : 'Offline') : '';

  return (
    <section
      className={`conv-view ${dragging ? 'conv-view--drop' : ''}`}
      aria-label={`Conversation with ${c.title}`}
      onDragOver={(e) => {
        if (!canInteract || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (canInteract && e.dataTransfer.files.length) void sendFiles(e.dataTransfer.files);
      }}
    >
      <header className="conv-view__header">
        <Avatar name={c.title} {...(c.kind === 'direct' ? { online: c.online } : {})} />
        <div className="list-item__main">
          <h2 className="conv-view__title">{c.title}</h2>
          <span className="list-item__meta" aria-live="polite">
            {status}
          </span>
        </div>
        {headerExtras?.(c)}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void act(() => call('chat:set-flags', { conversationId, pinned: !c.pinned }))
          }
        >
          {c.pinned ? 'Unpin' : 'Pin'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void act(() => call('chat:set-flags', { conversationId, muted: !c.muted }))
          }
        >
          {c.muted ? 'Unmute' : 'Mute'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void act(() => call('chat:set-flags', { conversationId, archived: !c.archived }))
          }
        >
          {c.archived ? 'Unarchive' : 'Archive'}
        </Button>
      </header>

      {c.pendingCount > 0 && (
        <p className="conv-view__banner" role="status">
          {c.pendingCount === 1 ? '1 update is' : `${c.pendingCount} updates are`} waiting on this
          device and will be delivered when {c.kind === 'direct' ? c.title : 'members'}{' '}
          {c.kind === 'direct' ? 'is' : 'are'} online. MeshTalk has no server that holds messages
          for offline devices.
        </p>
      )}

      <ol
        ref={listRef}
        className="conv-view__messages"
        aria-label="Messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (el.scrollTop < 60) loadOlder();
        }}
      >
        {hasMore && (
          <li className="conv-view__older">
            <Button size="sm" onClick={loadOlder}>
              Load older messages
            </Button>
          </li>
        )}
        {page.status === 'loading' && messages.length === 0 && (
          <li className="conv-view__older">
            <Spinner label="Loading messages…" />
          </li>
        )}
        {page.status !== 'loading' && messages.length === 0 && (
          <li className="conv-view__older muted">No messages yet. Say hello!</li>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay =
            !prev || new Date(prev.sentAt).toDateString() !== new Date(m.sentAt).toDateString();
          if (m.kind === 'system') {
            return (
              <MessageRow key={m.id} newDay={newDay} sentAt={m.sentAt}>
                <li className="conv-view__system" id={`msg-${m.id}`}>
                  {m.body}
                </li>
              </MessageRow>
            );
          }
          return (
            <MessageRow key={m.id} newDay={newDay} sentAt={m.sentAt}>
              <MessageBubble
                message={m}
                showSender={
                  c.kind === 'group' &&
                  (!prev || prev.senderDeviceId !== m.senderDeviceId || newDay)
                }
                highlighted={false}
                canInteract={canInteract}
                onReply={() => {
                  setEditing(null);
                  setReplyTo(m);
                }}
                onEdit={() => {
                  setReplyTo(null);
                  setEditing(m);
                }}
                onDelete={(forEveryone) =>
                  void act(() => call('chat:delete', { messageId: m.id, forEveryone }))
                }
                onReact={(emoji, on) =>
                  void act(() => call('chat:react', { messageId: m.id, emoji, on }))
                }
                onJumpTo={(id) => void jumpTo(id)}
                renderAttachment={(msg) => (
                  <AttachmentView message={msg} peerName={msg.fromMe ? c.title : msg.senderName} />
                )}
              />
            </MessageRow>
          );
        })}
      </ol>

      <Composer
        key={conversationId}
        conversationId={conversationId}
        initialDraft={c.draft}
        disabledReason={c.cannotSendReason}
        replyTo={replyTo}
        editing={editing}
        onCancelReply={() => setReplyTo(null)}
        onCancelEdit={() => setEditing(null)}
        onSend={async (body) => {
          stickToBottom.current = true;
          const mentions =
            c.kind === 'group'
              ? findMentions(
                  body,
                  (await call('groups:get', { groupId: c.id.slice(2) })).members.filter(
                    (m) => !m.isMe,
                  ),
                )
              : [];
          const ok = await act(() =>
            call('chat:send', {
              conversationId,
              body,
              replyToId: replyTo?.id ?? null,
              ...(mentions.length ? { mentions } : {}),
            }),
          );
          if (ok) setReplyTo(null);
          return ok;
        }}
        onEdit={async (message, body) => {
          const ok = await act(() => call('chat:edit', { messageId: message.id, body }));
          if (ok) setEditing(null);
          return ok;
        }}
        onDraft={(draft) =>
          void call('chat:set-draft', { conversationId, draft }).catch(() => undefined)
        }
        onTyping={() => void call('chat:typing', { conversationId }).catch(() => undefined)}
        extraActions={<AttachControls conversationId={conversationId} />}
        onPasteFiles={(list) => void sendFiles(list)}
      />
    </section>
  );
}

function MessageRow({
  newDay,
  sentAt,
  children,
}: {
  newDay: boolean;
  sentAt: number;
  children: React.ReactNode;
}) {
  return (
    <>
      {newDay && (
        <li className="conv-view__day" aria-hidden="true">
          <span>{isToday(sentAt) ? 'Today' : dayFormat.format(sentAt)}</span>
        </li>
      )}
      {children}
    </>
  );
}

function isToday(ts: number): boolean {
  return new Date(ts).toDateString() === new Date().toDateString();
}
