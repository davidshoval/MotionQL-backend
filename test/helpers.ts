import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { MongoClient } from 'mongodb';
import { inject } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Ctx } from '../src/context.js';
import { collections, ensureIndexes } from '../src/db.js';
import { MemoryMailer } from '../src/services/email.js';

export const WEB = 'https://motionql.com';

export interface TestApp {
  app: FastifyInstance;
  ctx: Ctx;
  mailer: MemoryMailer;
  clock: { now: Date; advanceDays(days: number): void };
  close(): Promise<void>;
}

let counter = 0;

export async function makeApp(opts: { fetch?: typeof fetch; env?: Record<string, string> } = {}): Promise<TestApp> {
  const { privateKey } = generateKeyPairSync('ed25519');
  const config = loadConfig({
    NODE_ENV: 'test',
    WEB_URL: WEB,
    LICENSE_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    RATE_LIMIT_PER_MINUTE: '100000',
    AUTH_RATE_LIMIT_PER_MINUTE: '100000',
    ...opts.env,
  });
  const client = new MongoClient(inject('mongoUri'));
  await client.connect();
  const db = client.db(`mq_test_${process.pid}_${Date.now()}_${counter++}`);
  const c = collections(db);
  await ensureIndexes(c);
  const mailer = new MemoryMailer();
  const clock = {
    now: new Date('2026-10-01T12:00:00.000Z'),
    advanceDays(days: number) {
      this.now = new Date(this.now.getTime() + days * 86_400_000);
    },
  };
  const { app, ctx } = await buildApp({ config, collections: c, mailer, now: () => clock.now, logger: false, fetch: opts.fetch });
  await app.ready();
  return {
    app,
    ctx,
    mailer,
    clock,
    async close() {
      await app.close();
      await db.dropDatabase();
      await client.close();
    },
  };
}

/** A browser-like client: keeps the session cookie and sends the website's Origin. */
export class Client {
  cookie?: string;
  constructor(private readonly t: TestApp) {}

  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<LightMyRequestResponse> {
    const res = await this.t.app.inject({
      method,
      url,
      headers: { origin: WEB, ...(this.cookie ? { cookie: this.cookie } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    const set = res.cookies.find((c) => c.name === 'mq_session');
    if (set) this.cookie = set.value ? `mq_session=${set.value}` : undefined;
    return res;
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, body);
  put = (url: string, body?: unknown) => this.req('PUT', url, body);
  patch = (url: string, body?: unknown) => this.req('PATCH', url, body);
  del = (url: string) => this.req('DELETE', url);
}

export const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';

/** Registers, verifies and signs in; returns the signed-in client. */
export async function signUp(t: TestApp, email: string, name = 'Test User', extra: Record<string, unknown> = {}): Promise<Client> {
  const client = new Client(t);
  const res = await client.post('/auth/register', { email, password: 'correct horse battery', name, ...extra });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const verify = await client.post('/auth/verify-email', { token: tokenFrom(t.mailer.last(email)!.text) });
  if (verify.statusCode !== 200) throw new Error(`verify failed: ${verify.statusCode} ${verify.body}`);
  return client;
}

export async function makeStaff(t: TestApp, email: string): Promise<Client> {
  const client = await signUp(t, email, 'Staff');
  await t.ctx.c.users.updateOne({ email }, { $set: { isStaff: true } });
  return client;
}
