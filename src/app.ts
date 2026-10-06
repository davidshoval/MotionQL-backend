import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import type { Collections } from './db.js';
import { AppError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { feedbackRoutes } from './routes/feedback.js';
import { meRoutes } from './routes/me.js';
import { productRoutes } from './routes/product.js';
import { teamRoutes } from './routes/teams.js';
import type { Mailer } from './services/email.js';
import { createMailer } from './services/email.js';

export interface AppDeps {
  config: Config;
  collections: Collections;
  mailer?: Mailer;
  now?: () => Date;
  fetch?: typeof fetch;
  logger?: boolean;
}

/** Paths the desktop app calls; it sends no Origin and no cookies, so the browser-only checks skip them. */
const APP_PATHS = /^\/v1\//;

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const { config } = deps;
  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : {
            level: config.logLevel,
            // Never log cookies, auth headers or tokens; never log client IPs for the usage ping (privacy promise).
            redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
            serializers: {
              req: (req) => ({ method: req.method, url: req.url.replace(/token=[^&]+/g, 'token=…') }),
            },
          },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  const ctx: Ctx = {
    c: deps.collections,
    config,
    mailer: deps.mailer ?? createMailer(config, app.log),
    now: deps.now ?? (() => new Date()),
    log: app.log,
    fetch: deps.fetch ?? fetch,
  };

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.webOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    max: config.rateLimit.perMinute,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) =>
      new AppError(429, 'rate_limited', `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`),
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'MotionQL API', version: '0.1.0', description: 'Accounts, license keys, teams, staff console and the desktop app product service.' },
      servers: [{ url: 'https://api.motionql.com' }],
    },
    transform: jsonSchemaTransform,
  });

  // CSRF: the session cookie is SameSite=Lax and every write needs a JSON body or no body, which a cross-site form
  // cannot send without a CORS preflight. On top of that, a browser request from an unknown Origin is refused.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || APP_PATHS.test(req.url)) return;
    const origin = req.headers.origin;
    if (origin && !config.webOrigins.includes(origin)) throw new AppError(403, 'bad_origin', 'Requests from this site are not allowed.');
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const fields: Record<string, string> = {};
      for (const issue of error.validation) {
        const key = issue.instancePath.replace(/^\//, '').replace(/\//g, '.') || String((issue.params as { issue?: { path?: unknown[] } })?.issue?.path?.join('.') ?? '') || '_';
        fields[key] ??= issue.message ?? 'Invalid value.';
      }
      return reply.code(400).send({ error: { code: 'validation_failed', message: 'Some fields are not valid.', fields } });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: error }, 'request failed');
      return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on our side. Please try again.' } });
    }
    return reply.code(status).send({ error: { code: (error as { code?: string }).code?.toLowerCase() ?? 'bad_request', message: (error as Error).message } });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } }));

  await app.register(authRoutes(ctx));
  await app.register(meRoutes(ctx));
  await app.register(teamRoutes(ctx));
  await app.register(adminRoutes(ctx));
  await app.register(productRoutes(ctx));
  await app.register(feedbackRoutes(ctx));

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return { app, ctx };
}
