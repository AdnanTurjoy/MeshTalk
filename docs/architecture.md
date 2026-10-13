# MeshTalk — System Architecture

Status: living document. Last revised for Milestone 8 (LAN-only build).

## 1. Goals and non-goals

MeshTalk is a desktop communication app that prefers **direct device-to-device
communication on the local network** and keeps user data **on the user's
devices**. A server is optional and, when present, handles identity and
connection setup only. It never stores message bodies or files by default.

Non-goals for v1:

- A hosted, always-on cloud service.
- Large group calls without an SFU.
- Browser or mobile clients.

## 2. Process model

```
┌──────────────────────────── Electron app (one per device/profile) ────────────────────────────┐
│                                                                                                │
│  Renderer (React, sandboxed)          Preload (contextBridge)        Main process (Node)       │
│  ─────────────────────────            ───────────────────────        ───────────────────────   │
│  UI, view state, WebRTC media   ◄──►  window.meshtalk:          ◄──►  IPC router (zod, sender   │
│  (getUserMedia, RTCPeerConnection)    invoke (allowlisted),          check, app-lock gate)      │
│  No Node, no DB, no fs                sendFile (real Files only),    AppServices:               │
│                                       onEvent                        ├─ Identity (keychain)     │
│                                                                      ├─ PeerService (mTLS)      │
│                                                                      ├─ Discovery (mDNS)        │
│                                                                      ├─ Contacts                │
│                                                                      ├─ Chat (+ outbox)         │
│                                                                      ├─ Transfers (+ protocol   │
│                                                                      │   meshtalk-file://)      │
│                                                                      ├─ Calls (signalling)      │
│                                                                      ├─ Groups                  │
│                                                                      ├─ Skills                  │
│                                                                      ├─ AppLock, Backups        │
│                                                                      └─ SQLite, Logger          │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
                       │  LAN: mDNS announce + mutual-TLS PeerLink (TCP); WebRTC media (UDP)
                       ▼
               other MeshTalk devices
                       │  Not built yet (Mode B/C)
                       ▼
       Account/Signaling server (Spring Boot)  ·  STUN  ·  TURN (optional)
```

Rules that follow from this:

- **The renderer never touches Node, SQLite or the filesystem.** Everything goes
  through `window.meshtalk`, whose every call is validated in main
  (`src/main/ipc/router.ts`).
- **Networking (discovery, peer links, file streaming) lives in the main
  process**, which can open sockets, stream to disk without loading whole files
  into memory, and survive renderer reloads.
- **WebRTC media lives in the renderer**, where Chromium exposes
  `getUserMedia` and `RTCPeerConnection`. Signalling travels over the
  main-process PeerLink.

## 3. Repository structure

```
src/
  shared/              Types and zod schemas shared by every layer (IPC contract, events)
  main/
    index.ts           Lifecycle, window, protocol, menu, notifications, idle lock
    app-services.ts    Composition root: builds and wires every service
    security.ts        CSP (dev), permission handler, navigation/window guards
    url-policy.ts      Which URLs belong to the app / may open externally
    ipc/               Router (validation, sender check, lock gate) and routes
    db/                SQLite connection, Drizzle schema, migrations, integrity check
    identity/          Device certificate, device ID, local account
    secrets/           safeStorage-backed secret store
    peer/              Frames, wire vocabulary, PeerConnection, PeerService
    discovery/         mDNS discovery behind a driver interface
    services/          Settings, contacts
    chat/              Conversations, messages, outbox, search, HLC/UUIDv7
    files/             Transfers, filename safety, meshtalk-file:// protocol
    calls/             Call signalling and history
    groups/            Group membership snapshots and permissions
    skills/            Skill sharing, requests, bookmarks
    data/              App lock, backup/restore/export/wipe
    platform/          Paths, profiles, network-change watcher
  preload/             contextBridge (forwarding + channel allowlist only)
  renderer/src/        React UI: components (design system), screens, chat, calls,
                       files, groups, media, security
tests/
  unit/                Pure logic (Node)
  integration/         Real SQLite + real TLS between in-process "devices" (Electron's Node)
  e2e/                 Playwright driving 1–3 real app instances
docs/                  Architecture, ADRs, threat model, schema, roadmap, guides, testing
```

