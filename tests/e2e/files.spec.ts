import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { connectContacts, launch, onboard, tempDataDir, type Instance } from './fixtures';

const dirs: ReturnType<typeof tempDataDir>[] = [];
const instances: Instance[] = [];

test.afterEach(async () => {
  await Promise.all(instances.splice(0).map((i) => i.app.close().catch(() => undefined)));
  dirs.splice(0).forEach((d) => d.cleanup());
});

async function start(name: string): Promise<Instance> {
  const dir = tempDataDir();
  dirs.push(dir);
  const instance = await launch(dir.path);
  instances.push(instance);
  await onboard(instance.page, name);
  return instance;
}

async function openChatWith(page: Page, name: string) {
  await page.getByRole('button', { name: 'People' }).click();
  const row = page
    .getByRole('region', { name: 'Contacts', exact: true })
    .getByRole('listitem')
    .filter({ hasText: name });
  await row.getByRole('button', { name: 'Message' }).click();
}

test('transfers a large file with consent and verifies it byte for byte', async () => {
  test.setTimeout(120_000);
  const alice = await start('Alice');
  const bob = await start('Bob');
  await connectContacts(alice, bob);
  await openChatWith(alice.page, 'Bob');

  const size = 64 * 1024 * 1024;
  const data = randomBytes(size);
  const source = join(alice.dataDir, 'dataset.bin');
  writeFileSync(source, data);
  await alice.page.getByTestId('file-input').setInputFiles(source);

  const sent = alice.page.getByTestId('attachment').filter({ hasText: 'dataset.bin' });
  await expect(sent).toContainText('Waiting for Bob to accept');

  await bob.page.getByRole('button', { name: 'Chats' }).click();
  await bob.page.getByRole('button', { name: /Alice/ }).click();
  const offered = bob.page.getByTestId('attachment').filter({ hasText: 'dataset.bin' });
  await expect(offered).toContainText('Not downloaded');
  await offered.getByRole('button', { name: 'Download' }).click();

  await expect(offered).toContainText('Downloaded and verified', { timeout: 90_000 });
  await expect(sent).toContainText('Delivered');

  // The file on Bob's disk is identical.
  const stored = await bob.app.evaluate(async ({ app }) => app.getPath('userData'));
  const { readdirSync } = await import('node:fs');
  const receivedRoot = join(stored, 'files', 'received');
  const [fileDir] = readdirSync(receivedRoot);
  const received = readFileSync(join(receivedRoot, fileDir ?? '', 'dataset.bin'));
  expect(createHash('sha256').update(received).digest('hex')).toBe(
    createHash('sha256').update(data).digest('hex'),
  );

  // It shows up in Files → History.
  await bob.page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(bob.page.getByRole('region', { name: 'History' })).toContainText('dataset.bin');
});

test('records, sends and plays a voice message with a fake microphone', async () => {
  test.skip(
    process.platform === 'darwin' && !process.env.CI,
    'Avoids the macOS microphone prompt locally.',
  );
  const alice = await start('Alice');
  const bob = await start('Bob');
  await connectContacts(alice, bob);
  await openChatWith(alice.page, 'Bob');

  await alice.page.getByRole('button', { name: 'Record voice message' }).click();
  await expect(alice.page.getByRole('group', { name: 'Recording voice message' })).toBeVisible();
  await alice.page.waitForTimeout(1500);
  await alice.page.getByRole('button', { name: 'Stop' }).click();
  const preview = alice.page.getByRole('group', { name: 'Voice message preview' });
  await preview.getByRole('button', { name: 'Send' }).click();

  await bob.page.getByRole('button', { name: 'Chats' }).click();
  await bob.page.getByRole('button', { name: /Alice/ }).click();
  const player = bob.page.getByTestId('voice-player');
  await expect(player).toBeVisible({ timeout: 15_000 });
  await player.getByRole('button', { name: 'Play voice message' }).click();
  await expect(player.getByRole('button', { name: 'Pause voice message' })).toBeVisible();
});
