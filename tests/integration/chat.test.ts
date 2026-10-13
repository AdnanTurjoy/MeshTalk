import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directConversationId } from '../../src/shared/chat';
import { tempDir } from './helpers';
import { befriend, createNode, FakeLan, until, type TestNode } from './peer-harness';

let nodes: TestNode[] = [];
let dir: ReturnType<typeof tempDir>;
beforeEach(() => {
  dir = tempDir();
});
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop().catch(() => undefined)));
  nodes = [];
  dir.cleanup();
});

async function friends(): Promise<[TestNode, TestNode]> {
  const lan = new FakeLan();
  const alice = await createNode('Alice', lan);
  const bob = await createNode('Bob', lan);
  nodes.push(alice, bob);
  await befriend(alice, bob);
  return [alice, bob];
}

function convWith(node: TestNode) {
  return directConversationId(node.identity.deviceId);
}

describe('direct messaging', () => {
  it('delivers a message and updates status, unread count and notification', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const sent = alice.chat.send(conv.id, 'Hello Bob', null);
    expect(sent).toMatchObject({ status: 'pending', fromMe: true, body: 'Hello Bob' });

    await until(() => alice.chat.getMessage(sent.id)?.status === 'delivered');
    const received = bob.chat.getMessage(sent.id);
    expect(received).toMatchObject({
      body: 'Hello Bob',
      fromMe: false,
      senderName: 'Alice',
      status: 'received',
    });
    expect(bob.chat.getConversation(convWith(alice)).unreadCount).toBe(1);
    expect(bob.notify).toHaveBeenCalledWith('Alice', 'New message');
    expect(alice.chat.pendingCount()).toBe(0);
  });

  it('queues while the recipient is offline and delivers after reconnect', async () => {
    const lan = new FakeLan();
    const alice = await createNode('Alice', lan);
    const bobPath = join(dir.path, 'bob.db');
    let bob = await createNode('Bob', lan, { dbPath: bobPath });
    nodes.push(alice, bob);
    await befriend(alice, bob);
    const bobPort = bob.port;
    const bobId = bob.identity.deviceId;
    await bob.stop();
    nodes = nodes.filter((n) => n !== bob);
    await until(() => !alice.peers.isConnected(bobId));

    const conv = alice.chat.openDirect(bobId);
    const ids = ['one', 'two', 'three'].map((t) => alice.chat.send(conv.id, t, null).id);
    expect(alice.chat.getConversation(conv.id).pendingCount).toBe(3);

    bob = await createNode('Bob', lan, { dbPath: bobPath, port: bobPort });
    nodes.push(bob);
    alice.contacts.reconnectAll();
    await until(() => ids.every((id) => alice.chat.getMessage(id)?.status === 'delivered'), 8000);
    const page = bob.chat.listMessages(convWith(alice), null, 50);
    expect(page.messages.map((m) => m.body)).toEqual(['one', 'two', 'three']);
    expect(alice.chat.getConversation(conv.id).pendingCount).toBe(0);
  });

  it('ignores duplicate deliveries of the same event', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const sent = alice.chat.send(conv.id, 'once', null);
    await until(() => alice.chat.getMessage(sent.id)?.status === 'delivered');

    const conn = alice.peers.get(bob.identity.deviceId);
    const replay = {
      t: 'ev' as const,
      eid: crypto.randomUUID(),
      conv: null,
      ev: {
        k: 'msg' as const,
        id: sent.id,
        kind: 'text' as const,
        body: 'tampered',
        replyTo: null,
        sentAt: sent.sentAt,
        mentions: [],
        file: null,
      },
    };
    conn?.send(replay);
    conn?.send(replay);
    await new Promise((r) => setTimeout(r, 100));
    const msgs = bob.chat.listMessages(convWith(alice), null, 50).messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.body).toBe('once');
    expect(bob.chat.getConversation(convWith(alice)).unreadCount).toBe(1);
  });

  it('applies edits and deletes only from the original sender', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const sent = alice.chat.send(conv.id, 'tpyo', null);
    await until(() => bob.chat.getMessage(sent.id) !== null);

    alice.chat.edit(sent.id, 'typo');
    await until(() => bob.chat.getMessage(sent.id)?.body === 'typo');
    expect(bob.chat.getMessage(sent.id)?.editedAt).not.toBeNull();

    expect(() => bob.chat.edit(sent.id, 'hijack')).toThrow(/your own/);
    // A forged edit from Bob over the wire is ignored by Alice.
    bob.peers.send(alice.identity.deviceId, {
      t: 'ev',
      eid: crypto.randomUUID(),
      conv: null,
      ev: { k: 'edit', id: sent.id, body: 'forged', editedAt: Date.now() + 1000 },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(alice.chat.getMessage(sent.id)?.body).toBe('typo');

    alice.chat.delete(sent.id, true);
    await until(() => bob.chat.getMessage(sent.id)?.deletedAt !== null);
    expect(bob.chat.getMessage(sent.id)?.body).toBe('');
  });

  it('syncs reactions and replies', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const sent = alice.chat.send(conv.id, 'Lunch?', null);
    await until(() => bob.chat.getMessage(sent.id) !== null);

    bob.chat.react(sent.id, '👍', true);
    bob.chat.react(sent.id, '🎉', true);
    bob.chat.react(sent.id, '🎉', false);
    const reply = bob.chat.send(convWith(alice), 'Yes!', sent.id);
    await until(() => alice.chat.getMessage(reply.id) !== null);
    await until(() => (alice.chat.getMessage(sent.id)?.reactions.length ?? 0) === 1);
    expect(alice.chat.getMessage(sent.id)?.reactions).toEqual([
      { emoji: '👍', count: 1, mine: false, names: ['Bob'] },
    ]);
    expect(alice.chat.getMessage(reply.id)?.replyTo).toMatchObject({
      id: sent.id,
      excerpt: 'Lunch?',
      senderName: 'Alice',
    });
  });

  it('sends read receipts only when enabled', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const first = alice.chat.send(conv.id, 'read me', null);
    await until(() => alice.chat.getMessage(first.id)?.status === 'delivered');
    bob.chat.markRead(convWith(alice));
    await until(() => alice.chat.getMessage(first.id)?.status === 'read');
    expect(bob.chat.getConversation(convWith(alice)).unreadCount).toBe(0);

    bob.settings.set({ key: 'sendReadReceipts', value: false });
    const second = alice.chat.send(conv.id, 'private', null);
    await until(() => alice.chat.getMessage(second.id)?.status === 'delivered');
    bob.chat.markRead(convWith(alice));
    await new Promise((r) => setTimeout(r, 150));
    expect(alice.chat.getMessage(second.id)?.status).toBe('delivered');
  });

  it('marks messages read immediately when the conversation is open and focused', async () => {
    const [alice, bob] = await friends();
    bob.focused.value = true;
    bob.chat.openDirect(alice.identity.deviceId);
    bob.chat.setActive(convWith(alice));
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const sent = alice.chat.send(conv.id, 'hi', null);
    await until(() => alice.chat.getMessage(sent.id)?.status === 'read');
    expect(bob.notify).not.toHaveBeenCalledWith('Alice', 'New message');
  });

  it('refuses to send to someone who is not a contact', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    alice.contacts.remove(bob.identity.deviceId);
    expect(() => alice.chat.send(conv.id, 'hello?', null)).toThrow(/no longer in your contacts/);
    expect(alice.chat.getConversation(conv.id).cannotSendReason).toMatch(/no longer/);
  });

  it('relays typing indicators only when enabled', async () => {
    const [alice, bob] = await friends();
    alice.chat.openDirect(bob.identity.deviceId);
    alice.chat.typing(convWith(bob));
    await until(() => bob.events.some((e) => e.type === 'typing' && e.on));

    bob.events.length = 0;
    alice.settings.set({ key: 'sendTypingIndicators', value: false });
    alice.chat.typing(convWith(bob));
    await new Promise((r) => setTimeout(r, 100));
    expect(bob.events.some((e) => e.type === 'typing')).toBe(false);
  });
});

