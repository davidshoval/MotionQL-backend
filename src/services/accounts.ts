import type { Ctx } from '../context.js';
import type { Attribution, EmailTokenPurpose, UserDoc } from '../db.js';
import { AppError, badRequest, conflict, unauthorized } from '../errors.js';
import { isDisposableEmail } from '../lib/disposable.js';
import { newId } from '../lib/ids.js';
import { dummyHash, hashPassword, verifyPassword } from '../lib/password.js';
import { addDays } from '../lib/time.js';
import { hashToken, newToken } from '../lib/tokens.js';
import { audit } from './audit.js';
import { templates } from './email.js';
import { grantFreeLicense } from './licenses.js';
import { newReferralCode, referrerForCode, rewardReferral } from './referrals.js';

const HOUR_MS = 60 * 60 * 1000;
const TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = { 'verify-email': 24 * HOUR_MS, 'password-reset': HOUR_MS };

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export interface UserView {
  id: string;
  email: string;
  name: string;
  company?: string;
  emailVerified: boolean;
  isStaff: boolean;
  createdAt: string;
}

export const userView = (u: UserDoc): UserView => ({
  id: u._id,
  email: u.email,
  name: u.name,
  ...(u.company ? { company: u.company } : {}),
  emailVerified: Boolean(u.emailVerifiedAt),
  isStaff: u.isStaff,
  createdAt: u.createdAt.toISOString(),
});

async function issueEmailToken(ctx: Ctx, userId: string, purpose: EmailTokenPurpose): Promise<string> {
  // One live token per purpose: a new link invalidates older ones.
  await ctx.c.emailTokens.deleteMany({ userId, purpose });
  const token = newToken();
  const now = ctx.now();
  await ctx.c.emailTokens.insertOne({
    _id: hashToken(token),
    purpose,
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[purpose]),
  });
  return token;
}

/** Consumes a one-time token; TTL indexes delete expired ones eventually, so expiry is also checked here. */
async function consumeEmailToken(ctx: Ctx, token: string, purpose: EmailTokenPurpose): Promise<string> {
  const doc = await ctx.c.emailTokens.findOneAndDelete({ _id: hashToken(token), purpose });
  if (!doc || doc.expiresAt <= ctx.now()) throw badRequest('invalid_token', 'This link is invalid or has expired. Ask for a new one.');
  return doc.userId;
}

/** Grants staff to the e-mails listed in STAFF_EMAILS, once their address is verified. */
async function applyStaffList(ctx: Ctx, user: UserDoc): Promise<UserDoc> {
  if (user.isStaff || !user.emailVerifiedAt || !ctx.config.staffEmails.includes(user.email)) return user;
  await ctx.c.users.updateOne({ _id: user._id }, { $set: { isStaff: true, updatedAt: ctx.now() } });
  await audit(ctx, { id: user._id, email: user.email }, 'staff.grant', { target: { type: 'user', id: user._id, email: user.email }, details: { via: 'STAFF_EMAILS' } });
  return { ...user, isStaff: true };
}

async function sendVerification(ctx: Ctx, user: UserDoc): Promise<void> {
  const token = await issueEmailToken(ctx, user._id, 'verify-email');
  const url = `${ctx.config.webUrl}/verify-email?token=${encodeURIComponent(token)}`;
  await ctx.mailer.send(templates.verifyEmail(user.email, user.name, url));
}

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  company?: string;
  /** The code from an invite link (motionql.com/r/CODE); an unknown code is ignored. */
  referralCode?: string;
  /** "How did you hear about us?" (optional). */
  heardFrom?: string;
  /** First-touch utm_* tags, landing path and referring host, recorded by the website. */
  attribution?: Attribution;
}

const ATTRIBUTION_FIELDS = ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'landingPath', 'referrerHost'] as const;

