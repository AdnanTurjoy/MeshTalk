import { release } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  shell,
} from 'electron';
import type { AppEvent } from '../shared/events';
import { ALLOWED_WHILE_LOCKED, IPC_EVENT_CHANNEL, type Screen } from '../shared/ipc';
import type { Theme } from '../shared/settings';
import { AppServices } from './app-services';
import { applyPendingDataOperations } from './data/backup-service';
import { openDatabase, type DatabaseHandle } from './db/connection';
import { DatabaseNewerThanAppError, MigrationChecksumError } from './db/migrator';
import { IdentityUnavailableError } from './identity/identity-service';
import { buildRoutes } from './ipc/routes';
import { FILE_SCHEME, handleFileRequest } from './files/file-protocol';
import { createLogger, fileSink, parseLogLevel, type Logger } from './logger';
import { buildMenu } from './menu';
import { appPaths, profileUserData } from './platform/paths';
import { InvalidProfileError, resolveProfile } from './platform/profile';
import { safeStorageSecretStore } from './secrets/secret-store';
import { applySessionHardening, installGlobalHardening } from './security';
import { isAllowedAppUrl, type AppOrigin } from './url-policy';

const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const isMac = process.platform === 'darwin';
const rendererDir = join(__dirname, '../renderer');
const appOrigin: AppOrigin = devServerUrl
  ? { kind: 'dev', url: devServerUrl }
  : { kind: 'file', rendererDirUrl: pathToFileURL(rendererDir).href };

let profile: string | null;
try {
  profile = resolveProfile(process.argv, process.env);
} catch (error) {
  dialog.showErrorBox(
    'MeshTalk',
    error instanceof InvalidProfileError ? error.message : String(error),
  );
  app.exit(1);
  throw error;
}
// Must run before `ready` so that every Electron-managed path uses the override.
const dataDirOverride = process.env.MESHTALK_DATA_DIR;
if (dataDirOverride && isAbsolute(dataDirOverride)) {
  app.setPath('userData', dataDirOverride);
} else if (profile) {
  app.setPath('userData', profileUserData(app.getPath('appData'), app.getName(), profile));
}

const paths = appPaths(app.getPath('userData'));
const logger: Logger = createLogger({
  level: parseLogLevel(process.env.MESHTALK_LOG_LEVEL, devServerUrl ? 'debug' : 'info'),
  sink: fileSink(paths.logs, Boolean(devServerUrl)),
});

