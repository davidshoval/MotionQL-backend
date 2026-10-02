import { createPrivateKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type {
  LicenseEdition, ManifestNotification, NotificationCategory, NotificationSeverity, NotificationTarget, ProductManifest, RequiredUpdateRule,
} from './types.js';
import { toPublicKey } from './licenseFormat.js';

/**
 * Copied from the desktop app (motionql-platform src/main/product/manifest.ts as of PR #51, which adds
 * revokedLicenses), minus the client-side helpers. Keep it in sync with the app.
 *
 * Signed manifest: `MQLM1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>`. The signature covers
 * MANIFEST_CONTEXT followed by the payload bytes, so a license signature can never pass as a manifest (or back).
 * Signed with the license key unless policy names another public key (see docs/PRODUCT_SERVICE.md).
 */
export const MANIFEST_PREFIX = 'MQLM1';
export const MANIFEST_CONTEXT = 'motionql-product-manifest-v1\n';
// Room for MAX_REVOKED_LICENSES hashes next to the notifications.
export const MAX_MANIFEST_LENGTH = 2 * 1024 * 1024;
export const MAX_REVOKED_LICENSES = 20_000;
const LICENSE_HASH = /^[0-9a-f]{64}$/;

const MAX_NOTIFICATIONS = 50;
const NOTIFICATION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SEVERITIES: readonly NotificationSeverity[] = ['info', 'warning', 'critical'];
const CATEGORIES: readonly NotificationCategory[] = ['news', 'security', 'update', 'license'];
const EDITIONS: readonly (LicenseEdition | 'free')[] = ['trial', 'pro', 'enterprise', 'free'];
const PLATFORMS = ['darwin', 'win32', 'linux'] as const;
const CHANNELS = ['stable', 'beta'] as const;
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;

/** Semver order (build metadata ignored). Throws on anything that isn't x.y.z[-pre][+build]. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff) return Math.sign(diff);
  }
  const [preA, preB] = [pa[4], pb[4]];
  if (!preA || !preB) return preA ? -1 : preB ? 1 : 0;
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const [x, y] = [partsA[i], partsB[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value);

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

function text(value: unknown, key: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${key} must be a non-empty string of at most ${max} characters`);
  // Plain text only: control characters other than newlines and tabs are refused.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new Error(`${key} contains control characters`);
  return value.trim();
}

function httpsUrl(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 2000) throw new Error(`${key} must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} is not a valid URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${key} must be an https URL without credentials`);
  return url.href;
}

function list<T extends string>(value: unknown, key: string, allowed: readonly T[]): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => allowed.includes(item))) throw new Error(`${key} must be a list of: ${allowed.join(', ')}`);
  return [...new Set(value as T[])];
}

function strictKeys(value: unknown, key: string, known: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object`);
  const unknown = Object.keys(value).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`unknown key(s) in ${key}: ${unknown.join(', ')}`);
  return value as Record<string, unknown>;
}

function validateRule(raw: unknown, key: string): RequiredUpdateRule | undefined {
  if (raw === undefined) return undefined;
  const r = strictKeys(raw, key, ['minimumVersion', 'blockAfter', 'message', 'downloadUrl']);
  if (!isVersion(r.minimumVersion)) throw new Error(`${key}.minimumVersion must be a version like 1.4.0`);
  if (r.blockAfter !== undefined && !isIsoDate(r.blockAfter)) throw new Error(`${key}.blockAfter must be an ISO 8601 date`);
  const rule: RequiredUpdateRule = { minimumVersion: r.minimumVersion };
  if (r.blockAfter !== undefined) rule.blockAfter = new Date(r.blockAfter as string).toISOString();
  const message = text(r.message, `${key}.message`, 1000, false);
  if (message) rule.message = message;
  const downloadUrl = httpsUrl(r.downloadUrl, `${key}.downloadUrl`);
  if (downloadUrl) rule.downloadUrl = downloadUrl;
  return rule;
}

function validateTarget(raw: unknown, key: string): NotificationTarget | undefined {
  if (raw === undefined) return undefined;
  const r = strictKeys(raw, key, ['minVersion', 'maxVersion', 'editions', 'platforms', 'channels']);
  const target: NotificationTarget = {};
  for (const bound of ['minVersion', 'maxVersion'] as const) {
    if (r[bound] === undefined) continue;
    if (!isVersion(r[bound])) throw new Error(`${key}.${bound} must be a version`);
    target[bound] = r[bound] as string;
  }
  const editions = list(r.editions, `${key}.editions`, EDITIONS);
  if (editions) target.editions = editions;
  const platforms = list(r.platforms, `${key}.platforms`, PLATFORMS);
  if (platforms) target.platforms = platforms;
  const channels = list(r.channels, `${key}.channels`, CHANNELS);
  if (channels) target.channels = channels;
  return target;
}

function validateNotification(raw: unknown, index: number): ManifestNotification {
  const key = `notifications[${index}]`;
  const r = strictKeys(raw, key, ['id', 'severity', 'category', 'title', 'body', 'url', 'urlLabel', 'publishedAt', 'expiresAt', 'target']);
  if (typeof r.id !== 'string' || !NOTIFICATION_ID.test(r.id)) throw new Error(`${key}.id must be 1-64 of A-Z a-z 0-9 . _ -`);
  if (!SEVERITIES.includes(r.severity as NotificationSeverity)) throw new Error(`${key}.severity must be one of ${SEVERITIES.join(', ')}`);
  if (r.category !== undefined && !CATEGORIES.includes(r.category as NotificationCategory)) {
    throw new Error(`${key}.category must be one of ${CATEGORIES.join(', ')}`);
  }
  if (!isIsoDate(r.publishedAt)) throw new Error(`${key}.publishedAt must be an ISO 8601 date`);
  if (r.expiresAt !== undefined && !isIsoDate(r.expiresAt)) throw new Error(`${key}.expiresAt must be an ISO 8601 date`);
  const notification: ManifestNotification = {
    id: r.id,
    severity: r.severity as NotificationSeverity,
    title: text(r.title, `${key}.title`, 120)!,
    body: text(r.body, `${key}.body`, 2000)!,
    publishedAt: new Date(r.publishedAt).toISOString(),
  };
  if (r.category !== undefined) notification.category = r.category as NotificationCategory;
  const url = httpsUrl(r.url, `${key}.url`);
  if (url) notification.url = url;
  const urlLabel = text(r.urlLabel, `${key}.urlLabel`, 40, false);
  if (urlLabel) notification.urlLabel = urlLabel;
  if (r.expiresAt !== undefined) notification.expiresAt = new Date(r.expiresAt as string).toISOString();
  const target = validateTarget(r.target, `${key}.target`);
  if (target) notification.target = target;
  return notification;
}

/** Throws with a short reason when the manifest does not have the exact shape the app relies on. */
export function validateManifest(raw: unknown): ProductManifest {
  const r = strictKeys(raw, 'manifest', ['schema', 'issuedAt', 'requiredUpdate', 'notifications', 'revokedLicenses']);
  if (r.schema !== 1) throw new Error('manifest.schema must be 1');
  if (!isIsoDate(r.issuedAt)) throw new Error('manifest.issuedAt must be an ISO 8601 date');
  const manifest: ProductManifest = { schema: 1, issuedAt: new Date(r.issuedAt).toISOString(), notifications: [] };
  if (r.requiredUpdate !== undefined) {
    const u = strictKeys(r.requiredUpdate, 'requiredUpdate', ['stable', 'beta']);
    const stable = validateRule(u.stable, 'requiredUpdate.stable');
    const beta = validateRule(u.beta, 'requiredUpdate.beta');
    if (stable || beta) manifest.requiredUpdate = { ...(stable ? { stable } : {}), ...(beta ? { beta } : {}) };
  }
  const notifications = r.notifications ?? [];
  if (!Array.isArray(notifications) || notifications.length > MAX_NOTIFICATIONS) {
    throw new Error(`notifications must be a list of at most ${MAX_NOTIFICATIONS}`);
  }
  manifest.notifications = notifications.map(validateNotification);
  const ids = new Set<string>();
  for (const { id } of manifest.notifications) {
    if (ids.has(id)) throw new Error(`duplicate notification id ${id}`);
    ids.add(id);
  }
  if (r.revokedLicenses !== undefined) {
    const revoked = r.revokedLicenses;
    if (!Array.isArray(revoked) || revoked.length > MAX_REVOKED_LICENSES || !revoked.every((h) => typeof h === 'string' && LICENSE_HASH.test(h))) {
      throw new Error(`revokedLicenses must be a list of at most ${MAX_REVOKED_LICENSES} lowercase sha256 hex hashes`);
    }
    if (revoked.length) manifest.revokedLicenses = [...new Set(revoked as string[])];
  }
  return manifest;
}

const signedBytes = (payload: Buffer) => Buffer.concat([Buffer.from(MANIFEST_CONTEXT, 'utf8'), payload]);

/** For the product server and tests; the app only ever verifies. */
export function signManifest(manifest: ProductManifest, privateKey: string | KeyObject): string {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The manifest must be signed with an Ed25519 private key.');
  const payload = Buffer.from(JSON.stringify(validateManifest(manifest)), 'utf8');
  return `${MANIFEST_PREFIX}.${payload.toString('base64url')}.${sign(null, signedBytes(payload), key).toString('base64url')}`;
}

/** The signature is checked before the payload is parsed. Throws with a short reason. */
export function verifyManifest(token: string, publicKey: string | KeyObject): ProductManifest {
  if (typeof token !== 'string' || token.length > MAX_MANIFEST_LENGTH) throw new Error('manifest is missing or too large');
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== MANIFEST_PREFIX || !parts.slice(1).every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
    throw new Error('not a MotionQL manifest');
  }
  const payload = Buffer.from(parts[1], 'base64url');
  const signature = Buffer.from(parts[2], 'base64url');
  let valid = false;
  try {
    const key = toPublicKey(publicKey);
    valid = signature.length === 64 && key.asymmetricKeyType === 'ed25519' && verify(null, signedBytes(payload), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new Error('manifest signature is not valid');
  return validateManifest(JSON.parse(payload.toString('utf8')));
}
