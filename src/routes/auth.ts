import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { clearSessionCookie, requireUser, SESSION_COOKIE, startSession } from '../plugins/session.js';
import {
  changePassword, checkTurnstile, deleteSession, login, register, requestPasswordReset, resendVerification, resetPassword, userView, verifyEmail,
} from '../services/accounts.js';
import { company, email, heardFrom, password, personName, token } from './schemas.js';

export const authRoutes = (ctx: Ctx): FastifyPluginAsyncZod => async (app) => {
  const strict = { config: { rateLimit: { max: ctx.config.rateLimit.authPerMinute, timeWindow: '1 minute' } } };

  app.post('/auth/register', {
    ...strict,
    schema: { tags: ['auth'], body: z.object({
        email, password, name: personName, company: company.optional(), turnstileToken: z.string().max(4096).optional(),
        referralCode: z.string().max(32).optional(), heardFrom,
      }) },
  }, async (req, reply) => {
    await checkTurnstile(ctx, req.body.turnstileToken, req.ip);
    const user = await register(ctx, req.body);
    return reply.code(201).send({ user: userView(user) });
  });

  // Verifying signs the user in, so the website can go straight to /account.
  app.post('/auth/verify-email', { ...strict, schema: { tags: ['auth'], body: z.object({ token }) } }, async (req, reply) => {
    const user = await verifyEmail(ctx, req.body.token);
    await startSession(ctx, reply, user._id);
    return { user: userView(user) };
  });

  app.post('/auth/resend-verification', { ...strict, schema: { tags: ['auth'], body: z.object({ email }) } }, async (req, reply) => {
    await resendVerification(ctx, req.body.email);
    return reply.code(204).send();
  });

  app.post('/auth/login', { ...strict, schema: { tags: ['auth'], body: z.object({ email, password: z.string().min(1).max(200) }) } }, async (req, reply) => {
    const user = await login(ctx, req.body.email, req.body.password);
    await startSession(ctx, reply, user._id);
    return { user: userView(user) };
  });

  app.post('/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) await deleteSession(ctx, t);
    clearSessionCookie(ctx, reply);
    return reply.code(204).send();
  });

  app.post('/auth/password-reset/request', { ...strict, schema: { tags: ['auth'], body: z.object({ email }) } }, async (req, reply) => {
    await requestPasswordReset(ctx, req.body.email);
    return reply.code(204).send();
  });

  app.post('/auth/password-reset/confirm', { ...strict, schema: { tags: ['auth'], body: z.object({ token, password }) } }, async (req, reply) => {
    await resetPassword(ctx, req.body.token, req.body.password);
    clearSessionCookie(ctx, reply);
    return reply.code(204).send();
  });

  app.post('/auth/change-password', { ...strict, schema: { tags: ['auth'], body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }) } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    await changePassword(ctx, user, req.body.currentPassword, req.body.newPassword, req.cookies[SESSION_COOKIE]!);
    return reply.code(204).send();
  });
};
