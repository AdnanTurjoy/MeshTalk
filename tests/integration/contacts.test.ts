import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDeviceCredentials } from '../../src/main/identity/certificate';
import { encodeJsonFrame } from '../../src/main/peer/frames';
import { createNode, FakeLan, until, type TestNode } from './peer-harness';

let nodes: TestNode[] = [];
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop()));
  nodes = [];
});

async function pair(): Promise<[TestNode, TestNode, FakeLan]> {
  const lan = new FakeLan();
  const alice = await createNode('Alice', lan);
  const bob = await createNode('Bob', lan);
  nodes.push(alice, bob);
  return [alice, bob, lan];
}

describe('contact requests over mutual TLS', () => {
  it('discovers, requests, accepts, and exchanges profiles', async () => {
    const [alice, bob] = await pair();
    alice.discovery.start(alice.port);
    bob.discovery.start(bob.port);
    await until(() => alice.contacts.nearby().length === 1);
    const nearby = alice.contacts.nearby()[0];
    expect(nearby?.deviceId).toBe(bob.identity.deviceId);
    expect(nearby?.displayName).toBeNull(); // discovery reveals no profile

    await alice.contacts.requestNearby(bob.identity.deviceId, 'Hi from the lab');
    await until(() => bob.contacts.get(alice.identity.deviceId)?.state === 'incoming');
    const incoming = bob.contacts.get(alice.identity.deviceId);
    expect(incoming).toMatchObject({
      displayName: 'Alice',
      requestNote: 'Hi from the lab',
      online: false,
    });
    expect(bob.notify).toHaveBeenCalledOnce();

    await bob.contacts.accept(alice.identity.deviceId);
    await until(() => alice.contacts.get(bob.identity.deviceId)?.state === 'accepted');
    expect(alice.contacts.get(bob.identity.deviceId)).toMatchObject({
      displayName: 'Bob',
      emailLabel: 'bob@example.test',
      online: true,
      verified: false,
    });
    expect(bob.contacts.get(alice.identity.deviceId)?.online).toBe(true);
  });

  it('connects by address with trust on first use and reports the fingerprint', async () => {
    const [alice, bob] = await pair();
    const contact = await alice.contacts.request('127.0.0.1', bob.port, null, null);
    expect(contact.deviceId).toBe(bob.identity.deviceId);
    expect(contact.fingerprint).toBe(bob.identity.info().fingerprint);
    expect(contact.state).toBe('outgoing');
  });

  it('rejects a spoofed announcement whose certificate does not match', async () => {
    const [alice, bob, lan] = await pair();
    const victim = await generateDeviceCredentials();
    alice.discovery.start(alice.port);
    // Bob's listener claims to be `victim` in mDNS.
    lan.announce({
      name: 'x',
      host: 'h',
      addresses: ['127.0.0.1'],
      port: bob.port,
      txt: { v: '1', id: victim.deviceId },
    });
    await until(() => alice.contacts.nearby().some((n) => n.deviceId === victim.deviceId));
    await expect(alice.contacts.requestNearby(victim.deviceId, null)).rejects.toThrow(
      /not the one expected/,
    );
    expect(bob.contacts.list()).toEqual([]);
  });

  it('ignores malformed and self announcements', async () => {
    const [alice, , lan] = await pair();
    alice.discovery.start(alice.port);
    lan.announce({
      name: 'a',
      host: 'h',
      addresses: ['127.0.0.1'],
      port: 1,
      txt: { v: '1', id: 'not-an-id' },
    });
    lan.announce({
      name: 'b',
      host: 'h',
      addresses: ['127.0.0.1'],
      port: 1,
      txt: { v: '1', id: alice.identity.deviceId },
    });
    lan.announce({
      name: 'c',
      host: 'h',
      addresses: ['127.0.0.1'],
      port: 0,
      txt: { v: '1', id: 'A'.repeat(52) },
    });
    expect(alice.contacts.nearby()).toEqual([]);
  });

  it('declines, and ignores repeat requests during the cooldown', async () => {
    const [alice, bob] = await pair();
    await alice.contacts.request('127.0.0.1', bob.port, null, null);
    await until(() => bob.contacts.get(alice.identity.deviceId)?.state === 'incoming');
    bob.contacts.decline(alice.identity.deviceId);
    await until(() => alice.contacts.get(bob.identity.deviceId)?.state === 'declined');

    alice.contacts.remove(bob.identity.deviceId);
    await alice.contacts.request('127.0.0.1', bob.port, null, null);
    await new Promise((r) => setTimeout(r, 150));
    expect(bob.contacts.get(alice.identity.deviceId)?.state).toBe('declined');
  });

  it('drops connections from blocked devices', async () => {
    const [alice, bob] = await pair();
    await alice.contacts.request('127.0.0.1', bob.port, null, null);
    await until(() => bob.contacts.get(alice.identity.deviceId)?.state === 'incoming');
    bob.contacts.block(alice.identity.deviceId);
    await until(() => !alice.peers.isConnected(bob.identity.deviceId));
    await expect(
      alice.contacts.request('127.0.0.1', bob.port, bob.identity.deviceId, null),
    ).rejects.toThrow();
  });

  it('closes untrusted peers that send messages reserved for contacts', async () => {
    const [alice, bob] = await pair();
    const conn = await alice.peers.connect('127.0.0.1', bob.port, null);
    conn.send({ t: 'profile', displayName: 'Mallory', emailLabel: null });
    await until(() => !conn.isOpen);
    expect(bob.contacts.list()).toEqual([]);
  });

  it('closes a connection that sends a malformed frame', async () => {
    const [alice, bob] = await pair();
    const conn = await alice.peers.connect('127.0.0.1', bob.port, null);
    conn.socket.write(encodeJsonFrame({ t: 'contact_request', displayName: '', emailLabel: 5 }));
    await until(() => !conn.isOpen);
  });

  it('refuses clients that present no certificate', async () => {
    const [, bob] = await pair();
    const socket = tls.connect({ host: '127.0.0.1', port: bob.port, rejectUnauthorized: false });
    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.on('error', () => resolve());
    });
    expect(bob.peers.connectedDeviceIds()).toEqual([]);
  });

  it('keeps exactly one link when both sides connect at once', async () => {
    const [alice, bob] = await pair();
    await alice.contacts.request('127.0.0.1', bob.port, null, null);
    await until(() => bob.contacts.get(alice.identity.deviceId)?.state === 'incoming');
    await bob.contacts.accept(alice.identity.deviceId);
    await until(() => alice.contacts.get(bob.identity.deviceId)?.state === 'accepted');
    alice.peers.disconnect(bob.identity.deviceId, 'test');
    await until(() => !bob.peers.isConnected(alice.identity.deviceId));

    await Promise.allSettled([
      alice.peers.connect('127.0.0.1', bob.port, bob.identity.deviceId),
      bob.peers.connect('127.0.0.1', alice.port, alice.identity.deviceId),
    ]);
    await new Promise((r) => setTimeout(r, 200));
    expect(alice.peers.isConnected(bob.identity.deviceId)).toBe(true);
    expect(bob.peers.isConnected(alice.identity.deviceId)).toBe(true);
    const a = alice.peers.get(bob.identity.deviceId);
    const b = bob.peers.get(alice.identity.deviceId);
    // Same TCP link seen from both ends: one side outbound, the other inbound.
    expect(new Set([a?.direction, b?.direction])).toEqual(new Set(['inbound', 'outbound']));
  });

  it('reconnects to accepted contacts after the link drops', async () => {
    const [alice, bob] = await pair();
    await alice.contacts.request('127.0.0.1', bob.port, null, null);
    await until(() => bob.contacts.get(alice.identity.deviceId)?.state === 'incoming');
    await bob.contacts.accept(alice.identity.deviceId);
    await until(() => alice.contacts.get(bob.identity.deviceId)?.state === 'accepted');

    bob.peers.get(alice.identity.deviceId)?.socket.destroy();
    await until(
      () =>
        alice.peers.isConnected(bob.identity.deviceId) &&
        bob.peers.isConnected(alice.identity.deviceId),
      5000,
    );
  });

  it('flags a request whose name matches an existing contact', async () => {
    const lan = new FakeLan();
    const alice = await createNode('Alice', lan);
    const bob = await createNode('Bob', lan);
    const fakeBob = await createNode('Bob', lan);
    nodes.push(alice, bob, fakeBob);
    await alice.contacts.request('127.0.0.1', bob.port, null, null);
    await until(() => bob.contacts.get(alice.identity.deviceId)?.state === 'incoming');
    await bob.contacts.accept(alice.identity.deviceId);
    await until(() => alice.contacts.get(bob.identity.deviceId)?.state === 'accepted');

    await fakeBob.contacts.request('127.0.0.1', alice.port, null, null);
    await until(() => alice.contacts.get(fakeBob.identity.deviceId)?.state === 'incoming');
    const impostor = alice.contacts.list().find((c) => c.deviceId === fakeBob.identity.deviceId);
    expect(impostor?.nameCollision).toBe(true);
  });
});

describe('connection test', () => {
  it('classifies refused, identity, and success', async () => {
    const [alice, bob] = await pair();
    expect((await alice.peers.testConnection('127.0.0.1', 1)).stage).toBe('tcp_refused');
    expect((await alice.peers.testConnection('127.0.0.1', alice.port)).stage).toBe('self');
    const ok = await alice.peers.testConnection('127.0.0.1', bob.port);
    expect(ok).toMatchObject({ stage: 'ok', deviceId: bob.identity.deviceId });
    expect(alice.peers.isConnected(bob.identity.deviceId)).toBe(false);
  });
});
