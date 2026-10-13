# ADR-0006: Local secrets: keychain, app lock, and backup key wrapping

Status: Accepted (M8)

## Decision

- **Device private key**: encrypted with Electron `safeStorage` (macOS
  Keychain, Windows DPAPI, libsecret/KWallet on Linux). On Linux without a
  keyring, MeshTalk detects the `basic_text` backend and warns. MeshTalk
  never regenerates a key it can't decrypt, because that would silently change
  the device's identity.
- **App lock**: scrypt (N=2^15, r=8, p=1) hash of the PIN/passphrase with a
  random salt, compared in constant time. Failed attempts back off
  exponentially after 5 tries. The lock is enforced in main: every IPC request
  except unlocking is refused. **It is not encryption**: data on disk is as
  protected as the user's OS account and disk encryption.
- **Backups**: folders containing a consistent SQLite snapshot (better-sqlite3
  online backup), the managed files, and a manifest. **Not encrypted.** The
  device key is included only if the user sets a passphrase. It is then wrapped
  with scrypt (N=2^17) and AES-256-GCM using Node's `crypto`, standard
  primitives in a standard construction. On restore, the key is re-protected
  with the new computer's keychain.
- **Restore** is staged and applied on the next start. The current data is
  moved aside, never deleted.

## Not chosen (yet)

- Encrypting the database and backups at rest (SQLCipher via
  `better-sqlite3-multiple-ciphers`). It needs key management that works
  with the keychain, recovery, and backups, which is planned.
