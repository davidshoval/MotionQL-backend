import type { Actor, Ctx } from '../context.js';
import type { LicenseDoc, LicenseSource, UserDoc } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { newId } from '../lib/ids.js';
import { addDays } from '../lib/time.js';
import { licenseHashOf } from '../lib/tokens.js';
import { signLicense, verifyLicense } from '../licensing/licenseFormat.js';
import type { LicenseEdition } from '../licensing/types.js';
import { audit } from './audit.js';
import { getFreePlan } from './settings.js';

export type LicenseStatus = 'active' | 'expired' | 'revoked' | 'replaced';

export interface LicenseView {
  licenseId: string;
  key: string;
  edition: LicenseEdition;
  features: string[];
  customer: string;
  email: string;
  seats: number;
  issuedAt: string;
  expiresAt: string;
  status: LicenseStatus;
  source: LicenseSource;
  revokedAt?: string;
  team?: { id: string; name: string };
}

export function licenseStatus(doc: Pick<LicenseDoc, 'revokedAt' | 'replacedBy' | 'expiresAt'>, now: Date): LicenseStatus {
  if (doc.revokedAt) return doc.replacedBy ? 'replaced' : 'revoked';
  return doc.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
}

export function licenseView(doc: LicenseDoc, now: Date, teamName?: string): LicenseView {
  return {
    licenseId: doc._id,
    key: doc.key,
    edition: doc.payload.edition,
    features: doc.payload.features,
    customer: doc.payload.customer,
    email: doc.payload.email,
    seats: doc.payload.seats,
    issuedAt: doc.payload.issuedAt,
    expiresAt: doc.payload.expiresAt,
    status: licenseStatus(doc, now),
    source: doc.source,
    ...(doc.revokedAt ? { revokedAt: doc.revokedAt.toISOString() } : {}),
    ...(doc.teamId && teamName ? { team: { id: doc.teamId, name: teamName } } : {}),
  };
}

/** The app limits customer to 200 characters with no control characters. */
const customerName = (value: string) => value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) || 'Xquery user';

export interface IssueOptions {
  source: LicenseSource;
  email: string;
  customer: string;
  edition: LicenseEdition;
  features: string[];
  durationDays: number;
  userId?: string;
  teamId?: string;
  actor?: Pick<Actor, 'id' | 'email'>;
}

/** Signs a one-seat key in the app's XQ1 format and stores it. */
export async function issueLicense(ctx: Ctx, opts: IssueOptions): Promise<LicenseDoc> {
  const now = ctx.now();
  const licenseId = newId('lic');
  const expires = addDays(now, opts.durationDays);
  const key = signLicense(
    {
      licenseId,
      customer: customerName(opts.customer),
      email: opts.email,
      edition: opts.edition,
      seats: 1,
      issuedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      features: [...new Set(opts.features)],
    },
    ctx.config.signingKey,
  );
  // Read the payload back exactly as signed (validatePayload normalises it), and prove the key verifies.
  const verified = verifyLicense(key, ctx.config.publicKeyBase64);
  if (!verified.ok) throw new Error(`issued key does not verify: ${verified.detail}`);
  const doc: LicenseDoc = {
    _id: licenseId,
    source: opts.source,
    key,
    payload: verified.payload,
    hash: licenseHashOf(licenseId),
    issuedAt: now,
    expiresAt: expires,
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(opts.teamId ? { teamId: opts.teamId } : {}),
    ...(opts.actor ? { issuedBy: opts.actor.email } : {}),
  };
  await ctx.c.licenses.insertOne(doc);
  await audit(ctx, opts.actor, 'license.issue', {
    teamId: opts.teamId,
    target: { type: 'license', id: licenseId, email: opts.email },
    details: { source: opts.source, edition: opts.edition, features: opts.features, expiresAt: doc.payload.expiresAt },
  });
  return doc;
}

/** Puts a key on the manifest's revocation list. Idempotent. */
export async function revokeLicense(
  ctx: Ctx,
  licenseId: string,
  reason: string,
  actor?: Pick<Actor, 'id' | 'email'>,
  replacedBy?: string,
): Promise<void> {
  const res = await ctx.c.licenses.findOneAndUpdate(
    { _id: licenseId, revokedAt: { $exists: false } },
    { $set: { revokedAt: ctx.now(), revokeReason: reason, ...(replacedBy ? { replacedBy } : {}) } },
  );
  if (res) {
    await audit(ctx, actor, replacedBy ? 'license.replace' : 'license.revoke', {
      teamId: res.teamId,
      target: { type: 'license', id: licenseId, email: res.payload.email },
      details: { reason, ...(replacedBy ? { replacedBy } : {}) },
    });
  }
}

