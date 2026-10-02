import { createPublicKey, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyLicense } from '../src/licensing/licenseFormat.js';
import { Client, makeApp, signUp, tokenFrom } from './helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

describe('registration and the free key', () => {
  it('registers, verifies the e-mail, signs in and issues a 1-year Pro key the app accepts', async () => {
    const client = new Client(t);
    const reg = await client.post('/auth/register', { email: 'Ada@Example.com ', password: 'correct horse battery', name: 'Ada', company: 'Analytical Ltd' });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().user).toMatchObject({ email: 'ada@example.com', emailVerified: false });
    expect(client.cookie).toBeUndefined();

    // Not verified yet: no key, no sign-in.
    expect((await client.post('/auth/login', { email: 'ada@example.com', password: 'correct horse battery' })).json().error.code).toBe('email_not_verified');

    const mail = t.mailer.last('ada@example.com')!;
    expect(mail.text).toContain('https://motionql.com/verify-email?token=');
    const verified = await client.post('/auth/verify-email', { token: tokenFrom(mail.text) });
    expect(verified.statusCode).toBe(200);
    expect(client.cookie).toBeDefined();

    const me = await client.get('/me');
    expect(me.json().user).toMatchObject({ email: 'ada@example.com', emailVerified: true, isStaff: false });

    const { licenses } = (await client.get('/me/licenses')).json();
    expect(licenses).toHaveLength(1);
    const lic = licenses[0];
    expect(lic).toMatchObject({ edition: 'pro', features: [], seats: 1, status: 'active', source: 'free', email: 'ada@example.com', customer: 'Analytical Ltd' });
    expect(lic.licenseId).toMatch(/^lic_[0-9A-Z]{26}$/);
    expect(lic.issuedAt).toBe('2026-10-01T12:00:00.000Z');
    expect(lic.expiresAt).toBe('2027-10-01T12:00:00.000Z');

    // The key verifies with the app's own code and the matching public key...
    const result = verifyLicense(lic.key, t.ctx.config.publicKeyBase64);
    expect(result.ok).toBe(true);
    // ...and independently: XQ1.<base64url payload>.<base64url Ed25519 signature over the payload bytes>.
    const [prefix, payload, sig] = lic.key.split('.');
    expect(prefix).toBe('XQ1');
    const pub = createPublicKey({ key: Buffer.from(t.ctx.config.publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(payload, 'base64url'), pub, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(Object.keys(JSON.parse(Buffer.from(payload, 'base64url').toString())).sort()).toEqual(
      ['customer', 'edition', 'email', 'expiresAt', 'features', 'issuedAt', 'licenseId', 'seats'].sort(),
    );

    // The key is also e-mailed.
    expect(t.mailer.last('ada@example.com')!.text).toContain(lic.key);
  });

  it('does not issue a second free key when the link is used twice or the user verifies again', async () => {
    const client = await signUp(t, 'bob@example.com');
    expect((await client.post('/auth/verify-email', { token: 'x'.repeat(43) })).json().error.code).toBe('invalid_token');
    expect((await client.get('/me/licenses')).json().licenses).toHaveLength(1);
  });

  it('rejects duplicates, disposable addresses and bad input with field errors', async () => {
    await signUp(t, 'carol@example.com');
    const client = new Client(t);
    const dup = await client.post('/auth/register', { email: 'CAROL@example.com', password: 'correct horse battery', name: 'C' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('email_taken');

    const disposable = await client.post('/auth/register', { email: 'x@mailinator.com', password: 'correct horse battery', name: 'X' });
    expect(disposable.statusCode).toBe(400);
    expect(disposable.json().error.fields.email).toBeDefined();

    const bad = await client.post('/auth/register', { email: 'not-an-email', password: 'short', name: '' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_failed');
    expect(Object.keys(bad.json().error.fields).sort()).toEqual(['email', 'name', 'password']);
  });

  it('signs in, signs out and refuses a wrong password without saying which part was wrong', async () => {
    await signUp(t, 'dan@example.com');
    const client = new Client(t);
    const wrong = await client.post('/auth/login', { email: 'dan@example.com', password: 'nope nope nope' });
    expect(wrong.statusCode).toBe(401);
    const unknown = await client.post('/auth/login', { email: 'nobody@example.com', password: 'nope nope nope' });
    expect(unknown.json().error.message).toBe(wrong.json().error.message);

    expect((await client.post('/auth/login', { email: 'DAN@example.com', password: 'correct horse battery' })).statusCode).toBe(200);
    expect((await client.get('/me')).statusCode).toBe(200);
    expect((await client.post('/auth/logout')).statusCode).toBe(204);
    expect((await client.get('/me')).statusCode).toBe(401);
  });

  it('resets a password with a one-time link and signs out other sessions', async () => {
    const first = await signUp(t, 'eve@example.com');
    const anon = new Client(t);
    expect((await anon.post('/auth/password-reset/request', { email: 'eve@example.com' })).statusCode).toBe(204);
    expect((await anon.post('/auth/password-reset/request', { email: 'ghost@example.com' })).statusCode).toBe(204);
    const token = tokenFrom(t.mailer.last('eve@example.com')!.text);
    expect((await anon.post('/auth/password-reset/confirm', { token, password: 'a brand new password' })).statusCode).toBe(204);
    expect((await anon.post('/auth/password-reset/confirm', { token, password: 'another new password' })).statusCode).toBe(400);
    expect((await first.get('/me')).statusCode).toBe(401);
    expect((await anon.post('/auth/login', { email: 'eve@example.com', password: 'a brand new password' })).statusCode).toBe(200);
  });

  it('expires verification links after 24 hours', async () => {
    const client = new Client(t);
    await client.post('/auth/register', { email: 'fay@example.com', password: 'correct horse battery', name: 'Fay' });
    const token = tokenFrom(t.mailer.last('fay@example.com')!.text);
    t.clock.advanceDays(2);
    expect((await client.post('/auth/verify-email', { token })).json().error.code).toBe('invalid_token');
    await client.post('/auth/resend-verification', { email: 'fay@example.com' });
    expect((await client.post('/auth/verify-email', { token: tokenFrom(t.mailer.last('fay@example.com')!.text) })).statusCode).toBe(200);
  });

  it('sets a SameSite=Lax cookie by default and SameSite=None; Secure when the site is on another domain', async () => {
    await signUp(t, 'lax@example.com');
    const login = await t.app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://motionql.com' }, payload: { email: 'lax@example.com', password: 'correct horse battery' } });
    expect(login.cookies[0]).toMatchObject({ name: 'mq_session', sameSite: 'Lax', httpOnly: true });

    const other = await makeApp({ env: { COOKIE_SAME_SITE: 'none' } });
    try {
      await signUp(other, 'none@example.com');
      const res = await other.app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://motionql.com' }, payload: { email: 'none@example.com', password: 'correct horse battery' } });
      expect(res.cookies[0]).toMatchObject({ name: 'mq_session', sameSite: 'None', secure: true, httpOnly: true });
    } finally {
      await other.close();
    }
  });

  it('refuses writes from a site that is not the website', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://evil.example' }, payload: { email: 'a@b.co', password: 'x' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('bad_origin');
  });
});

describe('free key renewal and reissue', () => {
  it('renews only inside the renewal window and reissues a lost key', async () => {
    const client = await signUp(t, 'gus@example.com');
    const early = await client.post('/me/licenses/renew');
    expect(early.statusCode).toBe(409);
    expect(early.json().error.message).toContain('2027-09-01');

    t.clock.advanceDays(340);
    // Sessions last 30 days; sign in again.
    expect((await client.post('/auth/login', { email: 'gus@example.com', password: 'correct horse battery' })).statusCode).toBe(200);
    const renewed = await client.post('/me/licenses/renew');
    expect(renewed.statusCode).toBe(201);
    expect(renewed.json().license.expiresAt).toBe('2028-09-05T12:00:00.000Z');

    const old = (await client.get('/me/licenses')).json().licenses[1];
    const reissued = await client.post(`/me/licenses/${old.licenseId}/reissue`);
    expect(reissued.statusCode).toBe(201);
    expect(reissued.json().license.expiresAt).toBe('2027-10-01T12:00:00.000Z');
    const after = (await client.get('/me/licenses')).json().licenses;
    expect(after.find((l: { licenseId: string }) => l.licenseId === old.licenseId).status).toBe('replaced');
  });
});
