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
  await expect(page.getByRole('region', { name: `Conversation with ${name}` })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.keyboard.press('Enter');
}

function messages(page: Page) {
  return page.getByRole('list', { name: 'Messages' });
}

test('send, receive, reply, react and read across two instances', async () => {
  const alice = await start('Alice');
  const bob = await start('Bob');
  await connectContacts(alice, bob);

  await openChatWith(alice.page, 'Bob');
  await send(alice.page, 'Hello Bob 👋');
  await expect(messages(alice.page)).toContainText('Hello Bob 👋');

  // Bob is on People: the sidebar shows an unread count, and the chat list a preview.
  await expect(bob.page.getByRole('navigation').getByLabel('1 pending')).toBeVisible();
  await bob.page.getByRole('button', { name: 'Chats' }).click();
  await bob.page.getByRole('button', { name: /Alice/ }).click();
  await expect(messages(bob.page)).toContainText('Hello Bob 👋');

  // Reply and react.
  const incoming = messages(bob.page)
    .getByRole('listitem')
    .filter({ hasText: 'Hello Bob' })
    .first();
  await incoming.hover();
  await incoming.getByRole('button', { name: 'Reply' }).click();
  await send(bob.page, 'Hi Alice!');
  await incoming.hover();
  await incoming.getByRole('button', { name: 'React', exact: true }).click();
  await incoming.getByRole('button', { name: 'React with 🎉' }).click();

  const reply = messages(alice.page).getByRole('listitem').filter({ hasText: 'Hi Alice!' });
  await expect(reply).toContainText('Hello Bob');
  const original = messages(alice.page)
    .getByRole('listitem')
    .filter({ hasText: 'Hello Bob 👋' })
    .first();
  await expect(original.getByRole('button', { name: /🎉 1/ })).toBeVisible();

  // Bob had the conversation open, so Alice sees it as read.
  await expect(original.getByText('Read')).toBeAttached();

  // Edit, then delete for everyone.
  await original.hover();
  await original.getByRole('button', { name: 'Edit' }).click();
  await alice.page.getByRole('textbox', { name: 'Message' }).fill('Hello Bob (edited)');
  await alice.page.keyboard.press('Enter');
  await expect(messages(bob.page)).toContainText('Hello Bob (edited)');
  await expect(messages(bob.page)).toContainText('edited');

  const edited = messages(alice.page)
    .getByRole('listitem')
    .filter({ hasText: 'Hello Bob (edited)' })
    .first();
  await edited.hover();
  await edited.getByRole('button', { name: 'Delete' }).click();
  await edited.getByRole('button', { name: 'Delete for everyone' }).click();
  await expect(messages(bob.page)).toContainText('This message was deleted');

  // Search finds Bob's reply.
  await alice.page.getByRole('searchbox', { name: 'Search all messages' }).fill('alice');
  await expect(alice.page.getByRole('list', { name: 'Search results' })).toContainText('Hi Alice!');
});

test('messages to an offline contact wait in the outbox and deliver after restart', async () => {
  const alice = await start('Alice');
  const bob = await start('Bob');
  await connectContacts(alice, bob);
  await openChatWith(alice.page, 'Bob');

  // Bob quits.
  await bob.app.close();
  instances.splice(instances.indexOf(bob), 1);
  await expect(alice.page.getByRole('region', { name: 'Conversation with Bob' })).toContainText(
    'Offline',
  );

  await send(alice.page, 'Are you there?');
  await expect(
    alice.page.getByRole('status').filter({ hasText: 'waiting on this device' }),
  ).toBeVisible();
  await expect(messages(alice.page).getByText('Not delivered yet')).toBeAttached();

  // Draft survives switching away.
  await alice.page.getByRole('textbox', { name: 'Message' }).fill('unsent draft');
  await alice.page.waitForTimeout(600);
  await alice.page.getByRole('button', { name: 'People' }).click();
  await alice.page.getByRole('button', { name: 'Chats' }).click();
  await alice.page.getByRole('button', { name: /Bob/ }).click();
  await expect(alice.page.getByRole('textbox', { name: 'Message' })).toHaveValue('unsent draft');

  // Bob restarts with the same data and port: Alice reconnects and delivers.
  const bobAgain = await launch(bob.dataDir, bob.peerPort);
  instances.push(bobAgain);
  await expect(bobAgain.page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  await expect(messages(alice.page).getByText('Delivered')).toBeAttached({ timeout: 20_000 });
  await bobAgain.page.getByRole('button', { name: /Alice/ }).click();
  await expect(messages(bobAgain.page)).toContainText('Are you there?');
});
