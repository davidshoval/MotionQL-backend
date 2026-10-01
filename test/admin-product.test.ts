import { createPublicKey } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { licenseHashOf } from '../src/lib/tokens.js';
import { verifyManifest } from '../src/licensing/manifest.js';
import { clearDownloadCache } from '../src/services/downloads.js';
import { Client, makeApp, makeStaff, signUp } from './helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

const PING = {
  installId: '6f1c2a54-0d1e-4b8a-9c3f-1a2b3c4d5e6f',
  appVersion: '1.4.2',
  channel: 'stable',
  platform: 'darwin',
  arch: 'arm64',
  edition: 'pro',
};

async function manifest(t: TestApp) {
  const res = await t.app.inject({ method: 'GET', url: '/v1/manifest' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('text/plain');
  return { token: res.body, payload: verifyManifest(res.body, createPublicKey(t.ctx.config.signingKey)) };
}

describe('staff console: the free-year switch', () => {
  it('is staff only, and changes what new users get without touching existing keys', async () => {
    t = await makeApp();
    const first = await signUp(t, 'early@example.com');
    expect((await first.get('/admin/plans')).statusCode).toBe(403);
    expect((await new Client(t).get('/admin/plans')).statusCode).toBe(401);

    const staff = await makeStaff(t, 'staff@xquery.io');
    expect((await staff.get('/admin/plans')).json().free).toMatchObject({ enabled: true, edition: 'pro', durationDays: 365, renewable: true });
    const changed = await staff.put('/admin/plans/free', { durationDays: 30, edition: 'trial' });
    expect(changed.json().free).toMatchObject({ enabled: true, edition: 'trial', durationDays: 30 });
    expect((await new Client(t).get('/plans/free')).json()).toMatchObject({ enabled: true, edition: 'trial', durationDays: 30 });

    const second = await signUp(t, 'later@example.com');
    expect((await second.get('/me/licenses')).json().licenses[0]).toMatchObject({ edition: 'trial', expiresAt: '2026-10-31T12:00:00.000Z' });
    expect((await first.get('/me/licenses')).json().licenses[0]).toMatchObject({ edition: 'pro', expiresAt: '2027-10-01T12:00:00.000Z' });

    // Turning the free plan off: new accounts get no key, renewal is refused.
    await staff.put('/admin/plans/free', { enabled: false });
    const third = await signUp(t, 'paid@example.com');
    expect((await third.get('/me/licenses')).json().licenses).toEqual([]);
    expect((await third.post('/me/licenses/renew')).json().error.code).toBe('not_renewable');

    const audit = (await staff.get('/admin/audit?limit=200')).json().events.map((e: { action: string }) => e.action);
    expect(audit).toContain('settings.free_plan.update');
  });

  it('issues, extends and revokes keys by hand and finds them by e-mail or hash', async () => {
    t = await makeApp();
    const staff = await makeStaff(t, 'staff@xquery.io');
    const issued = await staff.post('/admin/licenses', { email: 'Partner@Big.co', customer: 'Big Co', edition: 'enterprise', features: ['team'], durationDays: 90 });
    expect(issued.statusCode).toBe(201);
    const lic = issued.json().license;
    expect(lic).toMatchObject({ email: 'partner@big.co', edition: 'enterprise', features: ['team'], source: 'staff', expiresAt: '2026-12-30T12:00:00.000Z' });

    const found = (await staff.get(`/admin/licenses?q=${licenseHashOf(lic.licenseId)}`)).json().licenses;
    expect(found.map((l: { licenseId: string }) => l.licenseId)).toEqual([lic.licenseId]);

    const extended = (await staff.post(`/admin/licenses/${lic.licenseId}/extend`, { days: 30 })).json().license;
    expect(extended.expiresAt).toBe('2027-01-29T12:00:00.000Z');
    expect((await staff.post(`/admin/licenses/${extended.licenseId}/revoke`, { reason: 'chargeback' })).statusCode).toBe(204);
    const all = (await staff.get('/admin/licenses?q=partner@big.co')).json().licenses;
    expect(all.map((l: { status: string }) => l.status).sort()).toEqual(['replaced', 'revoked']);

    const overview = (await staff.get('/admin/overview')).json();
    expect(overview.users.total).toBe(1);
    expect(overview.licenses.revokedUnexpired).toBe(2);
  });
});

describe('product service', () => {
  it('serves a manifest the app verifies, re-signing only when something changes', async () => {
    t = await makeApp();
    const a = await manifest(t);
    expect(a.payload).toEqual({ schema: 1, issuedAt: '2026-10-01T12:00:00.000Z', notifications: [] });
    t.clock.advanceDays(1);
    expect((await manifest(t)).token).toBe(a.token);

    const staff = await makeStaff(t, 'staff@xquery.io');
    const bad = await staff.put('/admin/manifest', { notifications: [{ id: 'x', severity: 'loud' }] });
    expect(bad.json().error.code).toBe('invalid_manifest');
    const ok = await staff.put('/admin/manifest', {
      requiredUpdate: { stable: { minimumVersion: '1.4.0', downloadUrl: 'https://xquery.io/download' } },
      notifications: [{ id: 'hello', severity: 'info', title: 'Hi', body: 'Welcome', publishedAt: '2026-10-01T00:00:00Z' }],
    });
    expect(ok.statusCode).toBe(200);
    const b = await manifest(t);
    expect(b.payload.issuedAt).toBe('2026-10-02T12:00:00.000Z');
    expect(b.payload.requiredUpdate).toEqual({ stable: { minimumVersion: '1.4.0', downloadUrl: 'https://xquery.io/download' } });
    expect(b.payload.notifications[0].id).toBe('hello');
  });

  it('lists revoked, unexpired keys only once revocations are switched on', async () => {
    t = await makeApp();
    const staff = await makeStaff(t, 'staff@xquery.io');
    const lic = (await staff.post('/admin/licenses', { email: 'x@y.co', customer: 'X', edition: 'pro', durationDays: 10 })).json().license;
    await staff.post(`/admin/licenses/${lic.licenseId}/revoke`, { reason: 'leaked' });
    expect((await manifest(t)).payload.revokedLicenses).toBeUndefined();

    await staff.put('/admin/manifest', { includeRevocations: true });
    expect((await manifest(t)).payload.revokedLicenses).toEqual([licenseHashOf(lic.licenseId)]);
    expect((await staff.get('/admin/manifest')).json()).toMatchObject({ includeRevocations: true, revokedCount: 1 });

    // Once the key has expired it drops off the list (the app refuses it anyway) and the manifest is re-signed.
    t.clock.advanceDays(11);
    const later = await manifest(t);
    expect(later.payload.revokedLicenses).toBeUndefined();
    expect(later.payload.issuedAt).toBe('2026-10-12T12:00:00.000Z');
  });

  it('records the usage ping without extra fields and shows installs per team member', async () => {
    t = await makeApp();
    const ping = (body: unknown) => t.app.inject({ method: 'POST', url: '/v1/ping', payload: body as object });
    expect((await ping(PING)).statusCode).toBe(204);
    expect((await ping({ ...PING, hostname: 'laptop' })).statusCode).toBe(400);
    expect((await ping({ ...PING, installId: 'nope' })).statusCode).toBe(400);
    const stored = await t.ctx.c.installs.findOne({ _id: PING.installId });
    expect(stored).toMatchObject({ appVersion: '1.4.2', platform: 'darwin', firstSeen: t.clock.now, lastSeen: t.clock.now });
    expect(Object.keys(stored!).sort()).toEqual(['_id', 'appVersion', 'arch', 'channel', 'edition', 'firstSeen', 'lastSeen', 'platform']);

    const owner = await signUp(t, 'owner@acme.com');
    const teamId = (await owner.post('/teams', { name: 'Acme' })).json().team.id;
    const key = (await owner.get('/me/licenses')).json().licenses.find((l: { source: string }) => l.source === 'team');
    await ping({ ...PING, licenseHash: licenseHashOf(key.licenseId) });
    await ping({ ...PING, installId: '6f1c2a54-0d1e-4b8a-9c3f-000000000000', platform: 'win32', licenseHash: licenseHashOf(key.licenseId) });
    const member = (await owner.get(`/teams/${teamId}/members`)).json().members[0];
    expect(member.usage).toMatchObject({ installs: 2, appVersion: '1.4.2' });

    const staff = await makeStaff(t, 'staff@xquery.io');
    expect((await staff.get('/admin/overview')).json().installs.active.day).toBe(2);
  });
});

describe('downloads', () => {
  it('lists installers from the latest public release with checksums', async () => {
    clearDownloadCache();
    const fakeFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/releases/latest')) {
        return Response.json({
          tag_name: 'v1.4.2',
          published_at: '2026-09-30T10:00:00Z',
          html_url: 'https://github.com/davidshoval/Xquery.io-releases/releases/tag/v1.4.2',
          assets: [
            { name: 'XQuery-1.4.2-arm64.dmg', size: 100, browser_download_url: 'https://dl/arm.dmg' },
            { name: 'XQuery-1.4.2.dmg', size: 110, browser_download_url: 'https://dl/x64.dmg' },
            { name: 'XQuery-Setup-1.4.2.exe', size: 90, browser_download_url: 'https://dl/setup.exe' },
            { name: 'XQuery-1.4.2.AppImage', size: 120, browser_download_url: 'https://dl/app.AppImage' },
            { name: 'XQuery-1.4.2.exe.blockmap', size: 1, browser_download_url: 'https://dl/x.blockmap' },
            { name: 'latest-mac.yml', size: 1, browser_download_url: 'https://dl/latest-mac.yml' },
            { name: 'SHA256SUMS.txt', size: 1, browser_download_url: 'https://dl/SHA256SUMS.txt' },
          ],
        });
      }
      if (u === 'https://dl/SHA256SUMS.txt') return new Response(`${'a'.repeat(64)}  XQuery-1.4.2-arm64.dmg\n${'b'.repeat(64)}  XQuery-Setup-1.4.2.exe\n`);
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    t = await makeApp({ fetch: fakeFetch });
    const res = await t.app.inject({ method: 'GET', url: '/downloads/latest' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe('1.4.2');
    expect(body.files).toEqual([
      { name: 'XQuery-1.4.2-arm64.dmg', os: 'macos', arch: 'arm64', kind: 'dmg', size: 100, url: 'https://dl/arm.dmg', sha256: 'a'.repeat(64) },
      { name: 'XQuery-1.4.2.dmg', os: 'macos', arch: 'x64', kind: 'dmg', size: 110, url: 'https://dl/x64.dmg' },
      { name: 'XQuery-Setup-1.4.2.exe', os: 'windows', arch: 'x64', kind: 'exe', size: 90, url: 'https://dl/setup.exe', sha256: 'b'.repeat(64) },
      { name: 'XQuery-1.4.2.AppImage', os: 'linux', arch: 'x64', kind: 'appimage', size: 120, url: 'https://dl/app.AppImage' },
    ]);
    clearDownloadCache();
  });
});

describe('openapi', () => {
  it('publishes the API description', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toEqual(expect.arrayContaining(['/auth/register', '/teams/{teamId}/invites', '/v1/manifest', '/admin/plans/free']));
  });
});
