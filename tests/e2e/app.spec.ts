import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, onboard, tempDataDir } from './fixtures';

let data: ReturnType<typeof tempDataDir>;

test.beforeEach(() => {
  data = tempDataDir();
});

test.afterEach(() => {
  data.cleanup();
});

async function prefersDark(page: Page): Promise<boolean> {
  return page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
}

async function nativeThemeSource(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
}

test('onboarding, profile and theme persist across restart', async () => {
  let { app, page } = await launch(data.path);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Enter a name')).toBeVisible();
  await page.getByLabel('Your name').fill('Ada Lovelace');
  await page.getByLabel('Email (optional)').fill('not-an-email');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Enter a valid email address')).toBeVisible();
  await page.getByLabel('Email (optional)').fill('Ada@Example.org');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('radio', { name: 'Dark' }).check();
  await expect.poll(() => nativeThemeSource(app)).toBe('dark');
  await expect.poll(() => prefersDark(page)).toBe(true);
  await page.getByRole('button', { name: 'Get started' }).click();
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  await app.close();

  ({ app, page } = await launch(data.path));
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  await expect(page.getByRole('navigation')).toContainText('Ada Lovelace');
  await expect(page.getByRole('navigation')).toContainText('ada@example.org');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
  expect(await prefersDark(page)).toBe(true);
  await app.close();
});

test('diagnostics runs a real database integrity check', async () => {
  const { app, page } = await launch(data.path);
  await onboard(page, 'Grace');
  await page.getByRole('button', { name: 'Diagnostics' }).click();
  await expect(page.getByText(data.path, { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Run check' }).click();
  await expect(page.getByTestId('integrity-result')).toContainText('Healthy');
  await app.close();
});

test('renderer is isolated from Node and only sees the narrow API', async () => {
  const { app, page } = await launch(data.path);
  const surface = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      require: typeof w.require,
      process: typeof w.process,
      apiKeys: Object.keys(window.meshtalk).sort(),
    };
  });
  expect(surface).toEqual({
    require: 'undefined',
    process: 'undefined',
    apiKeys: ['invoke', 'onEvent', 'sendFile'],
  });

  const rejected = await page.evaluate(() =>
    window.meshtalk.invoke('settings:set', { key: 'theme', value: 'neon' } as never),
  );
  expect(rejected).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

  const unknownChannel = await page.evaluate(() =>
    (window.meshtalk.invoke as (c: string) => Promise<unknown>)('db:drop-everything'),
  );
  expect(unknownChannel).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

  // Only camera/microphone are grantable (and only on user action); everything else is denied.
  const denied = await page.evaluate(async () => {
    const notification = await Notification.requestPermission();
    const geolocation = await new Promise<string>((resolve) =>
      navigator.geolocation.getCurrentPosition(
        () => resolve('granted'),
        (e) => resolve(e.code === e.PERMISSION_DENIED ? 'denied' : 'error'),
      ),
    );
    return { notification, geolocation };
  });
  expect(denied).toEqual({ notification: 'denied', geolocation: 'denied' });
  await app.close();
});

test('quits promptly and cleanly, with networking running', async () => {
  const { app, page } = await launch(data.path);
  await onboard(page, 'Quitter');
  const proc = app.process();
  const exited = new Promise<number | null>((resolve) =>
    proc.once('exit', (code) => resolve(code)),
  );
  const started = Date.now();
  // A real quit (menu / Cmd+Q path), not Playwright's forced close.
  await app
    .evaluate(({ app: electronApp }) => setTimeout(() => electronApp.quit(), 0))
    .catch(() => undefined);
  const code = await Promise.race([
    exited,
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000)),
  ]);
  expect(code).not.toBe('timeout');
  expect(Date.now() - started).toBeLessThan(10_000);
  const { readFileSync } = await import('node:fs');
  const log = readFileSync(join(data.path, 'logs', 'meshtalk.log'), 'utf8');
  expect(log).toContain('"event":"app.stop"');
  expect(log).not.toContain('"level":"error"');
});
