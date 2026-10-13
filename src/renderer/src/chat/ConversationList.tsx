import { useState } from 'react';
import type { ConversationSummary, SearchHit } from '../../../shared/chat';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { CreateGroupDialog } from '../groups/CreateGroupDialog';
import { GroupInvites } from '../groups/GroupInvites';
import { Spinner } from '../components/Spinner';
import { call } from '../lib/api';
import { formatRelativeTime } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useLiveQuery } from '../lib/useLiveQuery';
import { Highlight } from './Highlight';

interface ConversationListProps {
  selectedId: string | null;
  onSelect(conversationId: string, messageId?: string): void;
}

export function ConversationList({ selectedId, onSelect }: ConversationListProps) {
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const conversations = useLiveQuery(
    () => call('chat:list-conversations', { archived }),
    ['conversations-changed', 'contacts-changed'],
    [archived],
  );
  const trimmed = useDebounced(query.trim(), 200);
  const search = useLiveQuery<SearchHit[] | null>(
    () =>
      trimmed
        ? call('chat:search', { query: trimmed, conversationId: null })
        : Promise.resolve(null),
    [],
    [trimmed],
  );

  return (
    <aside className="conv-list" aria-label="Conversations">
      <CreateGroupDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          onSelect(id);
        }}
      />
      <GroupInvites onJoined={(id) => onSelect(id)} />
      <div className="conv-list__header">
        <Button size="sm" onClick={() => setCreating(true)}>
          New group
        </Button>
        <input
          className="input"
          type="search"
          placeholder="Search messages"
          aria-label="Search all messages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="segmented" role="radiogroup" aria-label="Show">
          {(['Chats', 'Archived'] as const).map((label) => (
            <label key={label} className="segmented__option">
              <input
                type="radio"
                name="conv-filter"
                checked={archived === (label === 'Archived')}
                onChange={() => setArchived(label === 'Archived')}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>

      {query.trim() ? (
        <SearchResults hits={search.data} onSelect={onSelect} />
      ) : conversations.status === 'loading' ? (
        <div className="conv-list__empty">
          <Spinner label="Loading…" />
        </div>
      ) : (conversations.data ?? []).length === 0 ? (
        <p className="conv-list__empty muted">
          {archived
            ? 'No archived conversations.'
            : 'No conversations yet. Open People and choose Message next to a contact.'}
        </p>
      ) : (
        <ul className="list conv-list__items">
          {(conversations.data ?? []).map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              selected={c.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

function ConversationRow({
  conversation: c,
  selected,
  onSelect,
}: {
  conversation: ConversationSummary;
  selected: boolean;
  onSelect(id: string): void;
}) {
  const preview = c.draft
    ? `Draft: ${c.draft}`
    : c.lastMessage
      ? `${c.lastMessage.fromMe ? 'You: ' : c.kind === 'group' ? `${c.lastMessage.senderName}: ` : ''}${c.lastMessage.excerpt}`
      : 'No messages yet';
  return (
    <li>
      <button
        type="button"
        className="conv-row"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(c.id)}
      >
        <Avatar name={c.title} {...(c.kind === 'direct' ? { online: c.online } : {})} />
        <span className="conv-row__main">
          <span className="conv-row__top">
            <span className="conv-row__title">
              {c.pinned && <span aria-label="Pinned">📌 </span>}
              {c.title}
            </span>
            {c.lastMessage && (
              <span className="conv-row__time">{formatRelativeTime(c.lastMessage.sentAt)}</span>
            )}
          </span>
          <span className="conv-row__bottom">
            <span className={`conv-row__preview ${c.draft ? 'conv-row__preview--draft' : ''}`}>
              {preview}
            </span>
            {c.muted && <span aria-label="Muted">🔕</span>}
            {c.unreadCount > 0 && (
              <span className="sidebar__count" aria-label={`${c.unreadCount} unread`}>
                {c.unreadCount}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

function SearchResults({
  hits,
  onSelect,
}: {
  hits: SearchHit[] | null;
  onSelect(conversationId: string, messageId: string): void;
}) {
  if (!hits) return <Spinner label="Searching…" />;
  if (hits.length === 0) return <p className="conv-list__empty muted">No messages match.</p>;
  return (
    <ul className="list conv-list__items" aria-label="Search results">
      {hits.map((h) => (
        <li key={h.messageId}>
          <button
            type="button"
            className="conv-row"
            onClick={() => onSelect(h.conversationId, h.messageId)}
          >
            <span className="conv-row__main">
              <span className="conv-row__top">
                <span className="conv-row__title">{h.conversationTitle}</span>
                <span className="conv-row__time">{formatRelativeTime(h.sentAt)}</span>
              </span>
              <span className="conv-row__preview">
                {h.senderName}: <Highlight snippet={h.snippet} />
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
