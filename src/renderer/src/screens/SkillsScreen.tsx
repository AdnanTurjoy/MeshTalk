import { useState } from 'react';
import {
  SKILL_CATEGORIES,
  SKILL_LEVELS,
  skillInputSchema,
  type PeerProfile,
  type Skill,
  type SkillInput,
} from '../../../shared/skills';
import { Avatar } from '../components/Avatar';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Dialog } from '../components/Dialog';
import { Spinner } from '../components/Spinner';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { call, errorMessage } from '../lib/api';
import { formatRelativeTime } from '../lib/format';
import { useDebounced } from '../lib/useDebounced';
import { useLiveQuery } from '../lib/useLiveQuery';

type Tab = 'profile' | 'directory' | 'requests' | 'bookmarks';
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'profile', label: 'My profile' },
  { id: 'directory', label: 'Directory' },
  { id: 'requests', label: 'Requests' },
  { id: 'bookmarks', label: 'Bookmarks' },
];

export function SkillsScreen({ onMessage }: { onMessage(deviceId: string): void }) {
  const [tab, setTab] = useState<Tab>('profile');
  return (
    <div className="page">
      <header className="page__header">
        <h1>Skills</h1>
        <p className="muted">
          Share what you know and find people to learn from. Everything is private unless you mark
          it visible to contacts. Nothing is published beyond your contacts.
        </p>
      </header>
      <div className="segmented" role="tablist" aria-label="Skills sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'profile' && <MyProfile />}
      {tab === 'directory' && <Directory onMessage={onMessage} />}
      {tab === 'requests' && <Requests onMessage={onMessage} />}
      {tab === 'bookmarks' && <Bookmarks />}
    </div>
  );
}

const EMPTY: SkillInput = {
  id: null,
  kind: 'skill',
  title: '',
  description: '',
  category: 'Software',
  level: 'intermediate',
  links: [],
  visibility: 'private',
};

