import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const list = z
  .string()
  .optional()
  .transform((v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Behind a proxy (Fly, Render, a load balancer): trust X-Forwarded-For for rate limits. */
  TRUST_PROXY: bool,

  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017'),
  MONGODB_DB: z.string().min(1).default('xquery'),

  /** Public website origin used in e-mail links, e.g. https://xquery.io */
  WEB_URL: z.string().url().default('http://localhost:3000'),
  /** Origins allowed to call the API with cookies. Defaults to WEB_URL's origin. */
  WEB_ORIGINS: list,
  /** Cookie domain shared by xquery.io and api.xquery.io, e.g. .xquery.io. Empty = host-only cookie. */
  COOKIE_DOMAIN: z.string().optional(),
  /**
   * lax (default) when the site and the API share a registrable domain (xquery.io + api.xquery.io).
   * none when they do not, e.g. two *.onrender.com hosts before custom domains are set up (needs HTTPS).
   */
  COOKIE_SAME_SITE: z.enum(['lax', 'none']).default('lax'),
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /** Ed25519 private key (PEM) that signs license keys and the manifest. Or LICENSE_SIGNING_KEY_FILE. */
  LICENSE_SIGNING_KEY: z.string().optional(),
  LICENSE_SIGNING_KEY_FILE: z.string().optional(),
  LICENSE_SIGNING_KEY_PASSPHRASE: z.string().optional(),

  /** E-mail: "console" logs messages (development); "resend" sends through Resend; "smtp" through any SMTP server (Gmail). */
  EMAIL_PROVIDER: z.enum(['console', 'resend', 'smtp']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  /** SMTP; the defaults fit Gmail: SMTP_USER is the Gmail address, SMTP_PASS a Google app password. */
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** Defaults to Xquery <SMTP_USER> with smtp, else Xquery <hello@xquery.io>. */
  EMAIL_FROM: z.string().optional(),

  /** E-mails that become staff when they sign in or verify (for hosts without a shell, e.g. Render's free plan). */
  STAFF_EMAILS: list,
  /** Cloudflare Turnstile secret; when set, /auth/register requires a valid turnstileToken. */
  TURNSTILE_SECRET: z.string().optional(),

  /** Public GitHub repo whose latest release is the download source. */
  RELEASES_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default('davidshoval/Xquery.io-releases'),
  /** Optional token for the GitHub API (raises the rate limit); read-only, public repos only. */
  GITHUB_TOKEN: z.string().optional(),

  /** Requests per minute per IP, overall and for sign-in style endpoints. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
});

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: string;
  trustProxy: boolean;
  mongoUri: string;
  mongoDb: string;
  webUrl: string;
  webOrigins: string[];
  cookieDomain?: string;
  cookieSecure: boolean;
  cookieSameSite: 'lax' | 'none';
  sessionDays: number;
  signingKey: KeyObject;
  publicKeyBase64: string;
  email: {
    provider: 'console' | 'resend' | 'smtp';
    resendApiKey?: string;
    smtp?: { host: string; port: number; user: string; pass: string };
    from: string;
  };
  turnstileSecret?: string;
  staffEmails: string[];
  releasesRepo: string;
  githubToken?: string;
  rateLimit: { perMinute: number; authPerMinute: number };
}

/**
 * Rebuilds a PEM whose line breaks were lost or turned into spaces or literal \n, as some dashboards
 * (Render's environment editor) do when a multi-line value is pasted.
 */
export function normalizePem(raw: string): string {
  const text = raw.replace(/\\n/g, '\n').trim();
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!m || !m[2]!.trim()) {
    throw new Error('LICENSE_SIGNING_KEY is not a PEM key: paste the whole file, including the -----BEGIN and -----END lines.');
  }
  const body = m[2]!.replace(/\s+/g, '');
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END ${m[1]}-----\n`;
}

export function loadSigningKey(pem: string, passphrase?: string): KeyObject {
  const normalized = normalizePem(pem);
  let key: KeyObject;
  try {
    key = createPrivateKey(passphrase ? { key: normalized, format: 'pem', passphrase } : normalized);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_OSSL_BAD_DECRYPT') throw new Error('LICENSE_SIGNING_KEY_PASSPHRASE does not unlock LICENSE_SIGNING_KEY.', { cause: err });
    if (code === 'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED' || /passphrase/i.test(String(err))) {
      throw new Error('LICENSE_SIGNING_KEY is encrypted: set LICENSE_SIGNING_KEY_PASSPHRASE.', { cause: err });
    }
    throw new Error(`LICENSE_SIGNING_KEY could not be read (${code ?? 'unknown error'}): paste the whole PEM file.`, { cause: err });
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('LICENSE_SIGNING_KEY must be an Ed25519 private key');
  return key;
}

/** The same base64 SPKI line the app keeps in src/main/licensing/publicKey.ts. */
export function publicKeyBase64(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  const pem = e.LICENSE_SIGNING_KEY ?? (e.LICENSE_SIGNING_KEY_FILE ? readFileSync(e.LICENSE_SIGNING_KEY_FILE, 'utf8') : undefined);
  if (!pem) throw new Error('Set LICENSE_SIGNING_KEY or LICENSE_SIGNING_KEY_FILE (run `npm run keygen:dev` for a development key).');
  const signingKey = loadSigningKey(pem, e.LICENSE_SIGNING_KEY_PASSPHRASE || undefined);
  if (e.NODE_ENV === 'production' && !env.MONGODB_URI) {
    throw new Error('Set MONGODB_URI to your MongoDB Atlas connection string (mongodb+srv://…).');
  }
  if (e.EMAIL_PROVIDER === 'resend' && !e.RESEND_API_KEY) throw new Error('EMAIL_PROVIDER=resend needs RESEND_API_KEY');
  if (e.EMAIL_PROVIDER === 'smtp' && !(e.SMTP_USER && e.SMTP_PASS)) {
    throw new Error('EMAIL_PROVIDER=smtp needs SMTP_USER and SMTP_PASS (for Gmail: the address and an app password).');
  }
  const smtp =
    e.EMAIL_PROVIDER === 'smtp'
      ? { host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER!, pass: e.SMTP_PASS!.replace(/\s+/g, '') }
      : undefined;
  const from = e.EMAIL_FROM || (smtp ? `Xquery <${smtp.user}>` : 'Xquery <hello@xquery.io>');
  const webUrl = e.WEB_URL.replace(/\/+$/, '');
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    mongoUri: e.MONGODB_URI,
    mongoDb: e.MONGODB_DB,
    webUrl,
    webOrigins: e.WEB_ORIGINS.length ? e.WEB_ORIGINS : [new URL(webUrl).origin],
    cookieDomain: e.COOKIE_DOMAIN || undefined,
    // SameSite=None is only accepted on Secure cookies.
    cookieSecure: e.NODE_ENV === 'production' || e.COOKIE_SAME_SITE === 'none',
    cookieSameSite: e.COOKIE_SAME_SITE,
    sessionDays: e.SESSION_DAYS,
    signingKey,
    publicKeyBase64: publicKeyBase64(signingKey),
    email: { provider: e.EMAIL_PROVIDER, resendApiKey: e.RESEND_API_KEY, smtp, from },
    turnstileSecret: e.TURNSTILE_SECRET || undefined,
    staffEmails: e.STAFF_EMAILS.map((x) => x.toLowerCase()),
    releasesRepo: e.RELEASES_REPO,
    githubToken: e.GITHUB_TOKEN || undefined,
    rateLimit: { perMinute: e.RATE_LIMIT_PER_MINUTE, authPerMinute: e.AUTH_RATE_LIMIT_PER_MINUTE },
  };
}
