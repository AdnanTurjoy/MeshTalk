# MeshTalk — Threat Model

Method: STRIDE per trust boundary. Revised for the Milestone 8 build (LAN-only, Mode A).

## Assets

1. Message contents and attachments.
2. Device identity private key; app-lock PIN.
3. Social graph: contacts, group membership, presence.
4. Account credentials (Mode B/C, not built yet).
5. Integrity of the local machine (received files, renderer → OS escape).

## Trust boundaries

| #   | Boundary                          | Notes                                                                                                           |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| B1  | Renderer ↔ main (IPC)             | The renderer renders attacker-influenced content (messages, filenames, profiles), so treat it as compromisable. |
| B2  | Device ↔ LAN                      | Hostile: any host can send mDNS, connect to the port, or sniff traffic.                                         |
| B3  | Device ↔ account/signaling server | Not built. Designed as semi-trusted (ADR-0004).                                                                 |
| B4  | Device ↔ TURN relay               | Not built. Would see only DTLS-SRTP ciphertext.                                                                 |
| B5  | App ↔ local disk                  | Other local users, malware, stolen devices, backups copied elsewhere.                                           |

## Threats and mitigations

| Threat (STRIDE)                                          | Boundary | Mitigation                                                                                                                                                                                                                                                                                                    | Status                 |
| -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Renderer XSS escalates to Node/RCE (E)                   | B1       | `contextIsolation`, `sandbox`, no `nodeIntegration`, CSP without inline script, no `dangerouslySetInnerHTML` (lint-enforced), narrow preload (`invoke` limited to a channel allowlist, `sendFile`, `onEvent`), zod validation of every payload, sender-frame check, navigation/`window.open`/webviews blocked | ✅ tested              |
| Compromised renderer exfiltrates arbitrary files (I)     | B1       | File paths reach main only from genuine `File` objects through the preload (`webUtils.getPathForFile`); the generic `invoke` can't reach `files:send-path`                                                                                                                                                    | ✅ by construction     |
| Renderer reads the DB/files directly (I)                 | B1       | No fs/DB API. Previews are served by ID through `meshtalk-file://` only for complete, previewable files, with `nosniff` and a `default-src 'none'` CSP                                                                                                                                                        | ✅                     |
| Spoofed mDNS announcement (S)                            | B2       | Announcements are hints. A connection to a discovered device must present a certificate whose SHA-256 matches the announced ID.                                                                                                                                                                               | ✅ tested              |
| MITM on first contact (S/T)                              | B2       | TOFU on the certificate hash. Fingerprints shown on both sides for comparison and a "verified" mark. Same-name impersonation warning.                                                                                                                                                                         | ✅                     |
| Eavesdropping (I)                                        | B2       | TLS 1.3 mutual auth on PeerLink; DTLS-SRTP for media                                                                                                                                                                                                                                                          | ✅                     |
| Replay / duplication (T)                                 | B2       | TLS within a session. Events carry IDs and are applied idempotently. Edits/deletes are accepted only from the original sender.                                                                                                                                                                                | ✅ tested              |
| Forged group changes (S/E)                               | B2       | Snapshots accepted only from admins in the receiver's view, with a higher version. Posting checked against role and policy.                                                                                                                                                                                   | ✅ tested              |
| Unsolicited connections, request spam (D)                | B2       | Untrusted peers may only send hello/contact messages; anything else closes the link. Per-IP rate limit, cap on concurrent untrusted links, decline cool-down, blocking.                                                                                                                                       | ✅                     |
| Malformed or oversized frames (D)                        | B2       | Length cap checked before buffering; JSON cap; schema validation                                                                                                                                                                                                                                              | ✅ tested              |
| Malicious file: traversal, overwrite, device names (T/E) | B2→B5    | Receiver-side sanitized basename, writes confined to the managed folder (resolved-path check), `.part` + atomic rename, never opened automatically; executables can't be opened from MeshTalk                                                                                                                 | ✅ tested              |
| Tampered or corrupted file (T)                           | B2       | Per-chunk SHA-256 plus whole-file SHA-256 from the offer; mismatch discards the file                                                                                                                                                                                                                          | ✅ tested              |
| Disk exhaustion (D)                                      | B2→B5    | Size cap, free-space check, optional quota                                                                                                                                                                                                                                                                    | ✅                     |
| Camera/mic activated silently (I)                        | OS       | Media permission granted only to the app's own page, only with OS consent (macOS prompt), requested only from user actions; recording/calling UI is always visible                                                                                                                                            | ✅                     |
| Shoulder-surfing / unattended computer (I)               | B5       | Optional app lock enforced in main; notifications hide names while locked                                                                                                                                                                                                                                     | ✅ tested              |
| Key theft from disk (I)                                  | B5       | Device key encrypted with the OS keychain; warning when only plaintext storage exists (Linux without a keyring)                                                                                                                                                                                               | ✅                     |
| Stolen laptop / DB copy (I)                              | B5       | **Not mitigated by MeshTalk**: the DB and files are plaintext; relies on OS disk encryption                                                                                                                                                                                                                   | ⚠️ planned (SQLCipher) |
| Backup leaks (I)                                         | B5       | Backups are plaintext (the UI warns); the device key is included only wrapped with a passphrase (scrypt + AES-256-GCM)                                                                                                                                                                                        | ⚠️ partial             |
| Local attacker abuses Electron debug paths (E)           | B5       | Release builds disable `RunAsNode`, `NODE_OPTIONS`, `--inspect`, and enable asar integrity validation (fuses)                                                                                                                                                                                                 | ✅ release builds      |
| Logs leak secrets (I)                                    | all      | Structured logger redacts token/password/key/body/content fields; message bodies never logged                                                                                                                                                                                                                 | ✅ tested              |
| Credential stuffing (S)                                  | B3       | Argon2id + rate limits on the server                                                                                                                                                                                                                                                                          | ❌ server not built    |

## End-to-end encryption: what holds and what does not

- **Direct device links**: end to end between the two devices (TLS 1.3, pinned
  certificates, forward secrecy per session). Nothing else is in the path.
- **Groups**: each message travels directly from its author to each member over
  that pair's link. No member or server relays it.
- **Calls**: DTLS-SRTP between the two devices.
- **Not available**, so not exposed: store-and-forward relay, multi-device
  sync, server-mediated groups. A relay must use a standard, audited protocol
  (MLS, Signal protocol, or similar). That decision is still open.
- **At rest**: the database, received files and backups are not encrypted by
  MeshTalk.
- **Account recovery**: there are no accounts in Mode A. Losing the device and
  its backup means losing that identity.

## Telemetry

None. No crash reporting endpoint. Logs stay in `<userData>/logs`.
