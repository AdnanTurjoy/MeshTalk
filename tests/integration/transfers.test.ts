import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

async function friends(opts: Parameters<typeof createNode>[2] = {}): Promise<[TestNode, TestNode]> {
  const lan = new FakeLan();
  const alice = await createNode('Alice', lan);
  const bob = await createNode('Bob', lan, opts);
  nodes.push(alice, bob);
  await befriend(alice, bob);
  return [alice, bob];
}

function makeFile(name: string, bytes: number): { path: string; sha: string; data: Buffer } {
  const data = randomBytes(bytes);
  const path = join(dir.path, name);
  writeFileSync(path, data);
  return { path, sha: createHash('sha256').update(data).digest('hex'), data };
}

function attachment(node: TestNode, messageId: string) {
  return node.chat.getMessage(messageId)?.attachment ?? null;
}

describe('file transfer', () => {
  it('requires acceptance, then transfers and verifies a multi-chunk file', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const src = makeFile('report.pdf', 3 * 1024 * 1024 + 123);
    const sent = await alice.transfers.sendPath(conv.id, src.path);
    expect(sent.attachment).toMatchObject({
      name: 'report.pdf',
      size: src.data.length,
      state: 'offered',
    });

    await until(() => attachment(bob, sent.id) !== null);
    expect(attachment(bob, sent.id)).toMatchObject({
      state: 'offered',
      available: false,
      direction: 'incoming',
    });

    await bob.transfers.accept(sent.attachment?.fileId ?? '');
    await until(() => attachment(bob, sent.id)?.state === 'complete', 10_000);
    await until(() => attachment(alice, sent.id)?.state === 'complete');
    const { path } = bob.transfers.pathForUser(sent.attachment?.fileId ?? '');
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(src.sha);
    expect(path.startsWith(bob.filesDir)).toBe(true);
    expect(bob.events.some((e) => e.type === 'transfer-progress' && e.progress.bytesDone > 0)).toBe(
      true,
    );
  });

  it('resumes from the last byte after the connection drops', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const src = makeFile('video.mp4', 24 * 1024 * 1024);
    const sent = await alice.transfers.sendPath(conv.id, src.path);
    const fileId = sent.attachment?.fileId ?? '';
    await until(() => attachment(bob, sent.id) !== null);
    await bob.transfers.accept(fileId);

    await until(() => (attachment(bob, sent.id)?.bytesDone ?? 0) > 4 * 1024 * 1024, 10_000);
    bob.peers.get(alice.identity.deviceId)?.socket.destroy();
    await until(() => attachment(bob, sent.id)?.state === 'waiting');
    const resumedFrom = attachment(bob, sent.id)?.bytesDone ?? 0;
    expect(resumedFrom).toBeGreaterThan(0);

    alice.contacts.reconnectAll();
    await until(() => attachment(bob, sent.id)?.state === 'complete', 20_000);
    const { path } = bob.transfers.pathForUser(fileId);
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(src.sha);
  });

  it('pauses and resumes on request', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const src = makeFile('big.bin', 24 * 1024 * 1024);
    const sent = await alice.transfers.sendPath(conv.id, src.path);
    const fileId = sent.attachment?.fileId ?? '';
    await until(() => attachment(bob, sent.id) !== null);
    await bob.transfers.accept(fileId);
    await until(() => (attachment(bob, sent.id)?.bytesDone ?? 0) > 1024 * 1024, 10_000);
    bob.transfers.pause(fileId);
    expect(attachment(bob, sent.id)?.state).toBe('paused');
    await until(() => attachment(alice, sent.id)?.state === 'paused');
    await bob.transfers.resume(fileId);
    await until(() => attachment(bob, sent.id)?.state === 'complete', 20_000);
  });

  it('declines and cancels', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const a = await alice.transfers.sendPath(conv.id, makeFile('a.txt', 1000).path);
    await until(() => attachment(bob, a.id) !== null);
    bob.transfers.decline(a.attachment?.fileId ?? '');
    await until(() => attachment(alice, a.id)?.state === 'declined');

    const b = await alice.transfers.sendPath(conv.id, makeFile('b.txt', 1000).path);
    await until(() => attachment(bob, b.id) !== null);
    await alice.transfers.cancel(b.attachment?.fileId ?? '');
    await until(() => attachment(bob, b.id)?.state === 'cancelled');
  });

  it('fails cleanly when the source changes before sending', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const src = makeFile('draft.docx', 2000);
    const sent = await alice.transfers.sendPath(conv.id, src.path);
    writeFileSync(src.path, 'changed after offering, different size');
    await until(() => attachment(bob, sent.id) !== null);
    await bob.transfers.accept(sent.attachment?.fileId ?? '');
    await until(() => attachment(bob, sent.id)?.state === 'failed');
    expect(attachment(bob, sent.id)?.error).toMatch(/moved, deleted or changed/);
  });

  it('rejects tampered chunks and discards the partial file', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const src = makeFile('data.bin', 4 * 1024 * 1024);
    const sent = await alice.transfers.sendPath(conv.id, src.path);
    const fileId = sent.attachment?.fileId ?? '';
    await until(() => attachment(bob, sent.id) !== null);

    // Alice's link starts corrupting data after the header hash was computed.
    const conn = alice.peers.get(bob.identity.deviceId);
    const original = conn?.sendBinary.bind(conn);
    if (conn && original) {
      conn.sendBinary = (header, data) => {
        const copy = Buffer.from(data);
        copy[0] = (copy[0] ?? 0) ^ 0xff;
        return original(header, copy);
      };
    }
    await bob.transfers.accept(fileId);
    await until(() => attachment(bob, sent.id)?.state === 'failed');
    expect(attachment(bob, sent.id)?.error).toMatch(/damaged/);
    expect(existsSync(join(bob.filesDir, 'partial', `${fileId}.part`))).toBe(false);
  });

  it('sanitizes hostile file names', async () => {
    const [alice, bob] = await friends();
    const conv = directConversationId(bob.identity.deviceId);
    alice.chat.openDirect(bob.identity.deviceId);
    const data = Buffer.from('payload');
    const sent = await alice.transfers.sendBytes(
      conv,
      '../../../../etc/passwd',
      'text/plain',
      'file',
      null,
      data,
    );
    await until(() => attachment(bob, sent.id) !== null);
    expect(attachment(bob, sent.id)?.name).toBe('passwd');

    // A raw offer bypassing the sender's own sanitizer.
    alice.peers.send(bob.identity.deviceId, {
      t: 'ev',
      eid: crypto.randomUUID(),
      conv: null,
      ev: {
        k: 'msg',
        id: '01900000-0000-7000-8000-000000000001',
        kind: 'file',
        body: '',
        replyTo: null,
        sentAt: Date.now(),
        mentions: [],
        file: {
          fileId: crypto.randomUUID(),
          name: '..\\..\\CON.txt',
          size: 7,
          mime: 'text/html',
          sha256: 'a'.repeat(64),
          durationMs: null,
        },
      },
    });
    await until(() => bob.chat.getMessage('01900000-0000-7000-8000-000000000001') !== null);
    const hostile = attachment(bob, '01900000-0000-7000-8000-000000000001');
    expect(hostile?.name).toBe('_CON.txt');
    expect(hostile?.mime).toBe('application/octet-stream');
  });

  it('refuses files that do not fit on disk', async () => {
    const [alice, bob] = await friends({ freeSpace: async () => 1024 });
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const sent = await alice.transfers.sendPath(conv.id, makeFile('x.bin', 4096).path);
    await until(() => attachment(bob, sent.id) !== null);
    await expect(bob.transfers.accept(sent.attachment?.fileId ?? '')).rejects.toThrow(
      /free disk space/,
    );
  });

  it('auto-accepts small voice notes and copies duplicates locally', async () => {
    const [alice, bob] = await friends();
    const conv = alice.chat.openDirect(bob.identity.deviceId);
    const voice = randomBytes(20_000);
    const v = await alice.transfers.sendBytes(
      conv.id,
      'voice.webm',
      'audio/webm',
      'voice',
      3000,
      voice,
    );
    await until(() => attachment(bob, v.id)?.state === 'complete');
    expect(attachment(bob, v.id)).toMatchObject({ durationMs: 3000, previewKind: 'audio' });

    // Same bytes again as a regular file: Bob copies the copy he has.
    const again = await alice.transfers.sendBytes(
      conv.id,
      'copy.webm',
      'audio/webm',
      'file',
      null,
      voice,
    );
    await until(() => attachment(bob, again.id) !== null);
    await bob.transfers.accept(again.attachment?.fileId ?? '');
    await until(() => attachment(bob, again.id)?.state === 'complete');
    await until(() => attachment(alice, again.id)?.state === 'complete');
  });
});
