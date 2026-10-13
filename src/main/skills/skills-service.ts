import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { and, desc, eq } from 'drizzle-orm';
import type { AppEvent } from '../../shared/events';
import type {
  Bookmark,
  PeerProfile,
  ProjectUpdate,
  SharedProfile,
  SimilarPerson,
  Skill,
  SkillInput,
  SkillMatch,
  SkillRequest,
} from '../../shared/skills';
import type { ChatService } from '../chat/chat-service';
import type { AppDatabase } from '../db/connection';
import { bookmarks, peerProfiles, projectUpdates, skillRequests, skills } from '../db/schema';
import { UserFacingError } from '../errors';
import type { Logger } from '../logger';
import type { PeerConnection } from '../peer/peer-connection';
import type { PeerService } from '../peer/peer-service';
import type { WireMessage } from '../peer/wire';
import type { ContactsService } from '../services/contacts-service';
import type { SettingsService } from '../services/settings-service';
import { sharedProfileSchema, type SkillEvent } from './skills-wire';

const MAX_SKILLS = 100;
const SHARED_UPDATES = 20;
const REFRESH_AFTER_MS = 10 * 60 * 1000;

type SkillRow = typeof skills.$inferSelect;

export class SkillsError extends UserFacingError {
  override name = 'SkillsError';
}

export interface SkillsServiceDeps {
  db: AppDatabase;
  sqlite: Database.Database;
  contacts: ContactsService;
  peers: PeerService;
  chat: ChatService;
  settings: SettingsService;
  logger: Logger;
  emit(event: AppEvent): void;
  notify(title: string, body: string): void;
  now?: () => number;
}

/**
 * Skill sharing between contacts. Everything is private by default; items
 * marked "contacts" are sent only to accepted contacts who ask, over their
 * authenticated PeerLink. Profiles received from contacts are cached so
 * search works offline; nothing is published to the network at large.
 */
export class SkillsService {
  private readonly now: () => number;

  constructor(private readonly deps: SkillsServiceDeps) {
    this.now = deps.now ?? Date.now;
    deps.peers.on('message', (from, msg, conn) => this.onMessage(from, msg, conn));
    deps.contacts.onAccepted((id) => deps.peers.send(id, { t: 'skills_req' }));
    deps.peers.on('connected', (conn) => {
      const id = conn.remoteDeviceId;
      if (!deps.contacts.isTrusted(id)) return;
      const cached = deps.db.select().from(peerProfiles).where(eq(peerProfiles.deviceId, id)).get();
      if (!cached || this.now() - cached.fetchedAt > REFRESH_AFTER_MS)
        conn.send({ t: 'skills_req' });
    });
  }

  // ------------------------------------------------------------- my profile

  mySkills(): Skill[] {
    return this.deps.db.select().from(skills).orderBy(skills.kind, skills.title).all().map(toSkill);
  }

  saveSkill(input: SkillInput): Skill {
    const now = this.now();
    const values = {
      kind: input.kind,
      title: input.title,
      description: input.description,
      category: input.category,
      level: input.kind === 'skill' ? input.level : null,
      linksJson: JSON.stringify(input.links),
      visibility: input.visibility,
      updatedAt: now,
    };
    let id = input.id;
    if (id) {
      const updated = this.deps.db.update(skills).set(values).where(eq(skills.id, id)).run();
      if (updated.changes === 0) throw new SkillsError('That item no longer exists.');
    } else {
      const count = this.deps.sqlite.prepare('SELECT count(*) FROM skills').pluck().get() as number;
      if (count >= MAX_SKILLS)
        throw new SkillsError(`You can list up to ${MAX_SKILLS} skills and interests.`);
      id = randomUUID();
      this.deps.db
        .insert(skills)
        .values({ id, createdAt: now, ...values })
        .run();
    }
    this.profileChanged();
    const saved = this.deps.db.select().from(skills).where(eq(skills.id, id)).get();
    if (!saved) throw new Error('Skill was not saved');
    return toSkill(saved);
  }

  deleteSkill(id: string): void {
    this.deps.db.delete(skills).where(eq(skills.id, id)).run();
    this.profileChanged();
  }

  myUpdates(): ProjectUpdate[] {
    return this.deps.db
      .select()
      .from(projectUpdates)
      .orderBy(desc(projectUpdates.createdAt))
      .all()
      .map((u) => ({
        id: u.id,
        title: u.title,
        body: u.body,
        visibility: u.visibility,
        createdAt: u.createdAt,
      }));
  }

  postUpdate(input: {
    title: string;
    body: string;
    visibility: 'private' | 'contacts';
  }): ProjectUpdate {
    const id = randomUUID();
    const createdAt = this.now();
    this.deps.db
      .insert(projectUpdates)
      .values({ id, ...input, createdAt })
      .run();
    this.profileChanged();
    return { id, ...input, createdAt };
  }

  deleteUpdate(id: string): void {
    this.deps.db.delete(projectUpdates).where(eq(projectUpdates.id, id)).run();
    this.profileChanged();
  }