/** Keeps the non-empty fields; undefined when none is left. Hosts are lower-cased so the report groups them. */
export function cleanAttribution(input: Attribution | undefined): Attribution | undefined {
  if (!input) return undefined;
  const out: Attribution = {};
  for (const key of ATTRIBUTION_FIELDS) {
    const value = input[key]?.trim();
    if (value) out[key] = key === 'referrerHost' ? value.toLowerCase() : value;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function register(ctx: Ctx, input: RegisterInput): Promise<UserDoc> {
  const email = normalizeEmail(input.email);
  if (isDisposableEmail(email)) {
    throw badRequest('validation_failed', 'Please use a permanent e-mail address.', { email: 'Disposable e-mail addresses are not accepted.' });
  }
  const referrer = await referrerForCode(ctx, input.referralCode);
  const heardFrom = input.heardFrom?.trim();
  const attribution = cleanAttribution(input.attribution);
  const now = ctx.now();
  const user: UserDoc = {
    _id: newId('usr'),
    email,
    name: input.name.trim(),
    ...(input.company?.trim() ? { company: input.company.trim() } : {}),
    passwordHash: await hashPassword(input.password),
    isStaff: false,
    referralCode: newReferralCode(),
    ...(referrer ? { referredBy: referrer._id } : {}),
    ...(heardFrom ? { heardFrom } : {}),
    ...(attribution ? { attribution } : {}),
    createdAt: now,
    updatedAt: now,
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await ctx.c.users.insertOne(user);
      break;
    } catch (error) {
      const e = error as { code?: number; keyPattern?: Record<string, unknown> };
      // A clash on the random invite code (1 in 32^8 per account): pick another.
      if (e.code === 11000 && e.keyPattern?.referralCode && attempt < 4) {
        user.referralCode = newReferralCode();
        continue;
      }
      if (e.code === 11000) {
        throw conflict('email_taken', 'An account with this e-mail already exists. Sign in or reset your password.');
      }
      throw error;
    }
  }
  await audit(ctx, { id: user._id, email }, 'user.register', {
    target: { type: 'user', id: user._id, email },
    ...(referrer ? { details: { referredBy: referrer._id } } : {}),
  });
  await sendVerification(ctx, user);
  return user;
}

/** Always succeeds, so the endpoint cannot be used to find out which e-mails have accounts. */
export async function resendVerification(ctx: Ctx, rawEmail: string): Promise<void> {
  const user = await ctx.c.users.findOne({ email: normalizeEmail(rawEmail) });
  if (user && !user.emailVerifiedAt) await sendVerification(ctx, user);
}

/** Marks the e-mail verified and grants the free-plan key (with an e-mail carrying it). */
export async function verifyEmail(ctx: Ctx, token: string): Promise<UserDoc> {
  const userId = await consumeEmailToken(ctx, token, 'verify-email');
  let user = await ctx.c.users.findOneAndUpdate(
    { _id: userId },
    [{ $set: { emailVerifiedAt: { $ifNull: ['$emailVerifiedAt', ctx.now()] }, updatedAt: ctx.now() } }],
    { returnDocument: 'after' },
  );
  if (!user) throw badRequest('invalid_token', 'This link is invalid or has expired.');
  user = await applyStaffList(ctx, user);
  await audit(ctx, { id: user._id, email: user.email }, 'user.verify_email', { target: { type: 'user', id: user._id, email: user.email } });
  // Before the free key, so the invited user's own reward goes into that first key.
  await rewardReferral(ctx, user);
  const license = await grantFreeLicense(ctx, user);
  if (license) {
    await ctx.mailer.send(
      templates.licenseKey(user.email, {
        name: user.name,
        key: license.key,
        edition: license.payload.edition,
        expiresAt: license.payload.expiresAt,
        accountUrl: `${ctx.config.webUrl}/account/licenses`,
      }),
    );
  }
  return user;
}

export async function login(ctx: Ctx, rawEmail: string, password: string): Promise<UserDoc> {
  const user = await ctx.c.users.findOne({ email: normalizeEmail(rawEmail) });
  const ok = await verifyPassword(user?.passwordHash ?? (await dummyHash()), password);
  if (!user || !ok) throw unauthorized('E-mail or password is not correct.');
  if (!user.emailVerifiedAt) throw new AppError(403, 'email_not_verified', 'Confirm your e-mail first. We can send the link again.');
  return applyStaffList(ctx, user);
}

export async function requestPasswordReset(ctx: Ctx, rawEmail: string): Promise<void> {
  const user = await ctx.c.users.findOne({ email: normalizeEmail(rawEmail) });
  if (!user) return;
  const token = await issueEmailToken(ctx, user._id, 'password-reset');
  await ctx.mailer.send(templates.passwordReset(user.email, `${ctx.config.webUrl}/reset-password?token=${encodeURIComponent(token)}`));
}

/** Sets the new password, signs out every session, and counts as e-mail verification (the link proved the inbox). */
export async function resetPassword(ctx: Ctx, token: string, password: string): Promise<UserDoc> {
  const userId = await consumeEmailToken(ctx, token, 'password-reset');
  const now = ctx.now();
  const user = await ctx.c.users.findOneAndUpdate(
    { _id: userId },
    // $literal: an argon2 hash starts with '$', which a pipeline would read as a field path.
    [{ $set: { passwordHash: { $literal: await hashPassword(password) }, emailVerifiedAt: { $ifNull: ['$emailVerifiedAt', now] }, updatedAt: now } }],
    { returnDocument: 'after' },
  );
  if (!user) throw badRequest('invalid_token', 'This link is invalid or has expired.');
  await ctx.c.sessions.deleteMany({ userId });
  await audit(ctx, { id: user._id, email: user.email }, 'user.password_reset', { target: { type: 'user', id: user._id, email: user.email } });
  return user;
}

// Sessions: the cookie holds a random token; the database holds only its hash.

export async function createSession(ctx: Ctx, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const now = ctx.now();
  const expiresAt = addDays(now, ctx.config.sessionDays);
  await ctx.c.sessions.insertOne({ _id: hashToken(token), userId, createdAt: now, lastSeenAt: now, expiresAt });
  return { token, expiresAt };
}

export async function userForSession(ctx: Ctx, token: string): Promise<UserDoc | undefined> {
  const now = ctx.now();
  const session = await ctx.c.sessions.findOne({ _id: hashToken(token), expiresAt: { $gt: now } });
  if (!session) return undefined;
  // Touch at most hourly to keep writes low.
  if (now.getTime() - session.lastSeenAt.getTime() > HOUR_MS) {
    await ctx.c.sessions.updateOne({ _id: session._id }, { $set: { lastSeenAt: now } });
  }
  return (await ctx.c.users.findOne({ _id: session.userId })) ?? undefined;
}

export async function deleteSession(ctx: Ctx, token: string): Promise<void> {
  await ctx.c.sessions.deleteOne({ _id: hashToken(token) });
}

export async function changePassword(ctx: Ctx, user: UserDoc, current: string, next: string, keepToken: string): Promise<void> {
  if (!(await verifyPassword(user.passwordHash, current))) throw badRequest('wrong_password', 'Your current password is not correct.');
  await ctx.c.users.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(next), updatedAt: ctx.now() } });
  await ctx.c.sessions.deleteMany({ userId: user._id, _id: { $ne: hashToken(keepToken) } });
  await audit(ctx, { id: user._id, email: user.email }, 'user.password_change', { target: { type: 'user', id: user._id, email: user.email } });
}

export async function updateProfile(ctx: Ctx, user: UserDoc, patch: { name?: string; company?: string | null }): Promise<UserDoc> {
  const $set: Partial<UserDoc> = { updatedAt: ctx.now() };
  const $unset: Record<string, ''> = {};
  if (patch.name !== undefined) $set.name = patch.name.trim();
  if (patch.company === null || patch.company?.trim() === '') $unset.company = '';
  else if (patch.company !== undefined) $set.company = patch.company.trim();
  const updated = await ctx.c.users.findOneAndUpdate(
    { _id: user._id },
    { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
    { returnDocument: 'after' },
  );
  return updated!;
}

/** Cloudflare Turnstile, only when TURNSTILE_SECRET is set. */
export async function checkTurnstile(ctx: Ctx, token: string | undefined, ip: string): Promise<void> {
  if (!ctx.config.turnstileSecret) return;
  if (!token) throw badRequest('captcha_failed', 'Please complete the check that you are human.');
  const res = await ctx.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: ctx.config.turnstileSecret, response: token, remoteip: ip }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean };
  if (!body.success) throw badRequest('captcha_failed', 'The human check failed. Please try again.');
}
