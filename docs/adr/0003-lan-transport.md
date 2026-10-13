# ADR-0003: Mutual-TLS PeerLink for LAN data; WebRTC for media only

Status: Accepted (design), implementation in M2–M4

## Context

WebRTC data channels need a signaling channel anyway. They run in the renderer,
so file bytes would cross IPC, and backpressure for multi-GB files is awkward.
On a LAN, two devices can usually open a plain TCP connection to each other.

## Decision

- **PeerLink** is TLS 1.3 over TCP from the main process, with **mutual
  authentication using self-signed device certificates**. The device ID is the
  SHA-256 of the certificate, pinned on first trust and verifiable by
  fingerprint or QR code. This is the model Syncthing has used in production.
- Messages, sync, file chunks and **WebRTC signaling for calls** all travel over
  PeerLink.
- **WebRTC** (renderer) carries audio and video only.
- When PeerLink can't be established (client isolation, firewall), MeshTalk
  reports the specific failure (multicast not seen, TCP refused, TCP timeout,
  TLS fingerprint mismatch). In Mode B/C it then falls back to signaling through
  the server and WebRTC data channels with STUN, and TURN if configured. It
  **never** uploads files to a third party.

## Consequences

- We need one listening TCP port. The OS firewall may prompt the first time
  (Windows Defender, macOS application firewall). This is covered in the LAN
  troubleshooting guide.
- Cross-network file transfer (via WebRTC data channels) is a second code path
  and will be built after the LAN path is proven.
