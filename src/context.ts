import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Collections } from './db.js';
import type { Mailer } from './services/email.js';

/** What every service needs. Tests build one with an in-memory MongoDB, a capturing mailer and a fixed clock. */
export interface Ctx {
  c: Collections;
  config: Config;
  mailer: Mailer;
  now: () => Date;
  log: FastifyBaseLogger;
  fetch: typeof fetch;
}

/** Who is acting, for permission checks and the audit log. */
export interface Actor {
  id: string;
  email: string;
  isStaff: boolean;
}