There is no `server/` yet (see roadmap).

## 4. Network operating modes

| Capability                                   | A: LAN-only (built)          | B: LAN-first + account server (planned) | C: Self-hosted org (planned)   |
| -------------------------------------------- | ---------------------------- | --------------------------------------- | ------------------------------ |
| Local discovery (mDNS)                       | ✅                           | ✅                                      | ✅ (can be disabled by policy) |
| Direct LAN messaging/files/calls             | ✅                           | ✅                                      | ✅                             |
| Verified email identity                      | ❌ (email-shaped label only) | ✅                                      | ✅ (org IdP / SMTP)            |
| Global uniqueness of email                   | ❌                           | ✅ (server-enforced)                    | ✅ within the org              |
| Password reset                               | ❌ (local app lock only)     | ✅                                      | ✅                             |
| Cross-network connectivity                   | ❌                           | ✅ via signalling + STUN/TURN           | ✅                             |
| Offline delivery while the sender is offline | ❌                           | Only with an opt-in E2E relay           | Only with an opt-in E2E relay  |
| Admin controls / audit log                   | ❌                           | ❌                                      | ✅ (metadata only)             |

**Identity in LAN-only mode.** A local account is a device keypair plus a
display name and an optional email-shaped _label_. Nobody has checked that the
person owns that address, and two people can pick the same one. Trust between
devices comes from **key fingerprints**, compared in person, not from the
email. The UI calls the email "unverified" wherever it appears.

**Identity in Mode B/C (planned).** The server verifies email ownership with a
single-use, time-limited token, then signs a binding
`account_id ↔ normalized_email ↔ device_public_key` that peers check when they
connect. That proves the email belongs to the account. It proves nothing about
the person's real-world identity.

## 5. Network communication design

### 5.1 Device identity

