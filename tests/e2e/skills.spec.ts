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

async function addSkill(page: Page, title: string, shared: boolean) {
  await page.getByRole('button', { name: 'Add skill' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add skill' });
  await dialog.getByLabel('Title').fill(title);
  if (shared) await dialog.getByLabel('Visible to my contacts').check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('region', { name: 'Skills and interests' })).toContainText(title);
}

test('contacts find shared skills; private ones never leave the device', async () => {
  const alice = await start('Alice');
  const bob = await start('Bob');
  await alice.page.getByRole('button', { name: 'Skills' }).click();
  await addSkill(alice.page, 'Rust', true);
  await addSkill(alice.page, 'Payroll secrets', false);

  await connectContacts(alice, bob);
  await bob.page.getByRole('button', { name: 'Skills' }).click();
  await bob.page.getByRole('tab', { name: 'Directory' }).click();
  await bob.page.getByRole('searchbox', { name: 'Search skills' }).fill('rust');
  await expect(bob.page.getByRole('list', { name: 'Skill search results' })).toContainText(
    'Alice · Rust',
  );
  await bob.page.getByRole('searchbox', { name: 'Search skills' }).fill('payroll');
  await expect(bob.page.getByRole('list', { name: 'Skill search results' })).toContainText(
    'No contacts list that skill',
  );

  // Ask for help → Alice accepts.
  await bob.page.getByRole('searchbox', { name: 'Search skills' }).fill('rust');
  await bob.page.getByRole('button', { name: 'Ask for help' }).first().click();
  await bob.page.getByRole('dialog').getByRole('button', { name: 'Send request' }).click();
  await alice.page.getByRole('button', { name: 'Skills' }).click();
  await alice.page.getByRole('tab', { name: 'Requests' }).click();
  await alice.page.getByRole('button', { name: 'Accept' }).click();
  await bob.page.getByRole('tab', { name: 'Requests' }).click();
  await expect(
    bob.page.getByRole('region', { name: 'Mentorship and collaboration' }),
  ).toContainText('accepted');
});
