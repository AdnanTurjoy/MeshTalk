import { afterEach, describe, expect, it } from 'vitest';
import { directConversationId } from '../../src/shared/chat';
import type { AppEvent } from '../../src/shared/events';
import { befriend, createNode, FakeLan, until, type TestNode } from './peer-harness';

let nodes: TestNode[] = [];
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop().catch(() => undefined)));
  nodes = [];
});

async function friends(opts: Parameters<typeof createNode>[2] = {}): Promise<[TestNode, TestNode]> {
  const lan = new FakeLan();
  const alice = await createNode('Alice', lan, opts);
  const bob = await createNode('Bob', lan, opts);
  nodes.push(alice, bob);
  await befriend(alice, bob);
  return [alice, bob];
}

const find = <T extends AppEvent['type']>(node: TestNode, type: T) =>
  node.events.filter((e): e is Extract<AppEvent, { type: T }> => e.type === type);

describe('call signaling', () => {
  it('invites, relays answer and ICE, records history and ends on both sides', async () => {
    const [alice, bob] = await friends();
    const { callId } = alice.calls.start(directConversationId(bob.identity.deviceId), 'video');
    alice.calls.signal(callId, { type: 'offer', sdp: 'v=0 offer', restart: false });

    await until(() => find(bob, 'call-incoming').length === 1);
    expect(find(bob, 'call-incoming')[0]?.call).toMatchObject({
      callId,
      kind: 'video',
      peerName: 'Alice',
      offerSdp: 'v=0 offer',
    });
    expect(bob.notify).toHaveBeenCalledWith('Alice', 'Incoming video call');

    bob.calls.signal(callId, { type: 'answer', sdp: 'v=0 answer' });
    bob.calls.signal(callId, {
      type: 'ice',
      candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    await until(() => find(alice, 'call-signal').length === 2);
    expect(find(alice, 'call-signal').map((e) => e.signal.type)).toEqual(['answer', 'ice']);

    alice.calls.end(callId, 'hangup');
    await until(() => find(bob, 'call-ended').length === 1);
    expect(find(bob, 'call-ended')[0]?.reason).toBe('hangup');
    const [aliceRecord] = alice.calls.history();
    expect(aliceRecord).toMatchObject({
      direction: 'outgoing',
      kind: 'video',
      endReason: 'hangup',
      peerName: 'Bob',
    });
    expect(aliceRecord?.answeredAt).not.toBeNull();
    expect(bob.calls.history()[0]).toMatchObject({ direction: 'incoming', endReason: 'hangup' });
    expect(bob.calls.missedCount()).toBe(0);
  });

  it('declines without counting as missed', async () => {
    const [alice, bob] = await friends();
    const { callId } = alice.calls.start(directConversationId(bob.identity.deviceId), 'audio');
    alice.calls.signal(callId, { type: 'offer', sdp: 'o', restart: false });
    await until(() => find(bob, 'call-incoming').length === 1);
    bob.calls.end(callId, 'declined');
    await until(() => find(alice, 'call-ended').some((e) => e.reason === 'declined'));
    expect(bob.calls.missedCount()).toBe(0);
  });

  it('times out unanswered calls as missed', async () => {
    const [alice, bob] = await friends({ ringTimeoutMs: 200 });
    const { callId } = alice.calls.start(directConversationId(bob.identity.deviceId), 'audio');
    alice.calls.signal(callId, { type: 'offer', sdp: 'o', restart: false });
    await until(() => find(alice, 'call-ended').some((e) => e.reason === 'no_answer'));
    await until(() => bob.calls.missedCount() === 1);
    expect(bob.notify).toHaveBeenCalledWith('Missed call', 'Alice called you.');
    bob.calls.markSeen();
    expect(bob.calls.missedCount()).toBe(0);
  });

  it('answers busy when already in a call', async () => {
    const lan = new FakeLan();
    const alice = await createNode('Alice', lan);
    const bob = await createNode('Bob', lan);
    const carol = await createNode('Carol', lan);
    nodes.push(alice, bob, carol);
    await befriend(alice, bob);
    await befriend(carol, bob);
    const first = alice.calls.start(directConversationId(bob.identity.deviceId), 'audio');
    alice.calls.signal(first.callId, { type: 'offer', sdp: 'o', restart: false });
    await until(() => find(bob, 'call-incoming').length === 1);

    const second = carol.calls.start(directConversationId(bob.identity.deviceId), 'audio');
    carol.calls.signal(second.callId, { type: 'offer', sdp: 'o', restart: false });
    await until(() => find(carol, 'call-ended').some((e) => e.reason === 'busy'));
    expect(() => bob.calls.start(directConversationId(carol.identity.deviceId), 'audio')).toThrow(
      /already in a call/,
    );
  });

  it('refuses calls to offline contacts and ignores signals for other calls', async () => {
    const [alice, bob] = await friends();
    const { callId } = alice.calls.start(directConversationId(bob.identity.deviceId), 'audio');
    expect(() => alice.calls.signal(crypto.randomUUID(), { type: 'answer', sdp: 'x' })).toThrow(
      /ended/,
    );
    alice.calls.end(callId, 'cancelled');

    alice.peers.disconnect(bob.identity.deviceId, 'test');
    alice.contacts.stop(); // no auto-reconnect for this check
    await until(() => !alice.peers.isConnected(bob.identity.deviceId));
    expect(() => alice.calls.start(directConversationId(bob.identity.deviceId), 'audio')).toThrow(
      /offline/,
    );
  });

  it('ends a ringing call when the link drops', async () => {
    const [alice, bob] = await friends();
    const { callId } = alice.calls.start(directConversationId(bob.identity.deviceId), 'audio');
    alice.calls.signal(callId, { type: 'offer', sdp: 'o', restart: false });
    await until(() => find(bob, 'call-incoming').length === 1);
    bob.peers.get(alice.identity.deviceId)?.socket.destroy();
    await until(() => find(alice, 'call-ended').some((e) => e.reason === 'unavailable'));
  });
});