describe('history', () => {
  it('pages backwards in stable order', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    for (let i = 0; i < 25; i++) alice.chat.send(conv.id, `m${i}`, null);
    const first = alice.chat.listMessages(conv.id, null, 10);
    expect(first.hasMore).toBe(true);
    expect(first.messages.map((m) => m.body)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${15 + i}`),
    );
    const oldest = first.messages[0];
    const second = alice.chat.listMessages(
      conv.id,
      oldest ? { sentAt: oldest.sentAt, id: oldest.id } : null,
      20,
    );
    expect(second.hasMore).toBe(false);
    expect(second.messages).toHaveLength(15);
    expect(second.messages[14]?.body).toBe('m14');
  });

  it('searches with full-text matching and treats query syntax literally', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    alice.chat.send(conv.id, 'The quarterly report is ready', null);
    alice.chat.send(conv.id, 'Café meeting tomorrow', null);
    const deleted = alice.chat.send(conv.id, 'secret report draft', null);
    alice.chat.delete(deleted.id, true);

    const hits = alice.chat.search('repo', null);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('\u0001report\u0002');
    expect(alice.chat.search('cafe', conv.id)).toHaveLength(1);
    expect(alice.chat.search('" OR NEAR(', null)).toEqual([]);
  });

  it('persists conversations, drafts and messages across restart', async () => {
    const lan = new FakeLan();
    const path = join(dir.path, 'alice.db');
    let alice = await createNode('Alice', lan, { dbPath: path });
    const bob = await createNode('Bob', lan);
    nodes.push(alice, bob);
    await befriend(alice, bob);
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    alice.chat.send(conv.id, 'kept', null);
    alice.chat.setDraft(conv.id, 'half-written');
    alice.chat.setFlags(conv.id, { pinned: true });
    await alice.stop();
    nodes = nodes.filter((n) => n !== alice);

    alice = await createNode('Alice', lan, { dbPath: path });
    nodes.push(alice);
    const reopened = alice.chat.getConversation(conv.id);
    expect(reopened).toMatchObject({ draft: 'half-written', pinned: true, title: 'Bob' });
    expect(alice.chat.listMessages(conv.id, null, 10).messages.map((m) => m.body)).toEqual([
      'kept',
    ]);
  });
});
