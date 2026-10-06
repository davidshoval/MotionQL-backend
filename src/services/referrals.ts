import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { UserDoc } from '../db.js';
import { notFound } from '../errors.js';
import { audit } from './audit.js';
import { templates } from './email.js';
import { customerFor, issueLicense, remainingDays } from './licenses.js';
import { getReferralSettings } from './settings.js';

// Refer a friend. Every account has an invite link (motionql.com/r/CODE). Signing up through it records referredBy.
// While staff have the reward on, both people get `bonusDays` more on their free key once the friend confirms their
// e-mail (so throwaway sign-ups earn nothing), up to `maxRewardsPerUser` rewards per inviter.

/** No 0/O or 1/I, so a code read aloud or typed from a screenshot still works. 32 symbols: one byte maps without bias. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export const newReferralCode = () => [...randomBytes(CODE_LENGTH)].map((b) => ALPHABET[b & 31]).join('');

/** Codes are matched case-insensitively; anything that cannot be a code gives undefined. */
export function normalizeReferralCode(raw: string | undefined): string | undefined {
  const code = raw?.trim().toUpperCase();
  return code && /^[A-Z0-9]{4,16}$/.test(code) ? code : undefined;
}

export const referralUrl = (ctx: Ctx, code: string) => `${ctx.config.webUrl}/r/${code}`;

const isDuplicateCode = (error: unknown) => {
  const e = error as { code?: number; keyPattern?: Record<string, unknown> };
  return e.code === 11000 && Boolean(e.keyPattern?.referralCode);
};

/** Accounts made before referrals have no code yet: give them one the first time they ask for their link. */
export async function ensureReferralCode(ctx: Ctx, user: UserDoc): Promise<string> {
  if (user.referralCode) return user.referralCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newReferralCode();
    try {
      const updated = await ctx.c.users.findOneAndUpdate(
        { _id: user._id, referralCode: { $exists: false } },
        { $set: { referralCode: code } },
        { returnDocument: 'after' },
      );
      if (updated?.referralCode) return updated.referralCode;
      // Another request set it first.
      const fresh = await ctx.c.users.findOne({ _id: user._id });
      if (fresh?.referralCode) return fresh.referralCode;
      throw notFound('User not found.');
    } catch (error) {
      if (!isDuplicateCode(error)) throw error;
    }
  }
  throw new Error('could not pick a unique referral code');
}

export async function referrerForCode(ctx: Ctx, raw: string | undefined): Promise<UserDoc | undefined> {
  const code = normalizeReferralCode(raw);
  if (!code) return undefined;
  return (await ctx.c.users.findOne({ referralCode: code })) ?? undefined;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0]?.slice(0, 50) ?? '';

/** What the /r/CODE landing page shows: the inviter's first name only, and the reward while it is on. */
export async function referralPreview(ctx: Ctx, code: string) {
  const inviter = await referrerForCode(ctx, code);
  if (!inviter) throw notFound('This invite link is not valid.');
  const settings = await getReferralSettings(ctx);
  return {
    code: inviter.referralCode!,
    inviterName: firstName(inviter.name),
    reward: settings.enabled ? { bonusDays: settings.bonusDays } : null,
  };
}

/** The account page: the user's link and how many people signed up with it. */
export async function referralSummary(ctx: Ctx, user: UserDoc) {
  const code = await ensureReferralCode(ctx, user);
  const [signups, confirmed, rewarded, settings] = await Promise.all([
    ctx.c.users.countDocuments({ referredBy: user._id }),
    ctx.c.users.countDocuments({ referredBy: user._id, emailVerifiedAt: { $exists: true } }),
    ctx.c.users.countDocuments({ referredBy: user._id, referralRewardedAt: { $exists: true } }),
    getReferralSettings(ctx),
  ]);
  return {
    code,
    url: referralUrl(ctx, code),
    signups,
    confirmed,
    rewarded,
    reward: settings.enabled ? { bonusDays: settings.bonusDays, maxRewards: settings.maxRewardsPerUser, remaining: Math.max(0, settings.maxRewardsPerUser - rewarded) } : null,
  };
}

/**
 * Adds days to a user's free license. Expiry is signed into the key, so this issues a new key that runs `days` past
 * the current one, and e-mails it. The old key is not revoked: it keeps working to its own date, so the app never
 * locks someone out who has not pasted the new key yet. With no active free key, the days wait on the account and
 * go into their next free key (renewal or first grant).
 */
async function addBonusDays(ctx: Ctx, user: UserDoc, days: number, friendName: string): Promise<void> {
  const now = ctx.now();
  const active = await ctx.c.licenses
    .find({ userId: user._id, source: 'free', revokedAt: { $exists: false }, expiresAt: { $gt: now } })
    .sort({ expiresAt: -1 })
    .limit(1)
    .next();
  const accountUrl = `${ctx.config.webUrl}/account`;
  if (!active) {
    await ctx.c.users.updateOne({ _id: user._id }, { $inc: { bonusDays: days } });
    await ctx.mailer.send(templates.referralReward(user.email, { name: user.name, friendName, days, accountUrl }));
    return;
  }
  const fresh = await issueLicense(ctx, {
    source: 'free',
    email: user.email,
    customer: customerFor(user),
    edition: active.payload.edition,
    features: active.payload.features,
    durationDays: remainingDays(active, now) + days,
    userId: user._id,
    actor: { id: user._id, email: user.email },
  });
  await ctx.mailer.send(
    templates.referralReward(user.email, { name: user.name, friendName, days, accountUrl, key: fresh.key, expiresAt: fresh.payload.expiresAt }),
  );
}

/**
 * Called when an invited user confirms their e-mail, before their free key is issued: their own reward is banked so
 * it goes straight into that first key, and the inviter gets theirs now. Paid once per invited user.
 */
export async function rewardReferral(ctx: Ctx, user: UserDoc): Promise<void> {
  if (!user.referredBy || user.referralRewardedAt || !user.emailVerifiedAt) return;
  const settings = await getReferralSettings(ctx);
  if (!settings.enabled || settings.bonusDays <= 0) return;
  const inviter = await ctx.c.users.findOne({ _id: user.referredBy });
  if (!inviter?.emailVerifiedAt) return;
  const earned = await ctx.c.users.countDocuments({ referredBy: inviter._id, referralRewardedAt: { $exists: true } });
  if (earned >= settings.maxRewardsPerUser) return;
  const claimed = await ctx.c.users.findOneAndUpdate(
    { _id: user._id, referralRewardedAt: { $exists: false } },
    { $set: { referralRewardedAt: ctx.now() }, $inc: { bonusDays: settings.bonusDays } },
  );
  if (!claimed) return;
  await addBonusDays(ctx, inviter, settings.bonusDays, firstName(user.name));
  await audit(ctx, { id: user._id, email: user.email }, 'referral.reward', {
    target: { type: 'user', id: inviter._id, email: inviter.email },
    details: { invitedUserId: user._id, bonusDays: settings.bonusDays },
  });
}
