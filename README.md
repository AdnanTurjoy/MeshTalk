# MeshTalk

LAN-first, local-first desktop communication for macOS, Windows and Linux.
Chat, files, voice notes, calls, groups and skill sharing between devices on
the same network: directly, end-to-end encrypted in transit, with every byte
stored only on the devices involved.

> **Status.** The LAN-only product (Mode A) is implemented and tested on macOS
> arm64: identity, discovery, encrypted peer links, contacts, messaging, file
> transfer, voice messages, 1:1 calls, groups, skill sharing, backup/restore
> and app lock. The optional account/signalling server (Modes B/C) is **not
> built yet**, so there is no verified email, password reset or
> cross-network connectivity. Windows and Linux are configured but have not
> been run. See [docs/roadmap.md](docs/roadmap.md) for exactly what is done,
> partial, and planned.

## Documentation

| Document                                                   | What it covers                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| [docs/prd.md](docs/prd.md)                                 | Product requirements                                                    |
| [docs/architecture.md](docs/architecture.md)               | Processes, modes, protocols, repository layout                          |
| [docs/adr/](docs/adr/)                                     | Decisions: stack, storage, LAN transport, server, groups, local secrets |
| [docs/database-schema.md](docs/database-schema.md)         | Tables and migration rules                                              |
| [docs/threat-model.md](docs/threat-model.md)               | Threats, mitigations and what is **not** protected                      |
| [docs/roadmap.md](docs/roadmap.md)                         | Feature status, milestones, risks                                       |
| [docs/testing.md](docs/testing.md)                         | What the tests prove, what they don't, and the manual matrix            |
| [docs/lan-troubleshooting.md](docs/lan-troubleshooting.md) | Firewalls, client isolation, multicast                                  |
| [docs/backup-restore.md](docs/backup-restore.md)           | Backup, restore, export, deleting data                                  |
| [docs/release.md](docs/release.md)                         | Installers, signing, fuses                                              |

## Requirements

- Node.js 22.12+ (CI uses 24) and npm
- macOS 12+, Windows 10/11, or a modern Linux (Ubuntu 22.04+)
- Linux: a Secret Service keyring (GNOME Keyring/KWallet) to protect the device key

## Commands

```bash
npm install                          # deps + better-sqlite3 rebuilt for Electron
npm run dev                          # run with hot reload
npm run dev -- -- --profile=alice    # a second, isolated instance on the same machine

npm run check                        # format, lint, typecheck, unit + integration tests
npm run test:unit
npm run test:integration             # real SQLite + TLS, under Electron's Node
npm run test:e2e                     # builds, then drives 1–3 app instances with Playwright
CI=1 npm run test:e2e                # also runs call/voice tests on macOS (fake camera/mic)

npm run build                        # compile to out/
npm run dist:mac                     # DMG (arm64 + x64), with release fuses — on macOS
npm run dist:win                     # NSIS (x64 + arm64), with release fuses — on Windows
npm run dist:linux                   # AppImage + deb (x64 + arm64), with release fuses — on Linux
npm run dist:dir                     # unpacked, no fuses (for E2E against a package)
npm run dist:dir:release             # unpacked, with fuses (smoke-test a release build)
```

The macOS DMGs, the Windows installer and the Linux AppImages can all be built on a Mac
(the SQLite library ships ready-made binaries for every platform). The Linux `.deb` needs
GNU tar, so build it on Linux or let `.github/workflows/release.yml` do it.

### Trying two devices on one computer

```bash
npm run dev -- -- --profile=alice
npm run dev -- -- --profile=bob      # in another terminal
```

In Bob's **Network** screen, note the address and port. In Alice's **People**
screen, use **Add by address** with `127.0.0.1` and that port. Bob accepts the
request under People.

## Environment

All optional; see [.env.example](.env.example).

| Variable             | Purpose                                                    |
| -------------------- | ---------------------------------------------------------- |
| `MESHTALK_PROFILE`   | Same as `--profile=<name>`: isolated data directory        |
| `MESHTALK_DATA_DIR`  | Absolute data directory (takes precedence; used by tests)  |
| `MESHTALK_PEER_PORT` | PeerLink port (default 47820; falls back to any free port) |
| `MESHTALK_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`                     |

## Troubleshooting development

- **`NODE_MODULE_VERSION` mismatch**: run `npx electron-builder install-app-deps`.
  Integration tests must run through `npm run test:integration` (Electron's
  Node), not plain `vitest`.
- **Electron starts as plain Node / "bad option"**: your shell exported
  `ELECTRON_RUN_AS_NODE` (VS Code's terminal can). Run `unset ELECTRON_RUN_AS_NODE`.
