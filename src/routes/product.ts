import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { USAGE_EVENTS } from '../db.js';
import { latestRelease } from '../services/downloads.js';
import { currentManifestToken, recordPing } from '../services/product.js';
import { recordUsage } from '../services/usage.js';

const MAX_PING_BYTES = 2048;

/** What the desktop app calls (docs/PRODUCT_SERVICE.md), plus the public download list. */
export const productRoutes = (ctx: Ctx): FastifyPluginAsyncZod => async (app) => {
  app.get('/v1/manifest', { schema: { tags: ['product'] } }, async (_req, reply) => {
    const token = await currentManifestToken(ctx);
    return reply.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'no-store').send(token);
  });

  // The app sends no cookies and no Origin; nothing about the request (including the IP) is stored.
  app.post('/v1/ping', { bodyLimit: MAX_PING_BYTES, logLevel: 'warn', schema: { tags: ['product'] } }, async (req, reply) => {
    await recordPing(ctx, req.body);
    return reply.code(204).send();
  });

  // Opt-in usage events (the app sends them only once the user turns them on). No cookies; only the fields below and
  // the server's date are stored, never the IP. Rate-limited per IP like /v1/feedback.
  app.post('/v1/usage', {
    config: { rateLimit: { max: ctx.config.rateLimit.authPerMinute, timeWindow: '1 minute' } },
    bodyLimit: MAX_PING_BYTES,
    logLevel: 'warn',
    schema: {
      tags: ['product'],
      body: z.object({
        installId: z.uuid(),
        appVersion: z.string().max(64).regex(/^\d+\.\d+\.\d+[\w.+-]{0,24}$/),
        os: z.string().regex(/^[a-z0-9_]{1,16}$/),
        arch: z.string().regex(/^[a-z0-9_]{1,16}$/),
        event: z.enum(USAGE_EVENTS),
        licenseId: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Must be the license hash (sha256 hex).').optional(),
      }).strict(),
    },
  }, async (req, reply) => {
    await recordUsage(ctx, req.body);
    return reply.code(204).send();
  });

  app.get('/downloads/latest', { schema: { tags: ['public'] } }, async (_req, reply) => {
    const release = await latestRelease(ctx);
    return reply.header('cache-control', 'public, max-age=300').send(release);
  });

  app.get('/health', { logLevel: 'warn', schema: { tags: ['public'] } }, async () => {
    await ctx.c.users.findOne({}, { projection: { _id: 1 } });
    return { ok: true };
  });
};
