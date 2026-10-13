import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, onboard, tempDataDir } from './fixtures';

let data: ReturnType<typeof tempDataDir>;
test.beforeEach(() => {
  data = tempDataDir();
});
test.afterEach(() => data.cleanup());

test('app lock survives restart and main refuses requests while locked', async () => {
  let { app, page } = await launch(data.path);
  await onboard(page, 'Ada');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Turn on app lock' }).click();
  const dialog = page.getByRole('dialog', { name: 'Turn on app lock' });
  await dialog.getByLabel('New PIN or passphrase').fill('4321');
  await dialog.getByLabel('Repeat it').fill('4321');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Lock now' })).toBeVisible();
  await app.close();

  ({ app, page } = await launch(data.path));
  await expect(page.getByRole('heading', { name: 'MeshTalk is locked' })).toBeVisible();
  const refused = await page.evaluate(() => window.meshtalk.invoke('contacts:list'));
  expect(refused).toMatchObject({ ok: false, error: { message: 'MeshTalk is locked.' } });

  await page.getByLabel('PIN or passphrase').fill('0000');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong PIN');
  await page.getByLabel('PIN or passphrase').fill('4321');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  await app.close();
});

test('creates a backup folder with database, manifest and wrapped identity', async () => {
  const { app, page } = await launch(data.path);
  await onboard(page, 'Ada');
  const target = join(data.path, 'backups');
  // Native folder pickers can't be clicked by Playwright; answer them from main.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
  }, target);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(target, { recursive: true });

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Back up…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Back up MeshTalk' });
  await dialog.getByLabel('Passphrase', { exact: true }).fill('long enough passphrase');
  await dialog.getByLabel('Repeat passphrase').fill('long enough passphrase');
  await dialog.getByRole('button', { name: 'Choose folder and back up' }).click();
  await expect(page.getByText(/Backup saved/)).toBeVisible();

  const [folder] = readdirSync(target);
  const dir = join(target, folder ?? '');
  expect(existsSync(join(dir, 'meshtalk.db'))).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({
    format: 'meshtalk-backup',
    hasIdentity: true,
  });
  const identity = readFileSync(join(dir, 'identity.json'), 'utf8');
  expect(identity).not.toContain('PRIVATE KEY');
  await app.close();
});
