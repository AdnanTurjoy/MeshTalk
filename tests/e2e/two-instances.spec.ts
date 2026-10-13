import { expect, test } from '@playwright/test';
import { launch, onboard, tempDataDir, type Instance } from './fixtures';

const dirs: ReturnType<typeof tempDataDir>[] = [];
const instances: Instance[] = [];

test.afterEach(async () => {
  await Promise.all(instances.splice(0).map((i) => i.app.close()));
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

test('two instances connect over mutual TLS and become contacts', async () => {
  const alice = await start('Alice');
  const bob = await start('Bob');
  await alice.page.getByRole('button', { name: 'People' }).click();
  await bob.page.getByRole('button', { name: 'People' }).click();

  // Alice adds Bob by address (discovery stays off: deterministic in CI).
  await alice.page.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await alice.page.getByLabel('Port', { exact: true }).fill(String(bob.peerPort));
  await alice.page.getByLabel('Message (optional)').fill('Hi Bob, it is Alice');
  await alice.page.getByRole('button', { name: 'Send request' }).click();
  await expect(alice.page.getByText('Request sent to the device at that address')).toBeVisible();

  // Bob sees the request with Alice's note and accepts it.
  const requests = bob.page.getByRole('region', { name: 'Contact requests' });
  await expect(requests).toContainText('Alice');
  await expect(requests).toContainText('Hi Bob, it is Alice');
  await requests.getByRole('button', { name: 'Accept' }).click();

  const bobContacts = bob.page.getByRole('region', { name: 'Contacts', exact: true });
  await expect(bobContacts).toContainText('Alice');
  await expect(bobContacts).toContainText('Online');
  const aliceContacts = alice.page.getByRole('region', { name: 'Contacts', exact: true });
  await expect(aliceContacts).toContainText('Bob');
  await expect(aliceContacts).toContainText('bob@example.test (unverified)');

  // Fingerprints shown to each side match the other's own fingerprint.
  await alice.page.getByRole('button', { name: 'Network' }).click();
  const aliceFingerprint = (await alice.page.locator('.fingerprint').first().textContent()) ?? '';
  await bobContacts.getByRole('button', { name: 'Details' }).click();
  const dialog = bob.page.getByRole('dialog');
  await expect(dialog.locator('.fingerprint').first()).toHaveText(aliceFingerprint);
  await dialog.getByRole('button', { name: 'Fingerprints match: mark verified' }).click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(bobContacts).toContainText('Verified');

  // Network test from Bob to Alice reports the right device.
  await bob.page.getByRole('button', { name: 'Network' }).click();
  await bob.page.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await bob.page.getByLabel('Port', { exact: true }).fill(String(alice.peerPort));
  await bob.page.getByRole('button', { name: 'Run test' }).click();
  await expect(bob.page.getByTestId('connection-test-result')).toContainText('Reachable');
  await expect(bob.page.getByTestId('connection-test-result')).toContainText(aliceFingerprint);
});
