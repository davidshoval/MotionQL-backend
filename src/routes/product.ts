import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Ctx } from '../context.js';
import { latestRelease } from '../services/downloads.js';
import { currentManifestToken, recordPing } from '../services/product.js';

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

  app.get('/downloads/latest', { schema: { tags: ['public'] } }, async (_req, reply) => {
    const release = await latestRelease(ctx);
    return reply.header('cache-control', 'public, max-age=300').send(release);
  });

  app.get('/health', { logLevel: 'warn', schema: { tags: ['public'] } }, async () => {
    await ctx.c.users.findOne({}, { projection: { _id: 1 } });
    return { ok: true };
  });
};
