import type { Actor, Ctx } from '../context.js';
import type { LicenseDoc } from '../db.js';
import { conflict, notFound } from '../errors.js';
import type { LicenseEdition } from '../licensing/types.js';
import { userView } from './accounts.js';
import { audit } from './audit.js';
import { issueLicense, licenseStatus, licenseView, reissueLicense, remainingDays, revokeLicense } from './licenses.js';
import { usageStats } from './product.js';
import { teamView } from './teams.js';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function searchUsers(ctx: Ctx, q: string | undefined, limit: number) {
  const filter = q ? { $or: [{ email: { $regex: escapeRegex(q.toLowerCase()) } }, { name: { $regex: escapeRegex(q), $options: 'i' } }, { _id: q }] } : {};
  const users = await ctx.c.users.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
  return users.map(userView);
}

export async function userDetail(ctx: Ctx, userId: string) {
  const user = await ctx.c.users.findOne({ _id: userId });
  if (!user) throw notFound('User not found.');
  const [licenses, memberships] = await Promise.all([
    ctx.c.licenses.find({ userId }).sort({ issuedAt: -1, _id: -1 }).toArray(),
    ctx.c.teamMembers.find({ userId }).toArray(),
  ]);
  const teams = await ctx.c.teams.find({ _id: { $in: memberships.map((m) => m.teamId) } }).toArray();
  const now = ctx.now();
  return {
    user: userView(user),
    referral: {
      code: user.referralCode ?? null,
      referredBy: user.referredBy ?? null,
      heardFrom: user.heardFrom ?? null,
      rewardedAt: user.referralRewardedAt?.toISOString() ?? null,
      bonusDays: user.bonusDays ?? 0,
      signups: await ctx.c.users.countDocuments({ referredBy: userId }),
    },
    attribution: user.attribution ?? null,
    licenses: licenses.map((l) => licenseView(l, now)),
    teams: memberships.map((m) => ({ id: m.teamId, name: teams.find((t) => t._id === m.teamId)?.name ?? '', role: m.role, hasSeat: m.hasSeat })),
  };
}

export async function setStaff(ctx: Ctx, actor: Actor, userId: string, isStaff: boolean) {
  const user = await ctx.c.users.findOneAndUpdate({ _id: userId }, { $set: { isStaff, updatedAt: ctx.now() } }, { returnDocument: 'after' });
  if (!user) throw notFound('User not found.');
  await audit(ctx, actor, isStaff ? 'staff.grant' : 'staff.revoke', { target: { type: 'user', id: userId, email: user.email } });
  return userView(user);
}

export async function searchTeams(ctx: Ctx, q: string | undefined, limit: number) {
  const filter = q ? { $or: [{ name: { $regex: escapeRegex(q), $options: 'i' } }, { _id: q }] } : {};
  const teams = await ctx.c.teams.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
  return teams.map(teamView);
}

export async function updateTeamLimits(
  ctx: Ctx,
  actor: Actor,
  teamId: string,
  patch: { seatLimit?: number; allowedEditions?: LicenseEdition[]; allowedFeatures?: string[] },
) {
  const team = await ctx.c.teams.findOne({ _id: teamId });
  if (!team) throw notFound('Team not found.');
  if (patch.seatLimit !== undefined && patch.seatLimit < team.seatsUsed) {
    throw conflict('seat_limit_below_used', `The team uses ${team.seatsUsed} seats; free some before lowering the limit.`);
  }
  const updated = await ctx.c.teams.findOneAndUpdate({ _id: teamId }, { $set: { ...patch, updatedAt: ctx.now() } }, { returnDocument: 'after' });
  await audit(ctx, actor, 'staff.team.update', { teamId, target: { type: 'team', id: teamId }, details: patch });
  return teamView(updated!);
}

export async function searchLicenses(ctx: Ctx, q: string | undefined, limit: number) {
  const filter = q
    ? { $or: [{ _id: q }, { hash: q.toLowerCase() }, { 'payload.email': { $regex: escapeRegex(q.toLowerCase()) } }, { 'payload.customer': { $regex: escapeRegex(q), $options: 'i' } }] }
    : {};
  const docs = await ctx.c.licenses.find(filter).sort({ issuedAt: -1, _id: -1 }).limit(limit).toArray();
  const now = ctx.now();
  return docs.map((d) => ({ ...licenseView(d, now), hash: d.hash, userId: d.userId ?? null, teamId: d.teamId ?? null, revokeReason: d.revokeReason ?? null, replacedBy: d.replacedBy ?? null, issuedBy: d.issuedBy ?? null }));
}