// Must be registered before `ready`.
protocol.registerSchemesAsPrivileged([
  {
    scheme: FILE_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

let database: DatabaseHandle | null = null;
let services: AppServices | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;
/** Stops timers and listeners registered in start(); run first when quitting. */
const shutdownHooks: (() => void)[] = [];

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  installGlobalHardening(logger, appOrigin);
  app.on('second-instance', focusWindow);
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => fatal(error));
}

async function start(): Promise<void> {
  logger.info('app.start', { version: app.getVersion(), profile, platform: process.platform });
  applySessionHardening(logger, appOrigin);

  const applied = await applyPendingDataOperations(paths, logger);
  database = openDatabase(paths.database);
  if (applied) logger.info('startup.data_operation', { applied });
  logger.info('db.ready', {
    applied: database.migration.applied,
    version: database.migration.currentVersion,
  });

  services = await AppServices.create({
    database,
    secrets: safeStorageSecretStore(
      safeStorage,
      process.platform,
      app.commandLine.hasSwitch('use-mock-keychain'),
    ),
    logger,
    emit,
    notify,
    isWindowFocused: () => mainWindow?.isFocused() ?? false,
    paths,
    appVersion: app.getVersion(),
    ...(process.env.MESHTALK_PEER_PORT ? { peerPort: Number(process.env.MESHTALK_PEER_PORT) } : {}),
  });
  const svc = services;
  applyTheme(svc.settings.get('theme'));
  protocol.handle(FILE_SCHEME, (request) =>
    handleFileRequest(request, (fileId) => svc.transfers.previewSource(fileId)),
  );

  const isTrustedSender = (url: string) => isAllowedAppUrl(url, appOrigin);
  const routes = buildRoutes({
    database,
    services: svc,
    paths,
    appInfo: { name: app.getName(), version: app.getVersion(), profile, packaged: app.isPackaged },
    os: { platform: process.platform, arch: process.arch, release: release() },
    onSettingsChanged: () => applyTheme(svc.settings.get('theme')),
    onAccountChanged: () => emit({ type: 'account-changed' }),
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    chooseFolder: async (title, buttonLabel) => {
      const options = {
        title,
        buttonLabel,
        properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    relaunch: () => {
      app.relaunch();
      app.quit();
    },
    onLockChanged: () => emit({ type: 'lock-changed' }),
    chooseSavePath: async (defaultName) => {
      const options = { defaultPath: join(app.getPath('downloads'), defaultName) };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
  });
  // While the app lock is engaged, main refuses everything except unlocking.
  const gate = (channel: string) =>
    svc.lock.locked && !ALLOWED_WHILE_LOCKED.has(channel) ? 'MeshTalk is locked.' : null;
  for (const r of routes) {
    ipcMain.handle(r.channel, r.handler(isTrustedSender, logger, gate));
  }

  const lockNow = () => {
    if (svc.lock.lock()) emit({ type: 'lock-changed' });
  };
  const onResume = () => {
    logger.info('power.resume');
    void svc.restartDiscovery();
    svc.contacts.reconnectAll();
  };
  powerMonitor.on('lock-screen', lockNow);
  powerMonitor.on('suspend', lockNow);
  powerMonitor.on('resume', onResume);
  const idleTimer = setInterval(() => {
    const minutes = svc.settings.get('appLockIdleMinutes');
    if (minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) lockNow();
  }, 30_000);
  idleTimer.unref();
  // These all touch services/the database, so they must stop before shutdown closes it.
  shutdownHooks.push(() => {
    clearInterval(idleTimer);
    powerMonitor.off('lock-screen', lockNow);
    powerMonitor.off('suspend', lockNow);
    powerMonitor.off('resume', onResume);
  });

  Menu.setApplicationMenu(
    buildMenu({
      isMac,
      isDev: Boolean(devServerUrl),
      appName: app.getName(),
      navigate,
      lock: () => {
        if (svc.lock.lock()) emit({ type: 'lock-changed' });
      },
    }),
  );

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: profile ? `MeshTalk (${profile})` : 'MeshTalk',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161a' : '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('focus', () => services?.chat.onWindowFocused());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logger.error('renderer.gone', { reason: details.reason, exitCode: details.exitCode });
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(join(rendererDir, 'index.html'));
  }
}

function focusWindow(): void {
  if (!mainWindow) {
    if (app.isReady() && services) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function emit(event: AppEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_EVENT_CHANNEL, event);
  }
}

function navigate(screen: Screen): void {
  emit({ type: 'navigate', screen });
}

/** OS notification; shows nothing about message content beyond what is passed. */
function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  if (mainWindow?.isFocused()) return;
  // While locked, don't reveal who wrote or called.
  const locked = services?.lock.locked ?? false;
  const n = new Notification({
    title: locked ? 'MeshTalk' : title,
    body: locked ? 'You have new activity.' : body,
    silent: false,
  });
  n.on('click', focusWindow);
  n.show();
}

function applyTheme(theme: Theme): void {
  // The renderer styles itself from `prefers-color-scheme`, which follows this.
  nativeTheme.themeSource = theme;
}

function fatal(error: unknown): void {
  logger.error('app.fatal', { error });
  let detail = 'MeshTalk could not start. Details were written to the log.';
  if (error instanceof DatabaseNewerThanAppError) {
    detail =
      'This data was created by a newer version of MeshTalk. Install the newer version, ' +
      'or restore a backup made with this version. Your data has not been changed.';
  } else if (error instanceof MigrationChecksumError) {
    detail =
      'The database schema history does not match this build of MeshTalk. Your data has not been changed.';
  } else if (error instanceof IdentityUnavailableError) {
    detail =
      "This device's private key could not be unlocked with the system keychain. MeshTalk will not " +
      'create a new identity automatically, because your contacts trust the current one. Restore ' +
      'access to the keychain, or restore a backup.';
  } else if (error instanceof Error && /not a database|malformed/i.test(error.message)) {
    detail =
      'The local database appears to be damaged. Restore it from a backup, or move it aside to start fresh.';
  }
  dialog.showErrorBox(
    'MeshTalk could not start',
    `${detail}\n\nData folder: ${paths.userData}\nLogs: ${paths.logs}`,
  );
  app.exit(1);
}

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

// Stop networking and close the database before exiting, exactly once.
app.on('before-quit', (event) => {
  if (quitting || !services) return;
  event.preventDefault();
  quitting = true;
  for (const hook of shutdownHooks.splice(0)) hook();
  const svc = services;
  services = null;
  svc
    .stop()
    .catch((error: unknown) => logger.warn('app.stop_failed', { error }))
    .finally(() => {
      database?.close();
      database = null;
      logger.info('app.stop');
      app.quit();
    });
});
