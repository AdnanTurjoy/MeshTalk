import { describe, expect, it } from 'vitest';
import { parseRange } from '../../src/main/files/file-protocol';
import { isExecutableName, previewMime, sanitizeFilename } from '../../src/main/files/filename';

describe('sanitizeFilename', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\Windows\\system32\\evil.dll', 'evil.dll'],
    ['/abs/path/x.txt', 'x.txt'],
    ['CON', '_CON'],
    ['lpt1.txt', '_lpt1.txt'],
    ['a<b>c:d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['tab\tnew\nline.txt', 'tab_new_line.txt'],
    ['..', 'file'],
    ['   ', 'file'],
    ['.hidden', 'hidden'],
    ['trailing. . .', 'trailing'],
    ['evil‮txt.exe', 'evil_txt.exe'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('bounds the length but keeps the extension', () => {
    const out = sanitizeFilename(`${'x'.repeat(500)}.tar.gz`);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(200);
    expect(out.endsWith('.gz')).toBe(true);
  });

  it('does not split multi-byte characters', () => {
    const out = sanitizeFilename(`${'é'.repeat(300)}.txt`);
    expect(out).not.toContain('�');
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(200);
  });
});

describe('file classification', () => {
  it('flags executables case-insensitively', () => {
    for (const n of ['setup.EXE', 'run.sh', 'x.AppImage', 'a.ps1', 'b.command'])
      expect(isExecutableName(n)).toBe(true);
    for (const n of ['a.pdf', 'b.png', 'notes.txt', 'archive.zip'])
      expect(isExecutableName(n)).toBe(false);
  });

  it('only previews safe raster/audio/video formats', () => {
    expect(previewMime('photo.JPG')).toBe('image/jpeg');
    expect(previewMime('clip.webm')).toBe('video/webm');
    expect(previewMime('vector.svg')).toBeNull();
    expect(previewMime('page.html')).toBeNull();
  });
});

describe('parseRange', () => {
  it.each([
    [null, 100, null],
    ['bytes=0-9', 100, [0, 9]],
    ['bytes=90-', 100, [90, 99]],
    ['bytes=-10', 100, [90, 99]],
    ['bytes=50-500', 100, [50, 99]],
    ['bytes=100-', 100, 'invalid'],
    ['bytes=5-1', 100, 'invalid'],
    ['bytes=-', 100, 'invalid'],
    ['items=0-1', 100, 'invalid'],
  ])('%j of %d → %j', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});
