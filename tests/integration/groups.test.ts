import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { groupConversationId } from '../../src/shared/groups';
import { befriend, createNode, FakeLan, until, type TestNode } from './peer-harness';

let nodes: TestNode[] = [];
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop().catch(() => undefined)));
  nodes = [];
});

/** Alice is contacts with Bob and Carol; Bob and Carol are NOT contacts of each other. */
async function trio(): Promise<[TestNode, TestNode, TestNode]> {
  const lan = new FakeLan();
  const alice = await createNode('Alice', lan);
  const bob = await createNode('Bob', lan);
  const carol = await createNode('Carol', lan);
  nodes.push(alice, bob, carol);
  await befriend(alice, bob);
  await befriend(alice, carol);
  return [alice, bob, carol];
}

async function groupOfThree(policy: 'everyone' | 'admins' = 'everyone') {
  const [alice, bob, carol] = await trio();
  const g = alice.groups.create({
    name: 'Lab',
    description: 'Third floor',
    memberIds: [bob.identity.deviceId, carol.identity.deviceId],
    policy,
    discoverable: false,
  });
  await until(() => bob.groups.list().length === 1 && carol.groups.list().length === 1);
  expect(bob.groups.details(g.id)).toMatchObject({
    myStatus: 'invited',
    invitedByName: 'Alice',
    name: 'Lab',
  });
  expect(bob.notify).toHaveBeenCalledWith('Group invitation', 'Alice invited you to “Lab”.');
  bob.groups.acceptInvite(g.id);
  carol.groups.acceptInvite(g.id);
  const allActive = (n: TestNode) =>
    n.groups.details(g.id).members.every((m) => m.status === 'active');
  await until(() => allActive(alice) && allActive(bob) && allActive(carol), 5000);
  return { alice, bob, carol, groupId: g.id, conv: groupConversationId(g.id) };
}

