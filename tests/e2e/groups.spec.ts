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

async function join(page: Page) {
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  const invites = page.getByRole('region', { name: 'Group invitations' });
  await expect(invites).toContainText('Lab');
  await invites.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByRole('region', { name: 'Conversation with Lab' })).toBeVisible();
}

test('create a group, join from two devices, and talk across non-contacts', async () => {
  test.setTimeout(90_000);
  const alice = await start('Alice');
  const bob = await start('Bob');
  const carol = await start('Carol');
  await connectContacts(alice, bob);
  await connectContacts(alice, carol);

  await alice.page.getByRole('button', { name: 'Chats', exact: true }).click();
  await alice.page.getByRole('button', { name: 'New group' }).click();
  const dialog = alice.page.getByRole('dialog', { name: 'New group' });
  await dialog.getByLabel('Group name').fill('Lab');
  await dialog.getByLabel('Bob').check();
  await dialog.getByLabel('Carol').check();
  await dialog.getByRole('button', { name: 'Create group' }).click();
  await expect(alice.page.getByRole('region', { name: 'Conversation with Lab' })).toBeVisible();

  await join(bob.page);
  await join(carol.page);

  // Alice sees both as active members.
  await alice.page.getByRole('button', { name: 'Group info' }).click();
  const members = alice.page.getByRole('list', { name: 'Members' });
  await expect(members.getByText('Invited')).toHaveCount(0, { timeout: 15_000 });
  await alice.page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  // Bob (not Carol's contact) posts; Carol receives it directly from Bob.
  await bob.page.getByRole('textbox', { name: 'Message' }).fill('Hello @Carol from Bob');
  await bob.page.keyboard.press('Enter');
  const carolMessages = carol.page.getByRole('list', { name: 'Messages' });
  await expect(carolMessages).toContainText('Hello @Carol from Bob', { timeout: 20_000 });
  await expect(carolMessages).toContainText('Bob');
  await expect(alice.page.getByRole('list', { name: 'Messages' })).toContainText(
    'Hello @Carol from Bob',
  );
});