function MyProfile() {
  const mine = useLiveQuery(() => call('skills:mine'), ['skills-changed']);
  const notify = useToast();
  const [editing, setEditing] = useState<SkillInput | null>(null);
  const [update, setUpdate] = useState({ title: '', body: '', shared: false });

  const remove = (id: string) =>
    void call('skills:delete', { id }).catch((e: unknown) => notify(errorMessage(e), 'error'));
  const items = mine.data?.skills ?? [];

  return (
    <>
      <Card
        title="Skills and interests"
        actions={
          <div className="row">
            <Button onClick={() => setEditing({ ...EMPTY, kind: 'interest', level: null })}>
              Add interest
            </Button>
            <Button variant="primary" onClick={() => setEditing(EMPTY)}>
              Add skill
            </Button>
          </div>
        }
      >
        {mine.status === 'loading' ? (
          <Spinner label="Loading…" />
        ) : items.length === 0 ? (
          <p className="empty">Add what you’re good at, and what you’d like to learn.</p>
        ) : (
          <ul className="list">
            {items.map((s) => (
              <li key={s.id} className="list-item">
                <div className="list-item__main">
                  <span className="list-item__title">
                    {s.title}
                    <Badge>{s.kind === 'interest' ? 'Interest' : (s.level ?? 'Skill')}</Badge>
                    {s.visibility === 'private' ? (
                      <Badge>Private</Badge>
                    ) : (
                      <Badge tone="info">Contacts</Badge>
                    )}
                  </span>
                  <span className="list-item__meta">
                    {s.category}
                    {s.description ? ` · ${s.description}` : ''}
                  </span>
                </div>
                <div className="list-item__actions">
                  <Button size="sm" onClick={() => setEditing(toInput(s))}>
                    Edit
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove(s.id)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Project updates"
        description="Short notes about what you’re working on or learned."
      >
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void call('skills:post-update', {
              title: update.title,
              body: update.body,
              visibility: update.shared ? 'contacts' : 'private',
            }).then(
              () => setUpdate({ title: '', body: '', shared: false }),
              (err: unknown) => notify(errorMessage(err), 'error'),
            );
          }}
        >
          <TextField
            label="Title"
            value={update.title}
            maxLength={120}
            onChange={(e) => setUpdate({ ...update, title: e.target.value })}
          />
          <label className="field">
            <span className="field__label">Details</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={4000}
              value={update.body}
              onChange={(e) => setUpdate({ ...update, body: e.target.value })}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={update.shared}
              onChange={(e) => setUpdate({ ...update, shared: e.target.checked })}
            />
            Visible to my contacts
          </label>
          <div>
            <Button type="submit" variant="primary" disabled={!update.title.trim()}>
              Post update
            </Button>
          </div>
        </form>
        <ul className="list">
          {(mine.data?.updates ?? []).map((u) => (
            <li key={u.id} className="list-item">
              <div className="list-item__main">
                <span className="list-item__title">
                  {u.title}{' '}
                  {u.visibility === 'private' ? (
                    <Badge>Private</Badge>
                  ) : (
                    <Badge tone="info">Contacts</Badge>
                  )}
                </span>
                <span className="list-item__meta">{formatRelativeTime(u.createdAt)}</span>
                {u.body && <p className="pre-wrap">{u.body}</p>}
              </div>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void call('skills:delete-update', { id: u.id })}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <SkillEditor value={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function SkillEditor({ value, onClose }: { value: SkillInput | null; onClose(): void }) {
  const [draft, setDraft] = useState<SkillInput | null>(value);
  const [linksText, setLinksText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastValue, setLastValue] = useState<SkillInput | null>(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
    setLinksText(value?.links.join('\n') ?? '');
    setError(null);
  }

  const save = async () => {
    if (!draft) return;
    const parsed = skillInputSchema.safeParse({
      ...draft,
      links: linksText
        .split(/\s+/)
        .map((l) => l.trim())
        .filter(Boolean),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form');
      return;
    }
    try {
      await call('skills:save', parsed.data);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={draft !== null}
      title={draft?.id ? 'Edit' : draft?.kind === 'interest' ? 'Add interest' : 'Add skill'}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      {draft && (
        <div className="stack">
          <TextField
            label="Title"
            value={draft.title}
            maxLength={80}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <label className="field">
            <span className="field__label">Description</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={1000}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Category</span>
              <select
                className="input"
                value={draft.category}
                onChange={(e) =>
                  setDraft({ ...draft, category: e.target.value as SkillInput['category'] })
                }
              >
                {SKILL_CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            {draft.kind === 'skill' && (
              <label className="field">
                <span className="field__label">Level</span>
                <select
                  className="input"
                  value={draft.level ?? 'intermediate'}
                  onChange={(e) =>
                    setDraft({ ...draft, level: e.target.value as SkillInput['level'] })
                  }
                >
                  {SKILL_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l[0]?.toUpperCase() + l.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <label className="field">
            <span className="field__label">Links (https, one per line, up to 5)</span>
            <textarea
              className="textarea"
              rows={2}
              value={linksText}
              onChange={(e) => setLinksText(e.target.value)}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.visibility === 'contacts'}
              onChange={(e) =>
                setDraft({ ...draft, visibility: e.target.checked ? 'contacts' : 'private' })
              }
            />
            Visible to my contacts
          </label>
          {error && (
            <p className="field__error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function toInput(s: Skill): SkillInput {
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    description: s.description,
    category: s.category,
    level: s.level,
    links: s.links,
    visibility: s.visibility,
  };
}

function Directory({ onMessage }: { onMessage(deviceId: string): void }) {
  const notify = useToast();
  const directory = useLiveQuery(
    () => call('skills:directory'),
    ['skills-changed', 'contacts-changed'],
  );
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 200);
  const results = useLiveQuery(
    () => (debounced ? call('skills:search', { query: debounced }) : Promise.resolve(null)),
    ['skills-changed'],
    [debounced],
  );
  const [asking, setAsking] = useState<{ deviceId: string; name: string; topic: string } | null>(
    null,
  );

  return (
    <>
      <Card
        title="Find people by skill"
        description="Searches what your contacts have shared with you, even while they are offline."
        actions={
          <Button
            onClick={() =>
              void call('skills:refresh').then(
                ({ asked }) =>
                  notify(
                    asked
                      ? `Asked ${asked} online contact(s) for updates.`
                      : 'No contacts are online.',
                    'info',
                  ),
                (e: unknown) => notify(errorMessage(e), 'error'),
              )
            }
          >
            Refresh
          </Button>
        }
      >
        <input
          className="input"
          type="search"
          placeholder="e.g. rust, statistics, soldering"
          aria-label="Search skills"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {results.data && (
          <ul className="list" aria-label="Skill search results">
            {results.data.length === 0 && <li className="empty">No contacts list that skill.</li>}
            {results.data.map((m) => (
              <li key={`${m.deviceId}-${m.skill.id}`} className="list-item">
                <Avatar name={m.displayName} />
                <div className="list-item__main">
                  <span className="list-item__title">
                    {m.displayName} · {m.skill.title}{' '}
                    {m.skill.level && <Badge>{m.skill.level}</Badge>}
                  </span>
                  <span className="list-item__meta">{m.skill.description || m.skill.category}</span>
                </div>
                <Button
                  size="sm"
                  onClick={() =>
                    setAsking({ deviceId: m.deviceId, name: m.displayName, topic: m.skill.title })
                  }
                >
                  Ask for help
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(directory.data?.similar.length ?? 0) > 0 && (
        <Card title="People with similar interests">
          <ul className="list">
            {directory.data?.similar.slice(0, 10).map((p) => (
              <li key={p.deviceId} className="list-item">
                <Avatar name={p.displayName} />
                <div className="list-item__main">
                  <span className="list-item__title">{p.displayName}</span>
                  <span className="list-item__meta">Shared: {p.shared.join(', ')}</span>
                </div>
                <Button size="sm" onClick={() => onMessage(p.deviceId)}>
                  Message
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Contacts’ profiles">
        {directory.status === 'loading' ? (
          <Spinner label="Loading…" />
        ) : (directory.data?.profiles ?? []).length === 0 ? (
          <p className="empty">None of your contacts have shared skills with you yet.</p>
        ) : (
          directory.data?.profiles.map((p) => (
            <ProfileCard
              key={p.deviceId}
              profile={p}
              onAsk={(topic) => setAsking({ deviceId: p.deviceId, name: p.displayName, topic })}
            />
          ))
        )}
      </Card>

      <RequestDialog target={asking} onClose={() => setAsking(null)} />
    </>
  );
}

function ProfileCard({ profile: p, onAsk }: { profile: PeerProfile; onAsk(topic: string): void }) {
  const notify = useToast();
  return (
    <section className="profile-card" aria-label={`${p.displayName}’s skills`}>
      <div className="row">
        <Avatar name={p.displayName} online={p.online} />
        <strong>{p.displayName}</strong>
        <span className="muted">updated {formatRelativeTime(p.fetchedAt)}</span>
      </div>
      <ul className="list">
        {p.skills.map((s) => (
          <li key={s.id} className="list-item">
            <div className="list-item__main">
              <span className="list-item__title">
                {s.title} <Badge>{s.kind === 'interest' ? 'Interest' : (s.level ?? 'Skill')}</Badge>
              </span>
              {s.description && <span className="list-item__meta">{s.description}</span>}
              {s.links.map((l) => (
                <span key={l} className="row">
                  <a href={l} target="_blank" rel="noreferrer noopener" className="link">
                    {l}
                  </a>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void call('bookmarks:add', {
                        title: `${s.title} (${p.displayName})`,
                        url: l,
                        note: '',
                        sourceDeviceId: p.deviceId,
                      }).then(
                        () => notify('Bookmarked.', 'success'),
                        (e: unknown) => notify(errorMessage(e), 'error'),
                      )
                    }
                  >
                    Bookmark
                  </Button>
                </span>
              ))}
            </div>
            {s.kind === 'skill' && (
              <Button size="sm" onClick={() => onAsk(s.title)}>
                Ask for help
              </Button>
            )}
          </li>
        ))}
      </ul>
      {p.updates.length > 0 && (
        <div className="stack">
          <strong>Recent updates</strong>
          {p.updates.map((u) => (
            <div key={u.id}>
              <strong>{u.title}</strong>{' '}
              <span className="muted">{formatRelativeTime(u.createdAt)}</span>
              {u.body && <p className="pre-wrap">{u.body}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RequestDialog({
  target,
  onClose,
}: {
  target: { deviceId: string; name: string; topic: string } | null;
  onClose(): void;
}) {
  const notify = useToast();
  const [kind, setKind] = useState<'mentorship' | 'collaboration'>('mentorship');
  const [note, setNote] = useState('');
  return (
    <Dialog
      open={target !== null}
      title={target ? `Ask ${target.name}` : ''}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() =>
              target &&
              void call('skills:request', {
                deviceId: target.deviceId,
                kind,
                topic: target.topic,
                note,
              }).then(
                () => {
                  notify('Request sent.', 'success');
                  setNote('');
                  onClose();
                },
                (e: unknown) => notify(errorMessage(e), 'error'),
              )
            }
          >
            Send request
          </Button>
        </>
      }
    >
      {target && (
        <div className="stack">
          <p>
            Topic: <strong>{target.topic}</strong>
          </p>
          <div className="segmented" role="radiogroup" aria-label="Kind of request">
            {(['mentorship', 'collaboration'] as const).map((k) => (
              <label key={k} className="segmented__option">
                <input
                  type="radio"
                  name="req-kind"
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                <span>{k === 'mentorship' ? 'Mentorship' : 'Collaboration'}</span>
              </label>
            ))}
          </div>
          <label className="field">
            <span className="field__label">Message (optional)</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
      )}
    </Dialog>
  );
}

function Requests({ onMessage }: { onMessage(deviceId: string): void }) {
  const requests = useLiveQuery(() => call('skills:requests'), ['skills-changed']);
  const notify = useToast();
  const list = requests.data ?? [];
  return (
    <Card title="Mentorship and collaboration">
      {list.length === 0 ? (
        <p className="empty">No requests yet. Find someone in the Directory and ask for help.</p>
      ) : (
        <ul className="list">
          {list.map((r) => (
            <li key={r.id} className="list-item">
              <Avatar name={r.peerName} />
              <div className="list-item__main">
                <span className="list-item__title">
                  {r.direction === 'incoming'
                    ? `${r.peerName} asks you`
                    : `You asked ${r.peerName}`}{' '}
                  · {r.kind === 'mentorship' ? 'Mentorship' : 'Collaboration'}: {r.topic}
                  <Badge
                    tone={
                      r.state === 'accepted'
                        ? 'success'
                        : r.state === 'declined'
                          ? 'neutral'
                          : 'warning'
                    }
                  >
                    {r.state}
                  </Badge>
                </span>
                <span className="list-item__meta">
                  {formatRelativeTime(r.createdAt)}
                  {r.note ? ` · “${r.note}”` : ''}
                </span>
              </div>
              <div className="list-item__actions">
                {r.direction === 'incoming' && r.state === 'pending' && (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        void call('skills:respond', { id: r.id, accept: true }).catch(
                          (e: unknown) => notify(errorMessage(e), 'error'),
                        )
                      }
                    >
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        void call('skills:respond', { id: r.id, accept: false }).catch(
                          (e: unknown) => notify(errorMessage(e), 'error'),
                        )
                      }
                    >
                      Decline
                    </Button>
                  </>
                )}
                {r.state === 'accepted' && (
                  <Button size="sm" onClick={() => onMessage(r.peerDeviceId)}>
                    Message
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Bookmarks() {
  const list = useLiveQuery(() => call('bookmarks:list'), ['skills-changed']);
  const notify = useToast();
  const [draft, setDraft] = useState({ title: '', url: '' });
  return (
    <Card title="Bookmarks" description="Saved on this computer only.">
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void call('bookmarks:add', { ...draft, note: '', sourceDeviceId: null }).then(
            () => setDraft({ title: '', url: '' }),
            (err: unknown) => notify(errorMessage(err), 'error'),
          );
        }}
      >
        <TextField
          label="Title"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
        <TextField
          label="Link (https)"
          value={draft.url}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })}
        />
        <div>
          <Button type="submit" disabled={!draft.title.trim() || !draft.url.trim()}>
            Add bookmark
          </Button>
        </div>
      </form>
      <ul className="list">
        {(list.data ?? []).map((b) => (
          <li key={b.id} className="list-item">
            <div className="list-item__main">
              <a
                href={b.url}
                target="_blank"
                rel="noreferrer noopener"
                className="list-item__title link"
              >
                {b.title}
              </a>
              <span className="list-item__meta">
                {b.url}
                {b.sourceName ? ` · from ${b.sourceName}` : ''}
              </span>
            </div>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void call('bookmarks:remove', { id: b.id })}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
