import { createHash } from 'node:crypto';
import type { Actor, Ctx } from '../context.js';
import type { InstallDoc, ManifestDoc } from '../db.js';
import { badRequest } from '../errors.js';
import { MAX_REVOKED_LICENSES, isVersion, signManifest, validateManifest } from '../licensing/manifest.js';
import type { ProductManifest, UsagePing } from '../licensing/types.js';
import { audit } from './audit.js';

const DAY = 24 * 60 * 60 * 1000;
const INSTALL_ID = /^[0-9a-f-]{36}$/;
const PLATFORMS = ['darwin', 'win32', 'linux'];
const ARCH = /^[a-z0-9_]{1,16}$/;
const EDITIONS = ['trial', 'pro', 'enterprise', 'free'];

/** On unless staff switched it off: every released app (1.0.0 on) reads `revokedLicenses`. */
const revocationsOn = (doc: ManifestDoc) => doc.includeRevocations ?? true;

async function manifestDoc(ctx: Ctx): Promise<ManifestDoc> {
  return (await ctx.c.manifest.findOne({ _id: 'current' })) ?? { _id: 'current', notifications: [], updatedAt: new Date(0) };
}

/**
 * Hashes of revoked keys that have not expired yet (an expired key is refused by the app anyway), newest
 * revocations first up to the app's limit, then sorted so the signed content only changes when the set does.
 */
export async function revokedHashes(ctx: Ctx): Promise<string[]> {
  const docs = await ctx.c.licenses
    .find({ revokedAt: { $exists: true }, expiresAt: { $gt: ctx.now() } }, { projection: { hash: 1 } })
    .sort({ revokedAt: -1 })
    .limit(MAX_REVOKED_LICENSES)
    .toArray();
  return [...new Set(docs.map((d) => d.hash))].sort();
}

const contentOf = (doc: ManifestDoc, revoked: string[] | undefined) => ({
  ...(doc.requiredUpdate ? { requiredUpdate: doc.requiredUpdate } : {}),
  notifications: doc.notifications,
  // The app omits the field when empty; so does the server, so the signed bytes match what it validates.
  ...(revoked?.length ? { revokedLicenses: revoked } : {}),
});

/**
 * The signed manifest token (docs/PRODUCT_SERVICE.md in the app). It is re-signed with a fresh issuedAt only when
 * its content or the revocation list changes, because the app ignores a manifest older than the one it has.
 */
export async function currentManifestToken(ctx: Ctx): Promise<string> {
  const doc = await manifestDoc(ctx);
  const revoked = revocationsOn(doc) ? await revokedHashes(ctx) : undefined;
  const content = contentOf(doc, revoked);
  const digest = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  if (doc.token && doc.signedDigest === digest) return doc.token;
  let issuedAt = ctx.now();
  // Never go backwards, even if the clock does.
  if (doc.issuedAt && issuedAt <= doc.issuedAt) issuedAt = new Date(doc.issuedAt.getTime() + 1000);
  const manifest: ProductManifest = { schema: 1, issuedAt: issuedAt.toISOString(), ...content };
  const token = signManifest(manifest, ctx.config.signingKey);
  await ctx.c.manifest.updateOne(
    { _id: 'current' },
    { $set: { token, issuedAt, signedDigest: digest }, $setOnInsert: { notifications: [], updatedAt: ctx.now() } },
    { upsert: true },
  );
  return token;
}

export async function getManifestSettings(ctx: Ctx) {
  const doc = await manifestDoc(ctx);
  return {
    requiredUpdate: doc.requiredUpdate ?? null,
    notifications: doc.notifications,
    includeRevocations: revocationsOn(doc),
    issuedAt: doc.issuedAt?.toISOString() ?? null,
    updatedAt: doc.updatedAt.toISOString(),
    updatedBy: doc.updatedBy ?? null,
    revokedCount: (await revokedHashes(ctx)).length,
  };
}

