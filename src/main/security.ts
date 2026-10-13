import { app, session, shell, systemPreferences, type WebContents } from 'electron';
import type { Logger } from './logger';
import { isAllowedAppUrl, isSafeExternalUrl, safeScheme, type AppOrigin } from './url-policy';

/**
 * The production CSP is injected into index.html at build time (see
 * electron.vite.config.ts); this header covers the dev server, where Vite's
 * React refresh needs an inline preamble and a websocket.
 */
export const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: meshtalk-file:",
  "media-src 'self' blob: meshtalk-file:",
  "connect-src 'self' ws://localhost:* http://localhost:* meshtalk-file:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

export function applySessionHardening(logger: Logger, origin: AppOrigin): void {
  const ses = session.defaultSession;

  // Only camera/microphone are ever granted, only to our own renderer, and only
  // when the OS allows it. The renderer requests them solely from explicit user
  // actions (Record, Call, Answer). Everything else (notifications are shown by
  // main, geolocation, clipboard reads, MIDI, …) is denied.
  // Checked against the page URL: for file:// pages the reported origin is just
  // "file://", which says nothing about which file is asking.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== 'media' || !isAllowedAppUrl(wc.getURL(), origin)) {
      logger.info('security.permission_denied', { permission });
      callback(false);
      return;
    }
    const types = ('mediaTypes' in details ? details.mediaTypes : undefined) ?? [];
    void osMediaAccess(types).then((granted) => {
      logger.info(granted ? 'security.media_granted' : 'security.media_denied_by_os', { types });
      callback(granted);
    });
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    return permission === 'media' && wc !== null && isAllowedAppUrl(wc.getURL(), origin);
  });

  if (origin.kind === 'dev') {
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [DEV_CSP] },
      });
    });
  }
}

export function hardenWebContents(contents: WebContents, logger: Logger, origin: AppOrigin): void {
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedAppUrl(url, origin)) {
      event.preventDefault();
      logger.warn('security.navigation_blocked', { scheme: safeScheme(url) });
    }
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

export function installGlobalHardening(logger: Logger, origin: AppOrigin): void {
  app.enableSandbox();
  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents, logger, origin));
}

/** macOS keeps its own per-app camera/microphone consent; ask it explicitly. */
async function osMediaAccess(types: readonly string[]): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  for (const type of types) {
    const kind = type === 'video' ? 'camera' : type === 'audio' ? 'microphone' : null;
    if (!kind) continue;
    if (systemPreferences.getMediaAccessStatus(kind) === 'granted') continue;
    if (!(await systemPreferences.askForMediaAccess(kind))) return false;
  }
  return true;
}
