import { afterEach, describe, expect, it } from 'vitest';
import { licenseHashOf } from '../src/lib/tokens.js';
import { Client, makeApp, makeStaff, signUp } from './helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

const id = (n: number) => `6f1c2a54-0d1e-4b8a-9c3f-${String(n).padStart(12, '0')}`;
const EVENT = { installId: id(1), appVersion: '1.4.2', os: 'darwin', arch: 'arm64', event: 'app_open' };

const usage = (t: TestApp, body: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'POST', url: '/v1/usage', payload: body as object, headers });

async function licenseHashFor(client: Client) {
  const { licenses } = (await client.get('/me/licenses')).json() as { licenses: { licenseId: string }[] };
  return licenseHashOf(licenses[0]!.licenseId);
}

describe('POST /v1/usage', () => {
  it('stores the event with the server date and nothing else', async () => {
    t = await makeApp();
    const res = await usage(t, { ...EVENT, licenseId: 'A'.repeat(64) }, { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'MotionQL/1.4.2' });
    expect(res.statusCode).toBe(204);
    const rows = await t.ctx.c.usageEvents.find().toArray();
    expect(rows).toHaveLength(1);
    const { _id, ...row } = rows[0]!;
    expect(_id).toMatch(/^use_/);
    expect(row).toEqual({ installId: id(1), appVersion: '1.4.2', os: 'darwin', arch: 'arm64', event: 'app_open', licenseHash: 'a'.repeat(64), at: t.clock.now });
    expect(JSON.stringify(rows)).not.toContain('203.0.113.9');

    for (const event of ['first_connection', 'active_day']) expect((await usage(t, { ...EVENT, event })).statusCode).toBe(204);
    expect(await t.ctx.c.usageEvents.countDocuments({ licenseHash: { $exists: false } })).toBe(2);
  });

  it('keeps one first_connection per install and one active_day per install per UTC day', async () => {
    t = await makeApp();
    const send = async (event: string, installId = id(1)) => expect((await usage(t, { ...EVENT, installId, event })).statusCode).toBe(204);
    await send('first_connection');
    await send('first_connection');
    await send('active_day');
    await send('active_day');
    await send('app_open');
    await send('app_open');
    await send('active_day', id(2));
    t.clock.advanceDays(1);
    await send('first_connection');
    await send('active_day');
    const count = (filter: object) => t.ctx.c.usageEvents.countDocuments(filter);
    expect(await count({ installId: id(1), event: 'first_connection' })).toBe(1);
    expect(await count({ installId: id(1), event: 'active_day' })).toBe(2);
    expect(await count({ installId: id(1), event: 'app_open' })).toBe(2);
    expect(await count({ installId: id(2), event: 'active_day' })).toBe(1);
    // The first one wins.
    const first = await t.ctx.c.usageEvents.findOne({ installId: id(1), event: 'first_connection' });
    expect(first!.at).toEqual(new Date('2026-10-01T12:00:00.000Z'));
  });

  it('refuses unknown events, unknown fields and bad values', async () => {
    t = await makeApp();
    for (const bad of [
      { ...EVENT, event: 'crash' },
      { ...EVENT, hostname: 'laptop' },
      { ...EVENT, installId: 'not-a-uuid' },
      { ...EVENT, appVersion: 'latest' },
      { ...EVENT, os: 'Mac OS X' },
      { ...EVENT, licenseId: 'lic_123' },
      { installId: id(1), appVersion: '1.4.2', os: 'darwin', arch: 'arm64' },
    ]) {
      const res = await usage(t, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await t.ctx.c.usageEvents.countDocuments()).toBe(0);
  });

  it('is rate-limited per IP like /v1/feedback', async () => {
    t = await makeApp({ env: { AUTH_RATE_LIMIT_PER_MINUTE: '3' } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await usage(t, EVENT)).statusCode);
    expect(codes).toEqual([204, 204, 204, 429]);
  });
});

describe('GET /admin/retention', () => {
  it('is staff only', async () => {
    t = await makeApp();
    expect((await new Client(t).get('/admin/retention')).statusCode).toBe(401);
    expect((await (await signUp(t, 'x@acme.com')).get('/admin/retention')).statusCode).toBe(403);
  });

  it('reports D1/D7/D30 retention by first week and per utm_source', async () => {
    t = await makeApp();
    // 2026-10-01 is a Thursday: its cohort week starts Monday 2026-09-28.
    const ann = await signUp(t, 'ann@acme.com', 'Ann', { attribution: { utmSource: 'Newsletter' } });
    const bob = await signUp(t, 'bob@globex.com', 'Bob');
    const annHash = await licenseHashFor(ann);
    const bobHash = await licenseHashFor(bob);

    const at = async (n: number, extra: Record<string, unknown> = {}) => {
      const res = await usage(t, { ...EVENT, installId: id(n), ...extra });
      expect(res.statusCode).toBe(204);
    };
    // Day 0 (2026-10-01): three installs. Ann's sends her key, Bob's none at first.
    await at(1, { licenseId: annHash });
    await at(2);
    await at(3);
    t.clock.advanceDays(1); // day 1
    await at(1, { event: 'active_day', licenseId: annHash });
    await at(2, { event: 'active_day', licenseId: bobHash });
    t.clock.advanceDays(6); // day 7 (2026-10-08): a new install starts the next week's cohort.
    await at(1, { event: 'active_day' });
    await at(4);
    t.clock.advanceDays(1); // 2026-10-09: day 8 of the first cohort, day 1 of the second.

    const staff = await makeStaff(t, 'staff@motionql.com');
    const body = (await staff.get('/admin/retention')).json();
    expect(body.days).toEqual([1, 7, 30]);
    expect(body.cohorts).toEqual([
      {
        week: '2026-09-28',
        installs: 3,
        d1: { eligible: 3, retained: 2, rate: 0.667 },
        d7: { eligible: 3, retained: 1, rate: 0.333 },
        d30: { eligible: 0, retained: 0, rate: null },
      },
      // Day 1 is not over yet for the 2026-10-08 install.
      { week: '2026-10-05', installs: 1, d1: { eligible: 0, retained: 0, rate: null }, d7: { eligible: 0, retained: 0, rate: null }, d30: { eligible: 0, retained: 0, rate: null } },
    ]);
    expect(body.totals).toMatchObject({ installs: 4, linkedInstalls: 2, d1: { eligible: 3, retained: 2 } });
    // Install 1 is Ann's (newsletter); install 2 is Bob's (no utm_source) through the key it sent later.
    expect(body.bySource).toEqual([
      { utmSource: 'newsletter', installs: 1, d1: { eligible: 1, retained: 1, rate: 1 }, d7: { eligible: 1, retained: 1, rate: 1 }, d30: { eligible: 0, retained: 0, rate: null } },
      { utmSource: null, installs: 1, d1: { eligible: 1, retained: 1, rate: 1 }, d7: { eligible: 1, retained: 0, rate: 0 }, d30: { eligible: 0, retained: 0, rate: null } },
    ]);

    // The range filters on the install's first day.
    const later = (await staff.get('/admin/retention?from=2026-10-05')).json();
    expect(later.totals.installs).toBe(1);
    expect(later.cohorts.map((c: { week: string }) => c.week)).toEqual(['2026-10-05']);
    expect((await staff.get('/admin/retention?from=2026-10-05&to=2026-10-01')).statusCode).toBe(400);
  });
});
