import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { deviceIdFromCertificate } from './device-id';

// Node's webcrypto implements the WebCrypto API that @peculiar/x509 expects.
x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

type SelfSignedKeys = Parameters<typeof x509.X509CertificateGenerator.createSelfSigned>[0]['keys'];

export interface DeviceCredentials {
  deviceId: string;
  certPem: string;
  keyPem: string;
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const VALIDITY_YEARS = 20;

/**
 * Generates the device's long-term identity: an ECDSA P-256 key and a
 * self-signed certificate. The certificate carries no personal data; the
 * device ID is its SHA-256 hash. Used for mutual TLS (see ADR-0003).
 */
export async function generateDeviceCredentials(now = new Date()): Promise<DeviceCredentials> {
  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const notAfter = new Date(now);
  notAfter.setFullYear(notAfter.getFullYear() + VALIDITY_YEARS);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('hex'),
    name: 'CN=MeshTalk Device',
    notBefore: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    notAfter,
    keys: keys as unknown as SelfSignedKeys,
    signingAlgorithm: ALGORITHM,
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return {
    deviceId: deviceIdFromCertificate(new Uint8Array(cert.rawData)),
    certPem: cert.toString('pem'),
    keyPem: toPem('PRIVATE KEY', Buffer.from(pkcs8)),
  };
}

export function certificateDer(certPem: string): Uint8Array {
  return new Uint8Array(new x509.X509Certificate(certPem).rawData);
}

function toPem(label: string, der: Buffer): string {
  const body =
    der
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