/** A new key with the same edition and features for the rest of the old key's term (at least the plan length if expired). */
export async function reissueLicense(ctx: Ctx, old: LicenseDoc, actor: Pick<Actor, 'id' | 'email'>, durationDays: number): Promise<LicenseDoc> {
  const fresh = await issueLicense(ctx, {
    source: old.source,
    email: old.payload.email,
    customer: old.payload.customer,
    edition: old.payload.edition,
    features: old.payload.features,
    durationDays,
    userId: old.userId,
    teamId: old.teamId,
    actor,
  });
  await revokeLicense(ctx, old._id, 'reissued', actor, fresh._id);
  return fresh;
}

/** Days left on a key, rounded up, at least 1: reissuing never extends a key past its own term. */
export const remainingDays = (doc: LicenseDoc, now: Date) =>
  Math.max(1, Math.ceil((doc.expiresAt.getTime() - now.getTime()) / 86_400_000));

const customerFor = (user: Pick<UserDoc, 'name' | 'company'>) => user.company || user.name;

/** Issues the free-plan key once a user is verified, unless they already hold an active one. */
export async function grantFreeLicense(ctx: Ctx, user: UserDoc): Promise<LicenseDoc | undefined> {
  const plan = await getFreePlan(ctx);
  if (!plan.enabled || !user.emailVerifiedAt) return undefined;
  const existing = await ctx.c.licenses.findOne({
    userId: user._id,
    source: 'free',
    revokedAt: { $exists: false },
    expiresAt: { $gt: ctx.now() },
  });
  if (existing) return undefined;
  return issueLicense(ctx, {
    source: 'free',
    email: user.email,
    customer: customerFor(user),
    edition: plan.edition,
    features: plan.features,
    durationDays: plan.durationDays,
    userId: user._id,
    actor: { id: user._id, email: user.email },
  });
}

/** /account "Renew": a fresh free key when the current one is within the renewal window or gone. */
export async function renewFreeLicense(ctx: Ctx, user: UserDoc): Promise<LicenseDoc> {
  const plan = await getFreePlan(ctx);
  if (!plan.enabled) throw conflict('not_renewable', 'Free licenses are not available at the moment.');
  const now = ctx.now();
  const active = await ctx.c.licenses
    .find({ userId: user._id, source: 'free', revokedAt: { $exists: false }, expiresAt: { $gt: now } })
    .sort({ expiresAt: -1 })
    .limit(1)
    .next();
  if (active) {
    if (!plan.renewable) throw conflict('not_renewable', 'Your free license cannot be renewed.');
    const opensAt = addDays(active.expiresAt, -plan.renewWindowDays);
    if (now < opensAt) {
      throw conflict('not_renewable', `Your license can be renewed from ${opensAt.toISOString().slice(0, 10)}.`);
    }
  } else {
    const previous = await ctx.c.licenses.countDocuments({ userId: user._id, source: 'free' });
    if (previous > 0 && !plan.renewable) throw conflict('not_renewable', 'Your free license cannot be renewed.');
  }
  return issueLicense(ctx, {
    source: 'free',
    email: user.email,
    customer: customerFor(user),
    edition: plan.edition,
    features: plan.features,
    durationDays: plan.durationDays,
    userId: user._id,
    actor: { id: user._id, email: user.email },
  });
}

/** A user replaces one of their own personal keys (lost or leaked). Team keys are reissued by the team admin. */
export async function reissueOwnLicense(ctx: Ctx, user: UserDoc, licenseId: string): Promise<LicenseDoc> {
  const doc = await ctx.c.licenses.findOne({ _id: licenseId, userId: user._id });
  if (!doc) throw notFound('License not found.');
  if (doc.teamId) throw forbidden('Ask your team admin to reissue a team key.');
  const status = licenseStatus(doc, ctx.now());
  if (status !== 'active') throw conflict('not_active', 'Only an active key can be reissued.');
  return reissueLicense(ctx, doc, { id: user._id, email: user.email }, remainingDays(doc, ctx.now()));
}