- Each install generates an **ECDSA P-256 key** and a self-signed X.509
  certificate (`@peculiar/x509` over Node's WebCrypto). P-256 was chosen over
  Ed25519 for the broadest TLS 1.3 support across Node/OpenSSL builds.
- **Device ID** = base32 SHA-256 of the certificate DER (52 characters), shown
  in groups of four (the same scheme Syncthing uses). The private key is
  encrypted with Electron `safeStorage` and never regenerated silently.

### 5.2 Discovery (mDNS/DNS-SD)

- Service `_meshtalk._tcp`. TXT records carry **only** protocol version and
  device ID. The port is in the SRV record. No name, email or avatar.
- Off until the user consents (onboarding or Settings).
- An announcement is a _hint_. Connecting to it requires the certificate hash
  to equal the announced ID, so a spoofed announcement fails the TLS check.
- Fallback when multicast is blocked: add by `host:port`, plus a layered
  connection test. QR pairing and server device codes are planned.

### 5.3 PeerLink (direct LAN transport)

- **TLS 1.3 over TCP with mutual certificate authentication** (Node `tls`, in
  main). Default port 47820, or any free port if that is taken.
- Frames: `[u32 length][u8 kind][payload]`. Kind 1 is JSON (≤ 256 KiB). Kind 2
  is binary with a JSON header (file chunks, ≤ 2 MiB). The length is checked
  before buffering. Every JSON message is validated against one zod schema
  (`src/main/peer/wire.ts`). Anything malformed closes the link.
- First message on both sides: `hello` (protocol version, listening port).
- Untrusted devices may only send hello and contact messages. Contacts, and
  for group traffic fellow group members, may send everything else. Blocked
  devices are dropped at connect.
- Simultaneous connections: both sides keep the link opened by the lower device
  ID.
- Liveness: ping every 15 s, close after 45 s of silence. Reconnects to wanted
  devices use jittered backoff (1 s → 60 s) and restart on network change and
  resume.

### 5.4 Messaging

- **Outbox.** Every durable change (message, edit, delete, reaction, read
  receipt, group snapshot, skill request) is an event stored per recipient in
  `outbox` and sent while that recipient is connected. It is retried on every
  reconnect until the recipient acknowledges it (`ev_ack`). Up to 200 events
  per peer are in flight at once.
- **Idempotent apply.** Messages have UUIDv7 IDs and are inserted once.
  Edits/deletes are accepted only from the original sender and only if newer.
  Duplicate deliveries are acknowledged and ignored.
- **If the recipient is offline, events wait in the sender's outbox.** Delivery
  happens only when both devices are online and reachable at the same time.
  Nothing is stored anywhere else.
- **Ordering**: hybrid logical clock timestamps (never behind any timestamp
  seen from a peer, bounded against wild clocks), ties broken by ID.
- **Delete for everyone** replaces the message with a tombstone on each device
  that receives the event. A device can't be forced to forget what it already
  showed, so the UI only promises removal from their copy of the app.

### 5.5 File transfer

- Bytes go over PeerLink (binary frames), not WebRTC data channels, so main can
  stream straight to disk with TCP backpressure (ADR-0003).
- The offer travels inside a chat message (name, size, SHA-256). The receiver
  accepts explicitly (voice notes ≤ 10 MB are auto-accepted), then pulls with
  `file_req {offset}`.
- 512 KiB chunks, each with its own SHA-256, written sequentially to
  `files/partial/<id>.part`. At the end, the whole-file hash is checked and the
  file is atomically renamed to `files/received/<id>/<sanitized name>`.
- Resume: from the `.part` file's length; the running hash is rebuilt from
  disk.
- Safety: receiver-side sanitized names; every path is resolved inside the
  managed folder; size limit, free-space check and optional quota apply;
  executables are never opened; MIME type comes from the receiver's own
  extension map; previews only for raster images, audio and video.

### 5.6 Calls

- WebRTC in the renderer. SDP/ICE travel over PeerLink (`call_invite`,
  `call_signal`, `call_end`). The caller holds its ICE candidates until the
  invite is out. Media is DTLS-SRTP.
- No STUN/TURN in Mode A: host candidates on the LAN. The UI would show
  "Relayed" if a TURN path were ever used.
- One-to-one only. ICE restart (caller-driven, at most 3 attempts) on
  disconnect. Busy, decline and a 45 s ring timeout are handled in main, which
  also records history.

### 5.7 Groups

See ADR-0005. Membership is a versioned snapshot sent by owners and admins
through the outbox. Messages fan out from the author directly to each member.
Co-membership allows group traffic between devices that aren't contacts, but
never direct messages or calls.

## 6. Local data

- SQLite (WAL, `foreign_keys=ON`) at `<userData>/data/meshtalk.db`. File bytes
  live under `<userData>/files/`, never inside SQLite rows.
- `<userData>` is Electron's per-OS app-data folder (`--profile=<name>`,
  `MESHTALK_PROFILE` and `MESHTALK_DATA_DIR` select another one):
  - macOS: `~/Library/Application Support/MeshTalk`
  - Windows: `%APPDATA%\MeshTalk`
  - Linux: `$XDG_CONFIG_HOME/MeshTalk`
- Migrations are versioned, checksummed, and run in transactions at startup.
- Backups, restore, export and wipe: see `backup-restore.md` and ADR-0006.
- **Local persistence does not keep devices in sync.** Two devices have the
  same history only for events that were actually delivered between them.

## 7. Cross-platform strategy

OS differences live behind adapters in `src/main/platform/` (paths now;
notifications, firewall diagnostics and media permission prompts later). The
rest of the code does not check `process.platform` directly. Media and
permission support is checked with feature detection at runtime.

Packaging uses electron-builder: DMG (arm64 and x64), NSIS (x64 and arm64),
AppImage and deb (x64 and arm64). See `docs/release.md`.
