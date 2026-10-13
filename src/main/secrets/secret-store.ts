/**
 * Encrypts small secrets (device private key, later session tokens) at rest.
 * Backed by the OS keychain through Electron safeStorage where available.
 */
export interface SecretStore {
  readonly backend: string;
  /** False when secrets are only obfuscated or stored in plain text. */
  readonly secure: boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(data: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export function safeStorageSecretStore(
  safeStorage: SafeStorageLike,
  platform: string,
  /** Chromium's --use-mock-keychain: encryption with a fixed, public key (development only). */
  mockKeychain = false,
): SecretStore {
  if (mockKeychain) {
    return {
      backend: 'mock-keychain',
      secure: false,
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (data) => safeStorage.decryptString(data),
    };
  }
  const linuxBackend = platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() : undefined;
  if (!safeStorage.isEncryptionAvailable()) return plaintextSecretStore('unavailable');
  // On Linux without a keyring Chromium falls back to a hard-coded key.
  const secure =
    linuxBackend === undefined || (linuxBackend !== 'basic_text' && linuxBackend !== 'unknown');
  const backend =
    platform === 'darwin'
      ? 'keychain'
      : platform === 'win32'
        ? 'dpapi'
        : (linuxBackend ?? 'unknown');
  return {
    backend,
    secure,
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data),
  };
}

/** No protection beyond file permissions. Used in tests and as a last resort. */
export function plaintextSecretStore(backend = 'plaintext'): SecretStore {
  return {
    backend,
    secure: false,
    encrypt: (plain) => Buffer.from(plain, 'utf8'),
    decrypt: (data) => data.toString('utf8'),
  };
}
