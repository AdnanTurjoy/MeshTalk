import { afterEach, describe, expect, it } from 'vitest';
import type { SkillInput } from '../../src/shared/skills';
import { befriend, createNode, FakeLan, until, type TestNode } from './peer-harness';

let nodes: TestNode[] = [];
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop().catch(() => undefined)));
  nodes = [];
});

const skill = (title: string, overrides: Partial<SkillInput> = {}): SkillInput => ({
  id: null,
  kind: 'skill',
  title,
  description: '',
  category: 'Software',
  level: 'advanced',
  links: [],
  visibility: 'contacts',
  ...overrides,
});

describe('skill sharing', () => {
  it('shares only contact-visible items, and only with contacts', async () => {
    const lan = new FakeLan();
    const alice = await createNode('Alice', lan);
    const bob = await createNode('Bob', lan);
    const eve = await createNode('Eve', lan);
    nodes.push(alice, bob, eve);
    alice.skills.saveSkill(
      skill('Rust', { description: 'Systems programming', links: ['https://www.rust-lang.org'] }),
    );
    alice.skills.saveSkill(
      skill('Salary negotiation', { visibility: 'private', category: 'Management' }),
    );
    alice.skills.postUpdate({ title: 'Shipped v2', body: 'Faster sync', visibility: 'contacts' });
    alice.skills.postUpdate({ title: 'Secret plan', body: '', visibility: 'private' });

    await befriend(alice, bob);
    await until(() => bob.skills.profiles().length === 1);
    const profile = bob.skills.profile(alice.identity.deviceId);
    expect(profile?.skills.map((s) => s.title)).toEqual(['Rust']);
    expect(profile?.updates.map((u) => u.title)).toEqual(['Shipped v2']);
    expect(JSON.stringify(profile)).not.toContain('Salary');

    // Eve is connected but not a contact: she gets nothing.
    const conn = await eve.peers.connect('127.0.0.1', alice.port, null);
    conn.send({ t: 'skills_req' });
    await new Promise((r) => setTimeout(r, 150));
    expect(eve.skills.profiles()).toEqual([]);
  });

  it('searches cached profiles offline and ranks similar people', async () => {
    const lan = new FakeLan();
    const alice = await createNode('Alice', lan);
    const bob = await createNode('Bob', lan);
    nodes.push(alice, bob);
    bob.skills.saveSkill(skill('TypeScript', { level: 'expert' }));
    bob.skills.saveSkill(skill('Kubernetes', { category: 'Software', level: 'beginner' }));
    alice.skills.saveSkill(skill('TypeScript', { kind: 'interest', level: null }));
    await befriend(alice, bob);
    await until(() => alice.skills.profiles().length === 1);

    bob.peers.disconnect(alice.identity.deviceId, 'test');
    bob.contacts.stop();
    await until(() => !alice.peers.isConnected(bob.identity.deviceId));
    expect(alice.skills.search('typescript').map((m) => m.displayName)).toEqual(['Bob']);
    expect(alice.skills.search('kube software').map((m) => m.skill.title)).toEqual(['Kubernetes']);
    expect(alice.skills.search('cobol')).toEqual([]);
    expect(alice.skills.similar()[0]).toMatchObject({ displayName: 'Bob', shared: ['typescript'] });
  });

  it('refreshes when a contact changes their profile', async () => {
    const lan = new FakeLan();
    const alice = await createNode('Alice', lan);
    const bob = await createNode('Bob', lan);
    nodes.push(alice, bob);
    await befriend(alice, bob);
    await until(() => alice.skills.profiles().length === 1);
    bob.skills.saveSkill(skill('Soldering', { category: 'Hardware' }));
    await until(() => alice.skills.profile(bob.identity.deviceId)?.skills.length === 1);
  });

  it('delivers mentorship requests and responses reliably', async () => {
    const lan = new FakeLan();
    const alice = await createNode('Alice', lan);
    const bob = await createNode('Bob', lan);
    nodes.push(alice, bob);
    await befriend(alice, bob);
    const req = alice.skills.sendRequest(
      bob.identity.deviceId,
      'mentorship',
      'Rust',
      'Could you review my crate?',
    );
    await until(() => bob.skills.requests().length === 1);
    expect(bob.skills.requests()[0]).toMatchObject({
      direction: 'incoming',
      peerName: 'Alice',
      topic: 'Rust',
      state: 'pending',
    });
    expect(bob.notify).toHaveBeenCalledWith('Mentorship request', 'Alice: Rust');
    bob.skills.respond(req.id, true);
    await until(() => alice.skills.requests()[0]?.state === 'accepted');
    expect(() => bob.skills.respond(req.id, false)).toThrow(/no longer pending/);
  });

  it('keeps bookmarks locally', async () => {
    const lan = new FakeLan();
    const alice = await createNode('Alice', lan);
    nodes.push(alice);
    const b = alice.skills.addBookmark({
      title: 'Rust book',
      url: 'https://doc.rust-lang.org/book/',
      note: '',
      sourceDeviceId: null,
    });
    expect(alice.skills.bookmarks()).toHaveLength(1);
    alice.skills.removeBookmark(b.id);
    expect(alice.skills.bookmarks()).toEqual([]);
  });
});