/** Staff edit: checked with the app's own validator before it is stored, then signed on the next request. */
export async function updateManifestSettings(
  ctx: Ctx,
  actor: Actor,
  input: { requiredUpdate?: unknown; notifications?: unknown; includeRevocations?: boolean },
): Promise<void> {
  const doc = await manifestDoc(ctx);
  const draft = {
    schema: 1,
    issuedAt: ctx.now().toISOString(),
    ...(input.requiredUpdate !== undefined ? (input.requiredUpdate === null ? {} : { requiredUpdate: input.requiredUpdate }) : doc.requiredUpdate ? { requiredUpdate: doc.requiredUpdate } : {}),
    notifications: input.notifications !== undefined ? input.notifications : doc.notifications,
  };
  let valid: ProductManifest;
  try {
    valid = validateManifest(draft);
  } catch (error) {
    throw badRequest('invalid_manifest', error instanceof Error ? error.message : 'The manifest is not valid.');
  }
  await ctx.c.manifest.updateOne(
    { _id: 'current' },
    {
      $set: {
        notifications: valid.notifications,
        includeRevocations: input.includeRevocations ?? revocationsOn(doc),
        updatedAt: ctx.now(),
        updatedBy: actor.email,
        ...(valid.requiredUpdate ? { requiredUpdate: valid.requiredUpdate } : {}),
      },
      ...(valid.requiredUpdate ? {} : { $unset: { requiredUpdate: '' } }),
    },
    { upsert: true },
  );
  await audit(ctx, actor, 'manifest.update', {
    target: { type: 'manifest', id: 'current' },
    details: { notifications: valid.notifications.length, requiredUpdate: valid.requiredUpdate ?? null, includeRevocations: input.includeRevocations ?? revocationsOn(doc) },
  });
}

/** Same rules as the app's reference server: unknown fields are refused so nothing extra gets stored. */
export function validatePing(raw: unknown): UsagePing {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ping must be an object');
  const r = raw as Record<string, unknown>;
  const known = ['installId', 'appVersion', 'channel', 'platform', 'arch', 'edition', 'licenseHash'];
  const unknown = Object.keys(r).filter((key) => !known.includes(key));
  if (unknown.length) throw new Error(`unknown field(s): ${unknown.join(', ')}`);
  if (typeof r.installId !== 'string' || !INSTALL_ID.test(r.installId)) throw new Error('installId must be a UUID');
  if (!isVersion(r.appVersion) || (r.appVersion as string).length > 64) throw new Error('appVersion must be a version');
  if (r.channel !== 'stable' && r.channel !== 'beta') throw new Error('channel must be stable or beta');
  if (typeof r.platform !== 'string' || !PLATFORMS.includes(r.platform)) throw new Error('platform is not supported');
  if (typeof r.arch !== 'string' || !ARCH.test(r.arch)) throw new Error('arch is not valid');
  if (typeof r.edition !== 'string' || !EDITIONS.includes(r.edition)) throw new Error('edition is not valid');
  if (r.licenseHash !== undefined && (typeof r.licenseHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.licenseHash))) {
    throw new Error('licenseHash must be a sha256 hex digest');
  }
  return r as unknown as UsagePing;
}

/** Stores firstSeen/lastSeen per install. Never the IP address. */
export async function recordPing(ctx: Ctx, raw: unknown): Promise<void> {
  let ping: UsagePing;
  try {
    ping = validatePing(raw);
  } catch (error) {
    throw badRequest('invalid_ping', error instanceof Error ? error.message : 'invalid ping');
  }
  const now = ctx.now();
  const set: Partial<InstallDoc> = {
    lastSeen: now,
    appVersion: ping.appVersion,
    channel: ping.channel,
    platform: ping.platform,
    arch: ping.arch,
    edition: ping.edition,
  };
  if (ping.licenseHash) set.licenseHash = ping.licenseHash;
  await ctx.c.installs.updateOne(
    { _id: ping.installId },
    { $set: set, $setOnInsert: { firstSeen: now }, ...(ping.licenseHash ? {} : { $unset: { licenseHash: '' } }) },
    { upsert: true },
  );
}

const countBy = async (ctx: Ctx, field: string, since: Date) =>
  Object.fromEntries(
    (await ctx.c.installs.aggregate<{ _id: string; n: number }>([{ $match: { lastSeen: { $gte: since } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray()).map(
      (r) => [r._id ?? 'unknown', r.n],
    ),
  );

export async function usageStats(ctx: Ctx) {
  const now = ctx.now().getTime();
  const since = (days: number) => new Date(now - days * DAY);
  const [total, day, week, month, newWeek, newMonth, byVersion, byPlatform, byEdition, byChannel] = await Promise.all([
    ctx.c.installs.countDocuments(),
    ctx.c.installs.countDocuments({ lastSeen: { $gte: since(1) } }),
    ctx.c.installs.countDocuments({ lastSeen: { $gte: since(7) } }),
    ctx.c.installs.countDocuments({ lastSeen: { $gte: since(30) } }),
    ctx.c.installs.countDocuments({ firstSeen: { $gte: since(7) } }),
    ctx.c.installs.countDocuments({ firstSeen: { $gte: since(30) } }),
    countBy(ctx, 'appVersion', since(30)),
    countBy(ctx, 'platform', since(30)),
    countBy(ctx, 'edition', since(30)),
    countBy(ctx, 'channel', since(30)),
  ]);
  return {
    generatedAt: new Date(now).toISOString(),
    installs: { total, active: { day, week, month }, new: { week: newWeek, month: newMonth }, byVersion, byPlatform, byEdition, byChannel },
  };
}
