import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const appEntry = join(__dirname, '..', '..', 'out', 'main', 'index.js');
/** Set to a packaged binary (e.g. dist/mac-arm64/MeshTalk.app/Contents/MacOS/MeshTalk) to test a release build. */
const packagedExecutable = process.env.MESHTALK_E2E_EXECUTABLE;

/** Chromium's synthetic camera/microphone: tests never touch real devices. */
const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

export interface Instance {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  peerPort: number;
}

export function tempDataDir(): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), 'meshtalk-e2e-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

export async function launch(dataDir: string, peerPort?: number): Promise<Instance> {
  // Hosts such as VS Code's extension host export ELECTRON_RUN_AS_NODE, which
  // would start Electron as plain Node; the dev-server URL must not leak either.
  const { ELECTRON_RUN_AS_NODE: _node, ELECTRON_RENDERER_URL: _url, ...env } = process.env;
  const port = peerPort ?? (await freePort());
  const app = await electron.launch({
    ...(packagedExecutable
      ? { executablePath: packagedExecutable, args: [...FAKE_MEDIA] }
      : { args: [appEntry, ...FAKE_MEDIA] }),
    env: { ...env, MESHTALK_DATA_DIR: dataDir, MESHTALK_PEER_PORT: String(port) } as Record<
      string,
      string
    >,
    // Let prefers-color-scheme follow the app's nativeTheme, not Playwright's emulation.
    colorScheme: null,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, dataDir, peerPort: port };
}

/** Completes onboarding with the given name. */
export async function onboard(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Welcome to MeshTalk' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email (optional)').fill(`${name.toLowerCase()}@example.test`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Privacy and look' })).toBeVisible();
  await page.getByRole('button', { name: 'Get started' }).click();
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
}

/** Alice sends Bob a contact request by address; Bob accepts. */
export async function connectContacts(alice: Instance, bob: Instance): Promise<void> {
  await alice.page.getByRole('button', { name: 'People' }).click();
  await bob.page.getByRole('button', { name: 'People' }).click();
  await alice.page.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await alice.page.getByLabel('Port', { exact: true }).fill(String(bob.peerPort));
  await alice.page.getByRole('button', { name: 'Send request' }).click();
  const requests = bob.page.getByRole('region', { name: 'Contact requests' });
  await requests.getByRole('button', { name: 'Accept' }).click();
  await expect(alice.page.getByRole('region', { name: 'Contacts', exact: true })).toContainText(
    'Online',
  );
}
