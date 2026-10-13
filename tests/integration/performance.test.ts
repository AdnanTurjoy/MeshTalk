import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { directConversationId } from '../../src/shared/chat';
import { tempDir } from './helpers';
import { befriend, createNode, FakeLan, until, type TestNode } from './peer-harness';

let nodes: TestNode[] = [];
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop().catch(() => undefined)));
  nodes = [];
});

describe('performance', () => {
  it('delivers a 2,000-message offline backlog and pages history quickly', async () => {
    const lan = new FakeLan();
    const alice = await createNode('Alice', lan);
    const bob = await createNode('Bob', lan);
    nodes.push(alice, bob);
    await befriend(alice, bob);
    bob.contacts.stop();
    alice.contacts.stop();
    alice.peers.disconnect(bob.identity.deviceId, 'test');
    await until(() => !alice.peers.isConnected(bob.identity.deviceId));

    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const queuedAt = performance.now();
    for (let i = 0; i < 2000; i++) alice.chat.send(conv.id, `message ${i} ${'x'.repeat(80)}`, null);
    const queueMs = performance.now() - queuedAt;

    const started = performance.now();
    await alice.peers.connect('127.0.0.1', bob.port, bob.identity.deviceId);
    await until(() => alice.chat.pendingCount() === 0, 30_000);
    const deliverMs = performance.now() - started;

    const pageStart = performance.now();
    const page = bob.chat.listMessages(directConversationId(alice.identity.deviceId), null, 50);
    const pageMs = performance.now() - pageStart;
    const searchStart = performance.now();
    const hits = bob.chat.search('message 1999', null);
    const searchMs = performance.now() - searchStart;

    console.log(
      `[perf] queue 2000: ${queueMs.toFixed(0)} ms · deliver: ${deliverMs.toFixed(0)} ms · page: ${pageMs.toFixed(1)} ms · search: ${searchMs.toFixed(1)} ms`,
    );
    expect(page.messages).toHaveLength(50);
    expect(hits.length).toBeGreaterThan(0);
    expect(deliverMs).toBeLessThan(20_000);
    expect(pageMs).toBeLessThan(100);
    expect(searchMs).toBeLessThan(200);
  }, 60_000);

  // Large transfers take a while; opt in with MESHTALK_PERF=1.
  it.runIf(process.env.MESHTALK_PERF === '1')(
    'measures large-file throughput',
    async () => {
      const dir = tempDir();
      try {
        const lan = new FakeLan();
        const alice = await createNode('Alice', lan);
        const bob = await createNode('Bob', lan);
        nodes.push(alice, bob);
        await befriend(alice, bob);
        const size = 512 * 1024 * 1024;
        const path = join(dir.path, 'big.bin');
        writeFileSync(path, randomBytes(size));
        const conv = alice.chat.openDirect(bob.identity.deviceId);
        const sent = await alice.transfers.sendPath(conv.id, path);
        await until(() => bob.chat.getMessage(sent.id) !== null);
        const started = performance.now();
        await bob.transfers.accept(sent.attachment?.fileId ?? '');
        await until(() => bob.chat.getMessage(sent.id)?.attachment?.state === 'complete', 300_000);
        const seconds = (performance.now() - started) / 1000;
        console.log(
          `[perf] 512 MB over loopback TLS: ${(size / 1024 / 1024 / seconds).toFixed(0)} MB/s`,
        );
      } finally {
        dir.cleanup();
      }
    },
    330_000,
  );
});
