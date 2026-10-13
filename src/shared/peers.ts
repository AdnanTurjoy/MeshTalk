import { z } from 'zod';

export const DISPLAY_NAME_MAX = 64;
export const EMAIL_LABEL_MAX = 254;
export const REQUEST_NOTE_MAX = 280;

/** Trims and collapses whitespace; rejects control characters. */
export const displayNameSchema = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1, 'Enter a name')
      .max(DISPLAY_NAME_MAX)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f\u007f]+$/, 'Name contains invalid characters'),
  );

/**
 * An email-shaped label. In LAN-only mode nobody verifies it; it is lowercased
 * so duplicates are easier to notice, but uniqueness is NOT guaranteed.
 */
export const emailLabelSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_LABEL_MAX)
  .pipe(z.email('Enter a valid email address'));

export const accountInputSchema = z
  .object({
    displayName: displayNameSchema,
    emailLabel: z.union([emailLabelSchema, z.literal('').transform(() => null), z.null()]),
  })
  .strict();
export type AccountInput = z.input<typeof accountInputSchema>;

export const deviceIdSchema = z.string().regex(/^[A-Z2-7]{52}$/, 'Invalid device ID');

export const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:%[\]-]+$/, 'Enter an IP address or host name');
export const portSchema = z.number().int().min(1).max(65535);
export const addressSchema = z.object({ host: hostSchema, port: portSchema }).strict();

export interface LocalAccount {
  displayName: string;
  emailLabel: string | null;
  /** Always false in LAN-only mode: nobody has verified the address. */
  emailVerified: boolean;
  createdAt: number;
}

export interface DeviceIdentityInfo {
  deviceId: string;
  /** Grouped for reading aloud / comparing, e.g. `ABCD-EFGH-…`. */
  fingerprint: string;
  secretStorage: { backend: string; secure: boolean };
}

export type ContactState = 'outgoing' | 'incoming' | 'accepted' | 'declined' | 'blocked';

export interface Contact {
  deviceId: string;
  fingerprint: string;
  displayName: string;
  emailLabel: string | null;
  state: ContactState;
  verified: boolean;
  online: boolean;
  /** Null if never seen or if they don't share online status. */
  lastSeenAt: number | null;
  requestNote: string | null;
  /** Another contact already uses this display name: possible impersonation. */
  nameCollision: boolean;
  createdAt: number;
}

export interface NearbyDevice {
  deviceId: string;
  fingerprint: string;
  host: string;
  port: number;
  lastSeenAt: number;
  /** Only known for devices that are already contacts. */
  contactState: ContactState | null;
  displayName: string | null;
}

export type DiscoveryState = 'off' | 'on' | 'error';

export interface NetworkStatus {
  listener: { port: number; addresses: string[] } | null;
  listenerError: string | null;
  discovery: DiscoveryState;
  discoveryError: string | null;
  connectedPeers: number;
}

export type ConnectionTestStage =
  | 'ok'
  | 'dns'
  | 'tcp_refused'
  | 'tcp_timeout'
  | 'unreachable'
  | 'tls'
  | 'identity_mismatch'
  | 'self'
  | 'protocol';

export interface ConnectionTestResult {
  stage: ConnectionTestStage;
  message: string;
  deviceId: string | null;
  fingerprint: string | null;
  latencyMs: number | null;
}
