import { afterEach, describe, expect, it } from 'vitest';
import { companyDomain, isFreeMailDomain } from '../src/lib/freeMail.js';
import { licenseHashOf } from '../src/lib/tokens.js';
import { Client, makeApp, makeStaff, signUp } from './helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const PASSWORD = 'correct horse battery';
const newsletter = { utmSource: 'Newsletter', utmMedium: 'email', utmCampaign: 'oct-2026', utmContent: 'hero-link', landingPath: '/mongodb-gui', referrerHost: 'Mail.Example.org' };

let installSeq = 0;
async function activate(t: TestApp, client: Client) {
  const { licenses } = (await client.get('/me/licenses')).json() as { licenses: { licenseId: string }[] };
  const installId = `6f1c2a54-0d1e-4b8a-9c3f-${String(++installSeq).padStart(12, '0')}`;
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/ping',
    payload: { installId, appVersion: '1.4.2', channel: 'stable', platform: 'darwin', arch: 'arm64', edition: 'pro', licenseHash: licenseHashOf(licenses[0]!.licenseId) },
  });
  expect(res.statusCode).toBe(204);
}

describe('free-mail domains', () => {
  it('knows personal mailboxes, including country families', () => {
    for (const d of ['gmail.com', 'Outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.de', 'gmx.net', 'live.com', 'me.com', 'yandex.ru', 'yandex.com', 'mail.com', 'qq.com', '163.com']) {
      expect(isFreeMailDomain(d), d).toBe(true);
    }
    for (const d of ['acme.com', 'gmxtools.io', 'mygmail.com', 'livestream.com', 'mail.acme.com', '']) {
      expect(isFreeMailDomain(d), d).toBe(false);
    }
    expect(companyDomain('Jo@ACME.com')).toBe('acme.com');
    expect(companyDomain('jo@gmail.com')).toBeUndefined();
  });
});

describe('sign-up attribution', () => {
  it('stores the first-touch attribution on the user and shows it to staff', async () => {
    t = await makeApp();
    await signUp(t, 'ann@acme.com', 'Ann', { attribution: { ...newsletter, utmContent: '  ' } });
    const ann = await t.ctx.c.users.findOne({ email: 'ann@acme.com' });
    expect(ann!.attribution).toEqual({ utmSource: 'Newsletter', utmMedium: 'email', utmCampaign: 'oct-2026', landingPath: '/mongodb-gui', referrerHost: 'mail.example.org' });

    // Nothing to keep: no attribution field at all.
    await signUp(t, 'bea@acme.com', 'Bea', { attribution: { utmSource: '' } });
    expect((await t.ctx.c.users.findOne({ email: 'bea@acme.com' }))!.attribution).toBeUndefined();

    const staff = await makeStaff(t, 'staff@motionql.com');
    const detail = (await staff.get(`/admin/users/${ann!._id}`)).json();
    expect(detail.attribution).toMatchObject({ utmSource: 'Newsletter', landingPath: '/mongodb-gui' });
  });

  it('rejects attribution that is too long or not the right shape', async () => {
    t = await makeApp();
    const register = (attribution: unknown) =>
      new Client(t).post('/auth/register', { email: `x${Math.random()}@acme.com`, password: PASSWORD, name: 'X', attribution });
    for (const bad of [
      { utmSource: 'a'.repeat(101) },
      { utmCampaign: 'line\nbreak' },
      { landingPath: 'https://evil.example/' },
      { landingPath: `/${'a'.repeat(300)}` },
      { referrerHost: 'not a host' },
      { referrerHost: 42 },
      'newsletter',
    ]) {
      const res = await register(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
    }
    expect((await register({ utmSource: 'a'.repeat(100), landingPath: '/', referrerHost: 'localhost:3000' })).statusCode).toBe(201);
  });
});

describe('GET /admin/acquisition', () => {
  it('is staff only and validates the range', async () => {
    t = await makeApp();
    expect((await new Client(t).get('/admin/acquisition')).statusCode).toBe(401);
    const user = await signUp(t, 'someone@acme.com');
    expect((await user.get('/admin/acquisition')).statusCode).toBe(403);
    const staff = await makeStaff(t, 'staff@motionql.com');
    expect((await staff.get('/admin/acquisition?from=yesterday')).statusCode).toBe(400);
    expect((await staff.get('/admin/acquisition?from=2026-10-02&to=2026-10-01')).statusCode).toBe(400);
    expect((await staff.get('/admin/acquisition?from=2026-10-01&to=2026-10-02T00:00:00Z')).statusCode).toBe(200);
  });

  it('counts sign-ups, companies and activations per utm_source', async () => {
    t = await makeApp();
    // Before the range: an Acme colleague who came in directly.
    await signUp(t, 'old@acme.com', 'Old');
    t.clock.advanceDays(5); // 2026-10-06

    const nl = { attribution: newsletter };
    const ann = await signUp(t, 'ann@acme.com', 'Ann', nl);
    await signUp(t, 'ben@globex.com', 'Ben', { attribution: { utmSource: 'newsletter' } });
    await signUp(t, 'cat@globex.com', 'Cat', nl);
    await signUp(t, 'dan@initech.com', 'Dan', nl);
    const eve = await signUp(t, 'eve@gmail.com', 'Eve', nl);
    await signUp(t, 'fay@gmx.de', 'Fay', nl);
    // Signed up, never confirmed.
    await new Client(t).post('/auth/register', { email: 'gus@acme.com', password: PASSWORD, name: 'Gus', attribution: newsletter });
    await signUp(t, 'hal@hooli.com', 'Hal', { attribution: { utmSource: 'reddit', utmMedium: 'cpc' } });
    await signUp(t, 'ivy@hooli.com', 'Ivy');
    await activate(t, ann);
    await activate(t, eve);

    const staff = await makeStaff(t, 'staff@motionql.com');
    const res = await staff.get('/admin/acquisition?from=2026-10-06');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.from).toBe('2026-10-06T00:00:00.000Z');
    expect(body.to).toBeNull();
    const newsletterRow = body.sources.find((s: { utmSource: string | null }) => s.utmSource === 'newsletter');
    // ann, ben, cat, dan, eve, fay, gus (Newsletter and newsletter are one source).
    // Companies: acme (old, ann, gus = 3 accounts), globex (2), initech (1); gmail and gmx are not companies.
    expect(newsletterRow).toEqual({ utmSource: 'newsletter', signups: 7, confirmed: 6, companies: 3, companies2Plus: 2, companies3Plus: 1, activated: 2 });
    expect(body.sources.find((s: { utmSource: string | null }) => s.utmSource === 'reddit')).toEqual({
      utmSource: 'reddit', signups: 1, confirmed: 1, companies: 1, companies2Plus: 1, companies3Plus: 0, activated: 0,
    });
    // ivy and the staff account have no utm_source.
    expect(body.sources.find((s: { utmSource: string | null }) => s.utmSource === null)).toMatchObject({ signups: 2, companies: 2 });
    expect(body.sources[0].utmSource).toBe('newsletter');
    expect(body.totals).toEqual({ signups: 10, confirmed: 9, companies: 5, activated: 2 });

    // `to` is exclusive: nothing before the range start's day.
    const early = (await staff.get('/admin/acquisition?to=2026-10-02')).json();
    expect(early.totals.signups).toBe(1);
    expect(early.sources).toEqual([{ utmSource: null, signups: 1, confirmed: 1, companies: 1, companies2Plus: 0, companies3Plus: 0, activated: 0 }]);
  });
});
