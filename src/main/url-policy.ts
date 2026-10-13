// Pure URL checks used by the Electron hardening in ./security.ts.

/** Where the renderer is served from: the Vite dev server, or the built files. */
export type AppOrigin = { kind: 'dev'; url: string } | { kind: 'file'; rendererDirUrl: string };

/**
 * True only for URLs belonging to our own renderer. In production that means
 * `file:` URLs inside the renderer build directory; any other local file is rejected.
 */
export function isAllowedAppUrl(url: string, origin: AppOrigin): boolean {
  try {
    const parsed = new URL(url);
    if (origin.kind === 'dev') return parsed.origin === new URL(origin.url).origin;
    const root = origin.rendererDirUrl.endsWith('/')
      ? origin.rendererDirUrl
      : `${origin.rendererDirUrl}/`;
    return parsed.protocol === 'file:' && parsed.href.startsWith(root);
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function safeScheme(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return 'invalid';
  }
}
