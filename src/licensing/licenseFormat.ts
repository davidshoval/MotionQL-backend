import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { LicenseEdition, LicensePayload } from './types.js';

/**
 * Copied from the desktop app (Xquery.io-Platform src/main/licensing/licenseFormat.ts as of PR #51).
 * Keep it in sync apart from imports: the app verifies keys with this exact code.
 *
 * License key: `XQ1.<base64url(payload JSON)>.<base64url(Ed25519 signature of those exact bytes)>`.
 * Verified offline with the public key embedded in the app; nothing is sent anywhere.
 */
export const LICENSE_PREFIX = 'XQ1';
export const MAX_LICENSE_KEY_LENGTH = 16 * 1024;

const EDITIONS: readonly LicenseEdition[] = ['trial', 'pro', 'enterprise'];
const LICENSE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const FEATURE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_FEATURES = 32;
const MAX_SEATS = 1_000_000;

export type VerifyFailure = 'malformed' | 'bad-signature' | 'invalid-payload';

export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: VerifyFailure; detail: string };

export const VERIFY_MESSAGES: Record<VerifyFailure, string> = {
  malformed: 'This is not an XQuery license key.',
  'bad-signature': 'The license key signature is not valid (it was changed, or it was not issued for this app).',
  'invalid-payload': 'The license key is signed but its contents are not valid.',
};

const b64url = (data: Buffer) => data.toString('base64url');

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}

/** Throws with a short reason when the payload does not have the exact shape the app relies on. */
export function validatePayload(raw: unknown): LicensePayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('payload must be an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.licenseId !== 'string' || !LICENSE_ID.test(r.licenseId)) throw new Error('licenseId must be 1-64 of A-Z a-z 0-9 . _ -');
  if (!boundedString(r.customer, 200)) throw new Error('customer must be a non-empty string');
  if (!boundedString(r.email, 254) || !/^[^\s@]+@[^\s@]+$/.test(r.email)) throw new Error('email must be an email address');
  if (!EDITIONS.includes(r.edition as LicenseEdition)) throw new Error(`edition must be one of ${EDITIONS.join(', ')}`);
  if (typeof r.seats !== 'number' || !Number.isInteger(r.seats) || r.seats < 1 || r.seats > MAX_SEATS) throw new Error('seats must be a positive integer');
  if (!isIsoDate(r.issuedAt)) throw new Error('issuedAt must be an ISO 8601 date');
  if (!isIsoDate(r.expiresAt)) throw new Error('expiresAt must be an ISO 8601 date');
  if (Date.parse(r.expiresAt) <= Date.parse(r.issuedAt)) throw new Error('expiresAt must be after issuedAt');
  if (!Array.isArray(r.features) || r.features.length > MAX_FEATURES || !r.features.every((f) => typeof f === 'string' && FEATURE.test(f))) {
    throw new Error('features must be a list of lowercase feature names');
  }
  return {
    licenseId: r.licenseId,
    customer: r.customer.trim(),
    email: r.email.trim(),
    edition: r.edition as LicenseEdition,
    seats: r.seats,
    issuedAt: new Date(r.issuedAt).toISOString(),
    expiresAt: new Date(r.expiresAt).toISOString(),
    features: [...new Set(r.features as string[])],
  };
}

export function toPublicKey(key: string | KeyObject): KeyObject {
  if (typeof key !== 'string') return key;
  const trimmed = key.trim();
  if (trimmed.startsWith('-----BEGIN')) return createPublicKey(trimmed);
  return createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
}

/** Issues a key. Only the offline CLI (tools/license) and tests hold a private key; the app never does. */
export function signLicense(payload: LicensePayload, privateKey: string | KeyObject): string {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('License keys must be signed with an Ed25519 private key.');
  const bytes = Buffer.from(JSON.stringify(validatePayload(payload)), 'utf8');
  return `${LICENSE_PREFIX}.${b64url(bytes)}.${b64url(sign(null, bytes, key))}`;
}

/** Splits a pasted key; whitespace and line breaks from e-mail clients are ignored. */
export function parseLicenseKey(key: string): { payloadBytes: Buffer; signature: Buffer } | null {
  if (typeof key !== 'string' || key.length > MAX_LICENSE_KEY_LENGTH) return null;
  const compact = key.replace(/\s+/g, '');
  const parts = compact.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
  const signature = Buffer.from(parts[2], 'base64url');
  if (signature.length !== 64) return null;
  return { payloadBytes: Buffer.from(parts[1], 'base64url'), signature };
}

/** The signature is checked before the payload is parsed. Expiry is not checked here (see computeLicenseStatus). */
export function verifyLicense(key: string, publicKey: string | KeyObject): VerifyResult {
  const parsed = parseLicenseKey(key);
  if (!parsed) return { ok: false, reason: 'malformed', detail: VERIFY_MESSAGES.malformed };
  let valid = false;
  try {
    const pub = toPublicKey(publicKey);
    valid = pub.asymmetricKeyType === 'ed25519' && verify(null, parsed.payloadBytes, pub, parsed.signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad-signature', detail: VERIFY_MESSAGES['bad-signature'] };
  try {
    return { ok: true, payload: validatePayload(JSON.parse(parsed.payloadBytes.toString('utf8'))) };
  } catch (error) {
    return { ok: false, reason: 'invalid-payload', detail: `${VERIFY_MESSAGES['invalid-payload']} (${error instanceof Error ? error.message : 'parse error'})` };
  }
}

/** Reads the payload without trusting it, for `license inspect` on keys signed by another key. */
export function decodeUnverified(key: string): unknown {
  const parsed = parseLicenseKey(key);
  if (!parsed) throw new Error(VERIFY_MESSAGES.malformed);
  return JSON.parse(parsed.payloadBytes.toString('utf8'));
}

/**
 * `sha256("xquery-license-id:" + licenseId)` in hex: how a license is named outside the app (the usage ping, and the
 * manifest's revokedLicenses). The vendor can match it to its records; nobody else learns the id.
 */
export function licenseHash(licenseId: string): string {
  return createHash('sha256').update(`xquery-license-id:${licenseId}`, 'utf8').digest('hex');
}
