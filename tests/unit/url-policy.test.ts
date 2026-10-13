import { describe, expect, it } from 'vitest';
import { isAllowedAppUrl, isSafeExternalUrl, type AppOrigin } from '../../src/main/url-policy';

const fileOrigin: AppOrigin = {
  kind: 'file',
  rendererDirUrl: 'file:///Applications/MeshTalk.app/Contents/Resources/app.asar/out/renderer',
};
const devOrigin: AppOrigin = { kind: 'dev', url: 'http://localhost:5173' };

describe('isAllowedAppUrl', () => {
  it('allows files inside the renderer directory', () => {
    expect(
      isAllowedAppUrl(
        'file:///Applications/MeshTalk.app/Contents/Resources/app.asar/out/renderer/index.html',
        fileOrigin,
      ),
    ).toBe(true);
  });

  it.each([
    'file:///etc/passwd',
    'file:///Applications/MeshTalk.app/Contents/Resources/app.asar/out/renderer-evil/index.html',
    'https://example.com/',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s in production', (url) => {
    expect(isAllowedAppUrl(url, fileOrigin)).toBe(false);
  });

  it('only allows the dev server origin in development', () => {
    expect(isAllowedAppUrl('http://localhost:5173/', devOrigin)).toBe(true);
    expect(isAllowedAppUrl('http://localhost:5174/', devOrigin)).toBe(false);
    expect(isAllowedAppUrl('file:///etc/passwd', devOrigin)).toBe(false);
  });
});

describe('isSafeExternalUrl', () => {
  it('allows https only', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('smb://host/share')).toBe(false);
  });
});
