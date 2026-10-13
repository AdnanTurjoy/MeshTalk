# ADR-0001: Electron + React + TypeScript + electron-vite

Status: Accepted (M1)

## Context

We need one codebase for macOS, Windows and Linux, with first-class WebRTC,
camera and microphone access, and raw TCP/UDP sockets for LAN discovery and
peer links.

## Decision

- **Electron 44**: bundles Chromium (WebRTC, media devices) and Node (`net`,
  `tls`, `dgram`, fs streaming).
- **React 19 + TypeScript (strict, `noUncheckedIndexedAccess`)** for the UI.
- **electron-vite** to build main, preload and renderer with one Vite-based
  toolchain and HMR in development.
- **zod** for runtime validation of every IPC payload and every stored setting.
- **electron-builder** for DMG, NSIS, AppImage and deb packaging.

## Alternatives considered

- **Tauri**: smaller binaries, but WebRTC and media support depend on the
  platform webview (WebKitGTK on Linux is inconsistent for WebRTC), and LAN
  networking would have to be written in Rust. Rejected because cross-platform
  call reliability is a core requirement.
- **Plain Vite + tsc for main**: workable, but electron-vite already handles
  the three build targets and dev reloading.

## Consequences

- Bundles are about 100 MB per platform.
- Electron must be updated promptly to pick up Chromium security fixes.
- Native modules (better-sqlite3) must be rebuilt for Electron's ABI (ADR-0002).
