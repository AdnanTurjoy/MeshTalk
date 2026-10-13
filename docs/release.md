# Building and releasing MeshTalk

## Reproducible builds

```bash
git clean -xdf          # optional: start from a clean tree
npm ci                  # exact versions from package-lock.json
npm run check
npm run test:e2e
npm run dist:<mac|win|linux>
```

Artifacts are written to `dist/`. Nothing is compiled during packaging:
better-sqlite3 ships N-API (ABI-stable) binaries for macOS, Windows and Linux
(x64/arm64), so `npmRebuild` is off and a Mac can build the DMGs, the Windows
installer and the AppImages. The `.deb` needs GNU tar and xz and is built on
Linux (the `Release` GitHub workflow builds everything when a `v*` tag is pushed).

| Platform | Targets                                         | Architectures |
| -------- | ----------------------------------------------- | ------------- |
| macOS    | DMG                                             | arm64, x64    |
| Windows  | NSIS installer (per-user, directory selectable) | x64, arm64    |
| Linux    | AppImage, deb                                   | x64, arm64    |

## Code signing

Without signing, macOS Gatekeeper and Windows SmartScreen show warnings. The
release workflow reads these optional repository secrets:

| Secret                                                     | Platform        | Purpose                                         |
| ---------------------------------------------------------- | --------------- | ----------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | macOS / Windows | Base64-encoded `.p12` / `.pfx` and its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS           | Notarization through `notarytool`               |

**macOS:** use a "Developer ID Application" certificate. The app is built with
the hardened runtime and the entitlements in `build/entitlements.mac.plist`
(JIT, camera, microphone, network client and server). electron-builder
notarizes automatically when the Apple variables are set.

**Windows:** a standard OV code-signing certificate works but builds
SmartScreen reputation slowly. EV or Azure Trusted Signing establishes
reputation immediately.

**Linux:** AppImage and deb are unsigned by convention. Publish SHA-256 sums
next to them.

Never commit certificates or passwords. `.gitignore` excludes `.env*`.

## Auto-update

Not enabled. It is planned as an opt-in in M8 (electron-updater with a
self-hosted feed), disabled by default and with no background network calls
until the user enables it.

## Release hardening

`npm run dist:*` and the Release workflow use `electron-builder.release.yml`,
which turns on Electron fuses: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no
`--inspect`, cookie encryption, and asar integrity validation. The ad-hoc
signature is reset on Apple Silicon so unsigned local builds still start. This
was verified on macOS arm64: the fused build starts, migrates and listens, and
refuses to run as Node.

`npm run dist:dir` builds **without** fuses so the E2E suite can drive a
packaged app (`MESHTALK_E2E_EXECUTABLE`).

Still to do: app icons for all platforms.
