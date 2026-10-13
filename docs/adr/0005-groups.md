# ADR-0005: Local-network groups: admin-issued versioned snapshots and direct fan-out

Status: Accepted (M6)

## Context

Groups have to work with no server, with members who aren't each other's
contacts, and with members who are often offline.

## Decision

- **Membership is a versioned snapshot** (name, policy, members with roles and
  status). Every change bumps the version and the owner or admin making it
  sends the full snapshot to every member through the reliable outbox.
- A device **accepts a snapshot only from someone who is an owner or admin in
  its current view**, and only with a higher version. A first invitation is
  accepted only from a **contact** who is an admin in the snapshot.
- **The owner sequences membership replies** (accept, decline, leave), so those
  don't race between admins.
- **Messages fan out directly from the author** to each member over PeerLink.
  Nobody relays another member's messages, so every event arrives over an
  authenticated link from its real author, and per-message signatures aren't
  needed.
- **Group membership is scoped trust.** Co-members may connect to each other
  and exchange group events. Direct messages, calls and skill sharing still
  require being contacts.

## Consequences and limitations

- A member who is offline gets a message only once they and the author are
  online at the same time. MeshTalk tells the author when updates are waiting.
- New members don't receive earlier history.
- If two admins change the group at the same moment, the snapshot that arrives
  first with the higher version wins, and the other change can be lost.
- Display names of non-contacts are as listed by the group's admins.
- "Delivered" for a group message means every member's device acknowledged it.
  Read receipts aren't sent in groups.