describe('groups', () => {
  it('invites, accepts and converges on the same membership', async () => {
    const { alice, bob, carol, groupId } = await groupOfThree();
    for (const n of [alice, bob, carol]) {
      const d = n.groups.details(groupId);
      expect(d.myStatus).toBe('active');
      expect(d.members.map((m) => `${m.displayName}:${m.role}`).sort()).toEqual([
        'Alice:owner',
        'Bob:member',
        'Carol:member',
      ]);
    }
    expect(bob.groups.details(groupId)).toMatchObject({
      canEdit: false,
      canInvite: false,
      canPost: true,
    });
  });

  it('fans messages out to members who are not each other’s contacts', async () => {
    const { alice, bob, carol, conv } = await groupOfThree();
    expect(bob.contacts.get(carol.identity.deviceId)).toBeNull();
    const sent = bob.chat.send(conv, 'Hello lab', null);
    await until(
      () => alice.chat.getMessage(sent.id) !== null && carol.chat.getMessage(sent.id) !== null,
      8000,
    );
    expect(carol.chat.getMessage(sent.id)).toMatchObject({ senderName: 'Bob', body: 'Hello lab' });
    await until(() => bob.chat.getMessage(sent.id)?.status === 'delivered', 5000);
    // But group membership does not make them contacts: Carol still can't DM Bob.
    expect(() => carol.chat.openDirect(bob.identity.deviceId)).toThrow(/accepted contacts/);
  });

  it('flags mentions', async () => {
    const { alice, bob, conv } = await groupOfThree();
    const sent = alice.chat.send(conv, '@Bob can you check?', null, {
      mentions: [bob.identity.deviceId],
    });
    await until(() => bob.chat.getMessage(sent.id) !== null);
    expect(bob.chat.getMessage(sent.id)?.mentionsMe).toBe(true);
  });

  it('enforces roles and the admins-only posting policy', async () => {
    const { alice, bob, carol, groupId, conv } = await groupOfThree('admins');
    expect(() => bob.chat.send(conv, 'not allowed', null)).toThrow(/Only admins can post/);
    expect(() => bob.groups.update(groupId, { name: 'Mine' })).toThrow(/Only group admins/);
    expect(() => bob.groups.removeMember(groupId, carol.identity.deviceId)).toThrow(/can’t remove/);

    // A message forged by a non-admin over the wire is ignored by everyone.
    bob.peers.send(carol.identity.deviceId, {
      t: 'ev',
      eid: crypto.randomUUID(),
      conv,
      ev: {
        k: 'msg',
        id: '01900000-0000-7000-8000-0000000000aa',
        kind: 'text',
        body: 'sneaky',
        replyTo: null,
        sentAt: Date.now(),
        mentions: [],
        file: null,
      },
    });
    // A snapshot forged by a non-admin is ignored too.
    bob.peers.send(carol.identity.deviceId, {
      t: 'group_ev',
      eid: crypto.randomUUID(),
      ev: {
        k: 'state',
        snapshot: {
          groupId,
          version: 999,
          name: 'Hijacked',
          description: '',
          policy: 'everyone',
          discoverable: false,
          deleted: false,
          members: [
            {
              id: bob.identity.deviceId,
              name: 'Bob',
              role: 'owner',
              status: 'active',
              host: null,
              port: null,
            },
          ],
          createdAt: 0,
        },
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(carol.chat.getMessage('01900000-0000-7000-8000-0000000000aa')).toBeNull();
    expect(carol.groups.details(groupId).name).toBe('Lab');

    // The owner promotes Bob; then he may post and rename.
    alice.groups.setRole(groupId, bob.identity.deviceId, 'admin');
    await until(() => bob.groups.details(groupId).myRole === 'admin');
    bob.groups.update(groupId, { name: 'Lab 3F' });
    await until(
      () =>
        carol.groups.details(groupId).name === 'Lab 3F' &&
        alice.groups.details(groupId).name === 'Lab 3F',
    );
    expect(
      carol.chat
        .listMessages(conv, null, 50)
        .messages.some((m) => m.kind === 'system' && m.body.includes('renamed')),
    ).toBe(true);
  });

  it('removes members, who can then no longer post or receive', async () => {
    const { alice, bob, carol, groupId, conv } = await groupOfThree();
    alice.groups.removeMember(groupId, carol.identity.deviceId);
    await until(() => carol.groups.details(groupId).myStatus === 'removed');
    expect(carol.chat.getConversation(conv).cannotSendReason).toMatch(/removed/);
    await until(() => bob.groups.details(groupId).members.length === 2);
    const sent = bob.chat.send(conv, 'after removal', null);
    await until(() => alice.chat.getMessage(sent.id) !== null);
    await new Promise((r) => setTimeout(r, 150));
    expect(carol.chat.getMessage(sent.id)).toBeNull();
  });

  it('handles leaving, ownership transfer and deletion', async () => {
    const { alice, bob, carol, groupId } = await groupOfThree();
    expect(() => alice.groups.leave(groupId)).toThrow(/Transfer ownership/);

    bob.groups.leave(groupId);
    expect(bob.groups.details(groupId).myStatus).toBe('left');
    await until(() =>
      carol.groups.details(groupId).members.every((m) => m.deviceId !== bob.identity.deviceId),
    );

    alice.groups.transferOwnership(groupId, carol.identity.deviceId);
    await until(() => carol.groups.details(groupId).myRole === 'owner');
    expect(alice.groups.details(groupId).myRole).toBe('admin');

    carol.groups.deleteGroup(groupId);
    await until(() => alice.groups.details(groupId).myStatus === 'deleted');
  });

  it('lets a contact discover a group and request to join', async () => {
    const lan = new FakeLan();
    const alice = await createNode('Alice', lan);
    const dave = await createNode('Dave', lan);
    nodes.push(alice, dave);
    await befriend(alice, dave);
    const g = alice.groups.create({
      name: 'Open',
      description: 'Anyone',
      memberIds: [],
      policy: 'everyone',
      discoverable: true,
    });
    alice.groups.create({
      name: 'Secret',
      description: '',
      memberIds: [],
      policy: 'everyone',
      discoverable: false,
    });

    const found = await dave.groups.discover();
    expect(found.map((f) => f.name)).toEqual(['Open']);
    dave.groups.requestJoin(g.id, alice.identity.deviceId, 'Please add me');
    await until(() => alice.groups.details(g.id).joinRequests.length === 1);
    expect(alice.groups.details(g.id).joinRequests[0]).toMatchObject({
      displayName: 'Dave',
      note: 'Please add me',
    });

    alice.groups.decideJoin(g.id, dave.identity.deviceId, true);
    await until(() => dave.groups.list()[0]?.myStatus === 'active');
    expect(
      dave.groups
        .details(g.id)
        .members.map((m) => m.displayName)
        .sort(),
    ).toEqual(['Alice', 'Dave']);
  });

  it('shares a file with every member, each downloading directly from the sender', async () => {
    const { alice, bob, carol, conv } = await groupOfThree();
    const data = randomBytes(1024 * 1024 + 7);
    const sent = await alice.transfers.sendBytes(
      conv,
      'notes.bin',
      'application/octet-stream',
      'file',
      null,
      data,
    );
    const fileId = sent.attachment?.fileId ?? '';
    await until(
      () => bob.chat.getMessage(sent.id) !== null && carol.chat.getMessage(sent.id) !== null,
    );
    await bob.transfers.accept(fileId);
    await carol.transfers.accept(fileId);
    for (const n of [bob, carol]) {
      await until(() => n.chat.getMessage(sent.id)?.attachment?.state === 'complete', 8000);
      const bytes = readFileSync(n.transfers.pathForUser(fileId).path);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        createHash('sha256').update(data).digest('hex'),
      );
    }
    await until(() => alice.chat.getMessage(sent.id)?.attachment?.state === 'complete');
  });
});