  /** Exactly what a contact receives when they ask. */
  sharedProfile(): SharedProfile {
    const shared = this.deps.db
      .select()
      .from(skills)
      .where(eq(skills.visibility, 'contacts'))
      .all();
    const updates = this.deps.db
      .select()
      .from(projectUpdates)
      .where(eq(projectUpdates.visibility, 'contacts'))
      .orderBy(desc(projectUpdates.createdAt))
      .limit(SHARED_UPDATES)
      .all();
    const latest = Math.max(
      0,
      ...shared.map((s) => s.updatedAt),
      ...updates.map((u) => u.createdAt),
    );
    return {
      skills: shared.map((s) => {
        const { visibility: _v, ...rest } = toSkill(s);
        return rest;
      }),
      updates: updates.map((u) => ({
        id: u.id,
        title: u.title,
        body: u.body,
        createdAt: u.createdAt,
      })),
      updatedAt: latest,
    };
  }

  // -------------------------------------------------------------- directory

  /** Asks every connected contact for their current profile. */
  refresh(): number {
    let asked = 0;
    for (const id of this.deps.peers.connectedDeviceIds()) {
      if (this.deps.contacts.isTrusted(id) && this.deps.peers.send(id, { t: 'skills_req' }))
        asked++;
    }
    return asked;
  }

