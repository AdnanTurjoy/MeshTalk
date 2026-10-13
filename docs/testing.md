# Testing MeshTalk

## Layers

| Layer       | Command                    | Runs in                                  | What it proves                                                                                                                                                            |
| ----------- | -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `npm run test:unit`        | Node                                     | Pure logic: validation, framing, sanitisation, URL policy, IPC router, formatting                                                                                         |
| Integration | `npm run test:integration` | Electron's Node (`ELECTRON_RUN_AS_NODE`) | Real SQLite and real TLS sockets on `127.0.0.1`. Two to four complete "devices" (identity, PeerLink, contacts, chat, files, calls, groups, skills) exchange real traffic. |
| E2E         | `npm run test:e2e`         | Playwright driving the built app         | The full app: UI → IPC → main → network → another app instance                                                                                                            |

Opt-in tests:

- `MESHTALK_REAL_MDNS=1`: real multicast discovery on this machine (often blocked on CI runners).
- `MESHTALK_PERF=1`: 512 MB transfer throughput.
- `CI=1` (or running in CI): call and voice tests on macOS, which use Chromium's fake camera and microphone. They're skipped locally to avoid macOS permission prompts.
- `MESHTALK_E2E_EXECUTABLE=<path>`: run the E2E suite against a packaged build. This doesn't work with the fused release build, by design, because it disables the inspector Playwright needs.

## What the tests do **not** prove

- **Real networks.** Every multi-device test runs on one machine over
  loopback. Client isolation, VLANs, Wi-Fi loss, firewall prompts and
  multicast filtering only show up on real networks.
- **Real media.** Calls and voice messages use synthetic devices. Echo
  cancellation, device hot-plugging, Bluetooth headsets and OS permission
  prompts need manual testing.
- **Other platforms.** Everything has only been verified on macOS arm64 so
  far. The CI matrix covers Windows and Linux once the repository is pushed.

## Manual test matrix (before a release)

Run on two physical machines per row, on the same Wi-Fi unless noted.

| Scenario                                                            | macOS ↔ Windows | Windows ↔ Linux | macOS ↔ Linux |
| ------------------------------------------------------------------- | --------------- | --------------- | ------------- |
| Discovery on, see each other within 10 s                            |                 |                 |               |
| Add by address with discovery off                                   |                 |                 |               |
| First-run OS firewall / Local Network prompt handled                |                 |                 |               |
| Message while the other is asleep → delivered on wake               |                 |                 |               |
| 4 GB transfer, pull the Wi-Fi mid-way, resume                       |                 |                 |               |
| Video call 10 min, switch camera and headset mid-call               |                 |                 |               |
| Video call across 2.4 GHz ↔ 5 GHz bands of one router               |                 |                 |               |
| Guest Wi-Fi with client isolation → clear error in Network test     |                 |                 |               |
| Voice message record/play with a Bluetooth headset                  |                 |                 |               |
| Backup on A, restore on a new user account on B with the passphrase |                 |                 |               |
| App lock engages after idle and on OS lock                          |                 |                 |               |

Record the result and app version in each cell.
