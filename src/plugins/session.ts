import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor, Ctx } from '../context.js';
import type { UserDoc } from '../db.js';
import { forbidden, unauthorized } from '../errors.js';
import { createSession, userForSession } from '../services/accounts.js';

// Cookie name kept from the Xquery name: renaming it would sign everyone out.
export const SESSION_COOKIE = 'xq_session';

declare module 'fastify' {
  interface FastifyRequest {
    /** undefined = not looked up yet; null = no valid session. */
    sessionUser?: UserDoc | null;
  }
}

export async function currentUser(ctx: Ctx, req: FastifyRequest): Promise<UserDoc | null> {
  if (req.sessionUser !== undefined) return req.sessionUser;
  const token = req.cookies[SESSION_COOKIE];
  req.sessionUser = token ? ((await userForSession(ctx, token)) ?? null) : null;
  return req.sessionUser;
}

export async function requireUser(ctx: Ctx, req: FastifyRequest): Promise<UserDoc> {
  const user = await currentUser(ctx, req);
  if (!user) throw unauthorized();
  return user;
}

export async function requireStaff(ctx: Ctx, req: FastifyRequest): Promise<UserDoc> {
  const user = await requireUser(ctx, req);
  if (!user.isStaff) throw forbidden('Staff only.');
  return user;
}

export const actorOf = (user: UserDoc): Actor => ({ id: user._id, email: user.email, isStaff: user.isStaff });

const cookieOptions = (ctx: Ctx) => ({
  path: '/',
  httpOnly: true,
  secure: ctx.config.cookieSecure,
  sameSite: ctx.config.cookieSameSite,
  ...(ctx.config.cookieDomain ? { domain: ctx.config.cookieDomain } : {}),
});

export async function startSession(ctx: Ctx, reply: FastifyReply, userId: string): Promise<void> {
  const { token, expiresAt } = await createSession(ctx, userId);
  reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions(ctx), expires: expiresAt });
}

export function clearSessionCookie(ctx: Ctx, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(ctx));
}
