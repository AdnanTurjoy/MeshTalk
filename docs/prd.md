# MeshTalk — Product Requirements (concise)

## Problem

People on the same office, lab, or home network often route every chat
message, file, and call through a distant cloud service. That costs speed,
privacy, and the ability to work when the internet is down.

## Users

- Small teams and labs that share a LAN and want fast, private file exchange
  and calls.
- Organizations that self-host and want identity control without giving up
  message content (Mode C).
- Nontechnical users. Discovery, trust, and transfers must explain themselves.

## Core requirements

1. **LAN-first.** When two devices can reach each other directly, messages,
   files, and calls go device to device.
2. **Local ownership.** Each install keeps its own SQLite DB and file store. No
   server stores message bodies or files by default.
3. **Honest identity.** LAN-only accounts are labeled "unverified". Verified
   email requires an account server (Mode B/C).
4. **Explicit trust.** Discovering a device grants no access. Users accept
   contacts and can verify fingerprints.
5. **Consent for sensors and files.** The camera and microphone turn on only
   after the user acts. Incoming files require acceptance and are never opened
   automatically.
6. **Explained failure.** When a connection fails, the user sees which layer
   failed (multicast, TCP, TLS identity, firewall) and what to try.

## Success criteria (v1)

- Two devices on a home router discover each other, connect, exchange messages,
  transfer a 4 GB file with resume, and hold a video call, without internet.
- Restarting either app loses nothing that was committed.
- Every claim in `docs/roadmap.md` under "Implemented" is backed by a test.

## Out of scope for v1

Mobile clients, web client, SFU group calls with more than 4 people, cloud
backup.
