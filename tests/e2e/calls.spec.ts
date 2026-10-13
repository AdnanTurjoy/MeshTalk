import { expect, test, type Page } from '@playwright/test';
import { connectContacts, launch, onboard, tempDataDir, type Instance } from './fixtures';

// Uses Chromium's synthetic camera/microphone. This proves signaling, ICE and
// media flow between two app instances on one machine; it is not evidence that
// calls work across real networks and devices (see docs/testing.md).

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
  await page
    .getByRole('region', { name: 'Contacts', exact: true })
    .getByRole('listitem')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Message' })
    .click();
}

test.skip(
  process.platform === 'darwin' && !process.env.CI,
  'Avoids macOS camera prompts locally; set CI=1 to run.',
);

test('video call connects, flows media both ways, and ends cleanly', async () => {
  const alice = await start('Alice');
  const bob = await start('Bob');
  await connectContacts(alice, bob);
  await openChatWith(alice.page, 'Bob');

  await alice.page.getByRole('button', { name: 'Start video call' }).click();
  await expect(alice.page.getByTestId('call-status')).toHaveText('Ringing…');

  const incoming = bob.page.getByRole('alertdialog');
  await expect(incoming).toContainText('Alice');
  await expect(incoming).toContainText('Incoming video call');
  await incoming.getByRole('button', { name: 'Answer' }).click();

  // Duration replaces the status once ICE connects.
  await expect(alice.page.getByTestId('call-status')).toHaveText(/^\d+:\d{2}$/, {
    timeout: 20_000,
  });
  await expect(bob.page.getByTestId('call-status')).toHaveText(/^\d+:\d{2}$/, { timeout: 20_000 });

  // Remote video is actually decoding frames on both sides.
  for (const page of [alice.page, bob.page]) {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const v = document.querySelector<HTMLVideoElement>('.call__remote');
            return v ? v.videoWidth > 0 && v.currentTime > 0 : false;
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
  }

  const controls = alice.page.getByRole('toolbar', { name: 'Call controls' });
  await controls.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(controls.getByRole('button', { name: 'Unmute' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await bob.page
    .getByRole('toolbar', { name: 'Call controls' })
    .getByRole('button', { name: 'End call' })
    .click();
  await expect(alice.page.getByTestId('call-status')).toHaveText('Call ended');

  // Both sides record it.
  await bob.page.getByTestId('call-view').waitFor({ state: 'detached', timeout: 10_000 });
  await bob.page.getByRole('button', { name: 'Calls' }).click();
  await expect(bob.page.getByRole('region', { name: 'Recent calls' })).toContainText(
    'Incoming video call',
  );
});

test('declined calls end for the caller', async () => {
  const alice = await start('Alice');
  const bob = await start('Bob');
  await connectContacts(alice, bob);
  await openChatWith(alice.page, 'Bob');

  await alice.page.getByRole('button', { name: 'Start audio call' }).click();
  await bob.page.getByRole('alertdialog').getByRole('button', { name: 'Decline' }).click();
  await expect(alice.page.getByTestId('call-status')).toHaveText('Call declined');
});
