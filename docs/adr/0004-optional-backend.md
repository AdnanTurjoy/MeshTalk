# ADR-0004: Optional Spring Boot account + signaling service

Status: Accepted (design), implementation from M2

## Decision

- `server/`: Spring Boot 3 (Java 21) with Spring Security, Argon2id
  (`Argon2PasswordEncoder`), PostgreSQL in production and H2 for tests, and
  WebSocket signaling.
- Responsibilities: registration, email verification (SMTP via
  configuration), login and refresh tokens, device registry with signed
  email↔device-key bindings, device-code lookup, and relaying SDP/ICE.
- **Not** responsible for: message bodies, files, media. No media server is
  needed for LAN calls.
- STUN: any public or self-hosted server, set in configuration. TURN (coturn)
  is optional. Credentials are short-lived and issued by the server using the
  TURN REST API scheme.

## LAN-only mode without the server

Works: discovery, trust by fingerprint, messaging, files, calls and groups
between devices that can reach each other directly. Does not work: verified
email, password reset, cross-network connectivity, device-code lookup.

## Note

The development machine used for M1 has no JDK, so the server is not
scaffolded yet. CI will build it on `ubuntu-latest` with Temurin 21 once it
exists.