/** A key by hand, e.g. for a partner or a sales deal. Linked to the account with that e-mail when there is one. */
export async function issueManual(
  ctx: Ctx,
  actor: Actor,
  input: { email: string; customer: string; edition: LicenseEdition; features: string[]; durationDays: number },
): Promise<LicenseDoc> {
  const email = input.email.trim().toLowerCase();
  const user = await ctx.c.users.findOne({ email });
  return issueLicense(ctx, { source: 'staff', email, customer: input.customer, edition: input.edition, features: input.features, durationDays: input.durationDays, userId: user?._id, actor });
}

async function licenseOrThrow(ctx: Ctx, licenseId: string): Promise<LicenseDoc> {
  const doc = await ctx.c.licenses.findOne({ _id: licenseId });
  if (!doc) throw notFound('License not found.');
  return doc;
}

export async function revokeByStaff(ctx: Ctx, actor: Actor, licenseId: string, reason: string) {
  const doc = await licenseOrThrow(ctx, licenseId);
  await revokeLicense(ctx, licenseId, reason, actor);
  // A revoked team key also frees its seat.
  if (doc.teamId) {
    const member = await ctx.c.teamMembers.findOneAndUpdate({ teamId: doc.teamId, licenseId, hasSeat: true }, { $set: { hasSeat: false }, $unset: { licenseId: '' } });
    if (member) await ctx.c.teams.updateOne({ _id: doc.teamId }, { $inc: { seatsUsed: -1 } });
  }
}

/** Expiry is signed into the key, so extending means a replacement key that runs `days` longer. */
export async function extendLicense(ctx: Ctx, actor: Actor, licenseId: string, days: number): Promise<LicenseDoc> {
  const doc = await licenseOrThrow(ctx, licenseId);
  const status = licenseStatus(doc, ctx.now());
  if (status === 'revoked' || status === 'replaced') throw conflict('not_active', 'A revoked key cannot be extended; issue a new one.');
  const base = status === 'active' ? remainingDays(doc, ctx.now()) : 0;
  const fresh = await reissueLicense(ctx, doc, actor, base + days);
  if (doc.teamId) await ctx.c.teamMembers.updateOne({ teamId: doc.teamId, licenseId }, { $set: { licenseId: fresh._id } });
  return fresh;
}

export async function overview(ctx: Ctx) {
  const now = ctx.now();
  const [users, verified, teams, activeLicenses, revoked, usage] = await Promise.all([
    ctx.c.users.countDocuments(),
    ctx.c.users.countDocuments({ emailVerifiedAt: { $exists: true } }),
    ctx.c.teams.countDocuments(),
    ctx.c.licenses.countDocuments({ revokedAt: { $exists: false }, expiresAt: { $gt: now } }),
    ctx.c.licenses.countDocuments({ revokedAt: { $exists: true }, expiresAt: { $gt: now } }),
    usageStats(ctx),
  ]);
  return { users: { total: users, verified }, teams, licenses: { active: activeLicenses, revokedUnexpired: revoked }, ...usage };
}

/** Top inviters (sign-ups through their link) and how people heard about MotionQL. */
export async function referralStats(ctx: Ctx, limit: number) {
  const [inviters, heardFrom, referred, answered] = await Promise.all([
    ctx.c.users
      .aggregate<{ _id: string; signups: number; confirmed: number; rewarded: number }>([
        { $match: { referredBy: { $type: 'string' } } },
        {
          $group: {
            _id: '$referredBy',
            signups: { $sum: 1 },
            confirmed: { $sum: { $cond: [{ $ifNull: ['$emailVerifiedAt', false] }, 1, 0] } },
            rewarded: { $sum: { $cond: [{ $ifNull: ['$referralRewardedAt', false] }, 1, 0] } },
          },
        },
        { $sort: { signups: -1, _id: 1 } },
        { $limit: limit },
      ])
      .toArray(),
    ctx.c.users
      .aggregate<{ _id: string; count: number }>([
        { $match: { heardFrom: { $type: 'string' } } },
        { $group: { _id: { $toLower: '$heardFrom' }, count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: limit },
      ])
      .toArray(),
    ctx.c.users.countDocuments({ referredBy: { $type: 'string' } }),
    ctx.c.users.countDocuments({ heardFrom: { $type: 'string' } }),
  ]);
  const users = new Map((await ctx.c.users.find({ _id: { $in: inviters.map((i) => i._id) } }).toArray()).map((u) => [u._id, u]));
  return {
    referredSignups: referred,
    heardFromAnswers: answered,
    topInviters: inviters.map((i) => {
      const u = users.get(i._id);
      return { userId: i._id, email: u?.email ?? null, name: u?.name ?? null, signups: i.signups, confirmed: i.confirmed, rewarded: i.rewarded };
    }),
    heardFrom: heardFrom.map((h) => ({ answer: h._id, count: h.count })),
  };
}