  profiles(): PeerProfile[] {
    return this.deps.db
      .select()
      .from(peerProfiles)
      .all()
      .flatMap((row) => {
        const contact = this.deps.contacts.get(row.deviceId);
        if (contact?.state !== 'accepted') return [];
        const parsed = sharedProfileSchema.safeParse(JSON.parse(row.profileJson));
        if (!parsed.success) return [];
        return [
          {
            ...parsed.data,
            deviceId: row.deviceId,
            displayName: contact.displayName,
            online: contact.online,
            fetchedAt: row.fetchedAt,
          },
        ];
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  profile(deviceId: string): PeerProfile | null {
    return this.profiles().find((p) => p.deviceId === deviceId) ?? null;
  }

  /** Every term must appear in the title, description or category. */
  search(query: string): SkillMatch[] {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const out: SkillMatch[] = [];
    for (const p of this.profiles()) {
      for (const s of p.skills) {
        const hay = `${s.title} ${s.description} ${s.category}`.toLocaleLowerCase();
        if (terms.every((t) => hay.includes(t)))
          out.push({ deviceId: p.deviceId, displayName: p.displayName, skill: s });
      }
    }
    return out.sort((a, b) => levelRank(b.skill.level) - levelRank(a.skill.level));
  }

  /** Contacts who share topics with me, most overlap first. */
  similar(): SimilarPerson[] {
    const mine = new Set(this.mySkills().flatMap((s) => [norm(s.title), `#${s.category}`]));
    if (mine.size === 0) return [];
    return this.profiles()
      .map((p) => {
        const theirs = new Set(p.skills.flatMap((s) => [norm(s.title), `#${s.category}`]));
        const shared = [...theirs].filter((t) => mine.has(t));
        const titles = shared.filter((t) => !t.startsWith('#'));
        // A shared topic counts more than a shared category.
        const score = titles.length * 3 + (shared.length - titles.length);
        const labels = titles.length ? titles : shared.map((t) => t.slice(1));
        return { deviceId: p.deviceId, displayName: p.displayName, shared: labels, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  // --------------------------------------------------------------- requests

  sendRequest(
    deviceId: string,
    kind: 'mentorship' | 'collaboration',
    topic: string,
    note: string,
  ): SkillRequest {
    if (!this.deps.contacts.isTrusted(deviceId))
      throw new SkillsError('You can only ask your contacts.');
    const id = randomUUID();
    const now = this.now();
    this.deps.db
      .insert(skillRequests)
      .values({
        id,
        direction: 'outgoing',
        peerDeviceId: deviceId,
        kind,
        topic,
        note,
        state: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.send(deviceId, { k: 'request', id, kind, topic, note });
    this.changed();
    return this.requests().find((r) => r.id === id) as SkillRequest;
  }

  respond(id: string, accept: boolean): void {
    const row = this.deps.db.select().from(skillRequests).where(eq(skillRequests.id, id)).get();
    if (!row || row.direction !== 'incoming' || row.state !== 'pending') {
      throw new SkillsError('That request is no longer pending.');
    }
    this.deps.db
      .update(skillRequests)
      .set({ state: accept ? 'accepted' : 'declined', updatedAt: this.now() })
      .where(eq(skillRequests.id, id))
      .run();
    this.send(row.peerDeviceId, { k: 'response', id, accepted: accept });
    this.changed();
  }

  requests(): SkillRequest[] {
    return this.deps.db
      .select()
      .from(skillRequests)
      .orderBy(desc(skillRequests.createdAt))
      .all()
      .map((r) => ({
        id: r.id,
        direction: r.direction,
        peerDeviceId: r.peerDeviceId,
        peerName:
          this.deps.contacts.get(r.peerDeviceId)?.displayName ??
          `Device ${r.peerDeviceId.slice(0, 7)}`,
        kind: r.kind,
        topic: r.topic,
        note: r.note,
        state: r.state,
        createdAt: r.createdAt,
      }));
  }

  // -------------------------------------------------------------- bookmarks

  bookmarks(): Bookmark[] {
    return this.deps.db
      .select()
      .from(bookmarks)
      .orderBy(desc(bookmarks.createdAt))
      .all()
      .map((b) => ({
        id: b.id,
        title: b.title,
        url: b.url,
        note: b.note,
        sourceName: b.sourceDeviceId
          ? (this.deps.contacts.get(b.sourceDeviceId)?.displayName ?? null)
          : null,
        createdAt: b.createdAt,
      }));
  }

  addBookmark(input: {
    title: string;
    url: string;
    note: string;
    sourceDeviceId: string | null;
  }): Bookmark {
    const id = randomUUID();
    this.deps.db
      .insert(bookmarks)
      .values({ id, ...input, createdAt: this.now() })
      .run();
    this.changed();
    return this.bookmarks().find((b) => b.id === id) as Bookmark;
  }

  removeBookmark(id: string): void {
    this.deps.db.delete(bookmarks).where(eq(bookmarks.id, id)).run();
    this.changed();
  }

  // -------------------------------------------------------------- receiving

  private onMessage(from: string, msg: WireMessage, conn: PeerConnection): void {
    // Skill traffic is for contacts only (not merely fellow group members).
    if (!this.deps.contacts.isTrusted(from)) return;
    switch (msg.t) {
      case 'skills_req':
        conn.send({ t: 'skills_profile', profile: this.sharedProfile() });
        return;
      case 'skills_profile':
        this.deps.db
          .insert(peerProfiles)
          .values({
            deviceId: from,
            profileJson: JSON.stringify(msg.profile),
            fetchedAt: this.now(),
          })
          .onConflictDoUpdate({
            target: peerProfiles.deviceId,
            set: { profileJson: JSON.stringify(msg.profile), fetchedAt: this.now() },
          })
          .run();
        this.changed();
        return;
      case 'skills_changed':
        conn.send({ t: 'skills_req' });
        return;
      case 'skill_ev':
        try {
          this.apply(from, msg.ev);
        } catch (error) {
          this.deps.logger.error('skills.apply_failed', { error });
          return;
        }
        conn.send({ t: 'ev_ack', eids: [msg.eid] });
        return;
      default:
        return;
    }
  }

  private apply(from: string, ev: SkillEvent): void {
    if (ev.k === 'request') {
      const now = this.now();
      this.deps.db
        .insert(skillRequests)
        .values({
          id: ev.id,
          direction: 'incoming',
          peerDeviceId: from,
          kind: ev.kind,
          topic: ev.topic,
          note: ev.note,
          state: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
      this.changed();
      if (this.deps.settings.get('notificationsEnabled')) {
        const name = this.deps.contacts.get(from)?.displayName ?? 'A contact';
        this.deps.notify(
          `${ev.kind === 'mentorship' ? 'Mentorship' : 'Collaboration'} request`,
          `${name}: ${ev.topic}`,
        );
      }
      return;
    }
    const updated = this.deps.db
      .update(skillRequests)
      .set({ state: ev.accepted ? 'accepted' : 'declined', updatedAt: this.now() })
      .where(
        and(
          eq(skillRequests.id, ev.id),
          eq(skillRequests.peerDeviceId, from),
          eq(skillRequests.direction, 'outgoing'),
          eq(skillRequests.state, 'pending'),
        ),
      )
      .run();
    if (updated.changes > 0) this.changed();
  }

  private send(target: string, ev: SkillEvent): void {
    this.deps.chat.enqueueWire(target, null, (eid) => ({ t: 'skill_ev', eid, ev }));
  }

  /** Lets connected contacts know to refetch; they decide whether to. */
  private profileChanged(): void {
    const updatedAt = this.sharedProfile().updatedAt;
    for (const id of this.deps.peers.connectedDeviceIds()) {
      if (this.deps.contacts.isTrusted(id))
        this.deps.peers.send(id, { t: 'skills_changed', updatedAt });
    }
    this.changed();
  }

  private changed(): void {
    this.deps.emit({ type: 'skills-changed' });
  }
}

function toSkill(row: SkillRow): Skill {
  let links: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.linksJson);
    if (Array.isArray(parsed)) links = parsed.filter((l): l is string => typeof l === 'string');
  } catch {
    links = [];
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    category: row.category as Skill['category'],
    level: (row.level as Skill['level']) ?? null,
    links,
    visibility: row.visibility,
    updatedAt: row.updatedAt,
  };
}

function norm(title: string): string {
  return title.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function levelRank(level: Skill['level']): number {
  return level ? ['beginner', 'intermediate', 'advanced', 'expert'].indexOf(level) + 1 : 0;
}
