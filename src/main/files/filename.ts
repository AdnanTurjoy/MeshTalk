import { extname } from 'node:path';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_NAME_BYTES = 200;

/**
 * Turns a name chosen by a remote peer into a safe single path component:
 * no directories, no traversal, no reserved or control characters, no
 * Windows device names, bounded length, extension preserved where possible.
 */
export function sanitizeFilename(input: string): string {
  // Only the last path component counts, whatever separator the sender used.
  let name = input.split(/[\\/]/).pop() ?? '';
  name = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*‪-‮⁦-⁩]/g, '_')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  if (name === '' || name === '.' || name === '..') name = 'file';
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  return truncateBytes(name, MAX_NAME_BYTES);
}

function truncateBytes(name: string, max: number): string {
  if (Buffer.byteLength(name) <= max) return name;
  const ext = extname(name).slice(0, 16);
  let base = name.slice(0, name.length - ext.length);
  while (Buffer.byteLength(base + ext) > max) base = [...base].slice(0, -1).join('');
  return base + ext;
}

/** Extensions that run code when opened. MeshTalk never opens these for the user. */
const EXECUTABLE = new Set([
  'app',
  'appimage',
  'apk',
  'bat',
  'bin',
  'cmd',
  'com',
  'command',
  'cpl',
  'deb',
  'desktop',
  'dll',
  'dmg',
  'exe',
  'gadget',
  'hta',
  'inf',
  'ins',
  'jar',
  'js',
  'jse',
  'ksh',
  'lnk',
  'mjs',
  'msc',
  'msi',
  'msp',
  'pif',
  'pkg',
  'ps1',
  'psm1',
  'py',
  'reg',
  'rpm',
  'run',
  'scr',
  'sct',
  'sh',
  'shb',
  'so',
  'terminal',
  'url',
  'vb',
  'vbe',
  'vbs',
  'workflow',
  'ws',
  'wsf',
  'wsh',
  'xll',
]);

export function isExecutableName(name: string): boolean {
  return EXECUTABLE.has(extname(name).slice(1).toLowerCase());
}

/** Raster formats Chromium decodes safely for inline previews (no SVG: it can carry script). */
const PREVIEW_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
};

/** The MIME type MeshTalk itself assigns for preview, ignoring what the sender claimed. */
export function previewMime(name: string): string | null {
  return PREVIEW_MIME[extname(name).slice(1).toLowerCase()] ?? null;
}
