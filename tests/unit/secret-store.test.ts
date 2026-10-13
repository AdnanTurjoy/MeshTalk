import { describe, expect, it } from 'vitest';
import { safeStorageSecretStore, type SafeStorageLike } from '../../src/main/secrets/secret-store';

const fake: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
};

describe('safeStorageSecretStore', () => {
  it('reports the macOS keychain as secure', () => {
    expect(safeStorageSecretStore(fake, 'darwin')).toMatchObject({
      backend: 'keychain',
      secure: true,
    });
  });
  it('never reports the mock keychain as secure', () => {
    expect(safeStorageSecretStore(fake, 'darwin', true)).toMatchObject({
      backend: 'mock-keychain',
      secure: false,
    });
  });
  it('flags Linux without a keyring as insecure', () => {
    const linux = { ...fake, getSelectedStorageBackend: () => 'basic_text' };
    expect(safeStorageSecretStore(linux, 'linux').secure).toBe(false);
  });
});
