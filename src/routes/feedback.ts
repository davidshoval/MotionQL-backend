import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { actorOf, currentUser, requireStaff } from '../plugins/session.js';
import { FEEDBACK_KINDS, FEEDBACK_STATUSES, listFeedback, setFeedbackStatus, submitFeedback } from '../services/feedback.js';
import { email, id, limit } from './schemas.js';

const kind = z.enum(FEEDBACK_KINDS);
const message = z.string().trim().min(3, 'Write a few words.').max(5000, 'Keep it under 5000 characters.');
// Empty string = left blank in a form.
const replyTo = z.union([z.literal(''), email]).optional();

/**
 * Feedback from the website form (POST /feedback, attaches the signed-in user) and from the app's
 * Help > Send feedback (POST /v1/feedback, no cookies). Both are stored and e-mailed to STAFF_EMAILS.
 */
export const feedbackRoutes = (ctx: Ctx): FastifyPluginAsyncZod => async (app) => {
  const strict = { config: { rateLimit: { max: ctx.config.rateLimit.authPerMinute, timeWindow: '1 minute' } } };

  app.post('/feedback', {
    ...strict,
    schema: {
      tags: ['feedback'],
      body: z.object({
        kind,
        message,
        email: replyTo,
        page: z.string().trim().max(200).regex(/^\//).optional(),
        // A field people never see; bots fill it in. Such a message is accepted and dropped.
        website: z.string().max(500).optional(),
      }),
    },
  }, async (req, reply) => {
    const { website, ...input } = req.body;
    if (website) return reply.code(204).send();
    await submitFeedback(ctx, 'website', input, await currentUser(ctx, req));
    return reply.code(204).send();
  });

  app.post('/v1/feedback', {
    ...strict,
    bodyLimit: 16 * 1024,
    schema: {
      tags: ['product'],
      body: z.object({
        kind,
        message,
        email: replyTo,
        app: z.object({
          version: z.string().regex(/^\d+\.\d+\.\d+[\w.+-]{0,24}$/),
          platform: z.enum(['darwin', 'win32', 'linux']),
          arch: z.string().regex(/^[a-z0-9_]{1,16}$/),
          channel: z.string().regex(/^[a-z]{1,16}$/).optional(),
          edition: z.string().regex(/^[a-z]{1,16}$/).optional(),
        }),
      }).strict(),
    },
  }, async (req, reply) => {
    await submitFeedback(ctx, 'app', req.body);
    return reply.code(204).send();
  });

  app.get('/admin/feedback', {
    schema: { tags: ['admin'], querystring: z.object({ status: z.enum(FEEDBACK_STATUSES).optional(), before: id.optional(), limit }) },
  }, async (req) => {
    await requireStaff(ctx, req);
    return listFeedback(ctx, req.query);
  });

  app.patch('/admin/feedback/:feedbackId', {
    schema: { tags: ['admin'], params: z.object({ feedbackId: id }), body: z.object({ status: z.enum(FEEDBACK_STATUSES) }) },
  }, async (req) => {
    const staff = await requireStaff(ctx, req);
    return { feedback: await setFeedbackStatus(ctx, actorOf(staff), req.params.feedbackId, req.body.status) };
  });
};
