# LAN setup and troubleshooting

MeshTalk's **Network** screen shows the address and port others can use to add
you, whether discovery is running, and a **Test a connection** tool that
reports which step fails (name lookup, no answer, refused, not MeshTalk, or a
different device than expected).

## What MeshTalk needs from the network

| Need                                        | Why                                     | Typical blocker                                                                        |
| ------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| UDP multicast to `224.0.0.251:5353` (mDNS)  | Seeing nearby devices automatically     | Guest/hotel/enterprise Wi-Fi, VLAN boundaries, "multicast enhancement" on some routers |
| Inbound TCP to MeshTalk's port              | Direct, encrypted device-to-device link | OS firewall, client isolation                                                          |
| Device-to-device traffic on the same subnet | Everything                              | **Client/AP isolation** on Wi-Fi                                                       |

If discovery fails but TCP works, you can still connect by entering the other
device's address, or by scanning its QR code.

## Operating-system firewalls

**Windows**

- On first use, Windows Defender Firewall asks whether to allow MeshTalk.
  Allow it on **Private networks**.
- If the network is marked **Public**, discovery is blocked. Change it in
  Settings → Network & Internet → (your network) → Network profile type →
  Private.

**macOS**

- macOS 15+ asks for **Local Network** access the first time. If you denied it,
  re-enable it in System Settings → Privacy & Security → Local Network.
- If the application firewall is on, allow incoming connections for MeshTalk
  (System Settings → Network → Firewall → Options).

**Linux**

- `ufw`: `sudo ufw allow 5353/udp` for mDNS, and allow MeshTalk's TCP port
  (shown on the Network screen; 47820 unless it was taken).
- `firewalld`: `sudo firewall-cmd --add-service=mdns --permanent && sudo firewall-cmd --reload`.

## Networks where direct connection is not possible

- Wi-Fi with **client isolation** (common on guest networks): devices cannot
  reach each other at all. Use a different network, or Mode B/C with a TURN
  relay (calls only; files are never relayed through a third party without
  E2E encryption).
- Devices on **different VLANs or subnets**: multicast usually doesn't cross
  them. Use manual address entry if routing allows it.
- **VPN clients** sometimes capture all traffic. Split-tunnel the local subnet.

## Discovery is not trust

Seeing a device in the nearby list proves nothing about who runs it. MeshTalk
only exchanges private data after mutual TLS confirms the device's
certificate fingerprint. Compare fingerprints in person to be sure.
