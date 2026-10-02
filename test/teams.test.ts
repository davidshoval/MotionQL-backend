import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { licenseHashOf } from '../src/lib/tokens.js';
import { verifyLicense } from '../src/licensing/licenseFormat.js';
import { Client, makeApp, makeStaff, signUp, tokenFrom } from './helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

async function teamWithOwner() {
  const owner = await signUp(t, 'owner@acme.com', 'Olive Owner');
  const created = await owner.post('/teams', { name: 'Acme Corp' });
  expect(created.statusCode).toBe(201);
  return { owner, teamId: created.json().team.id as string };
}

async function invite(admin: Client, teamId: string, email: string, body: Record<string, unknown> = {}) {
  const res = await admin.post(`/teams/${teamId}/invites`, { emails: [email], ...body });
  expect(res.statusCode).toBe(201);
  return tokenFrom(t.mailer.last(email.toLowerCase())!.text);
}

describe('teams', () => {
  it('creates a team whose owner gets a seat and a team key', async () => {
    const { owner, teamId } = await teamWithOwner();
    const team = (await owner.get(`/teams/${teamId}`)).json();
    expect(team).toMatchObject({ role: 'owner', team: { name: 'Acme Corp', seatsUsed: 1, seatLimit: 25, allowedEditions: ['pro'] } });
    const licenses = (await owner.get('/me/licenses')).json().licenses;
    const teamKey = licenses.find((l: { source: string }) => l.source === 'team');
    expect(teamKey).toMatchObject({ customer: 'Acme Corp', email: 'owner@acme.com', edition: 'pro', team: { id: teamId, name: 'Acme Corp' } });
    expect(verifyLicense(teamKey.key, t.ctx.config.publicKeyBase64).ok).toBe(true);
  });

  it('invites a member who joins with a seat; the key is e-mailed; members cannot manage the team', async () => {
    const { owner, teamId } = await teamWithOwner();
    const token = await invite(owner, teamId, 'Mia@acme.com');
    expect(t.mailer.last('mia@acme.com')!.text).toContain('https://motionql.com/invite?token=');

    const preview = await new Client(t).post('/invites/preview', { token });
    expect(preview.json()).toMatchObject({ teamName: 'Acme Corp', email: 'mia@acme.com', role: 'member', assignSeat: true });

    const mia = await signUp(t, 'mia@acme.com', 'Mia');
    expect((await mia.get('/me')).json().pendingInvites).toHaveLength(1);
    const accepted = await mia.post('/invites/accept', { token });
    expect(accepted.json()).toMatchObject({ seatAssigned: true, team: { seatsUsed: 2 } });
    expect(t.mailer.last('mia@acme.com')!.subject).toBe('Your MotionQL Pro key from Acme Corp');
    expect((await mia.post('/invites/accept', { token })).statusCode).toBe(404);

    const members = (await owner.get(`/teams/${teamId}/members`)).json().members;
    expect(members.map((m: { email: string; role: string; hasSeat: boolean }) => [m.email, m.role, m.hasSeat])).toEqual([
      ['owner@acme.com', 'owner', true],
      ['mia@acme.com', 'member', true],
    ]);

    expect((await mia.post(`/teams/${teamId}/invites`, { emails: ['x@acme.com'] })).statusCode).toBe(403);
    expect((await mia.get(`/teams/${teamId}/audit`)).statusCode).toBe(403);
    const outsider = await signUp(t, 'out@other.com');
    expect((await outsider.get(`/teams/${teamId}`)).statusCode).toBe(404);
  });

  it('refuses an invite for a different e-mail', async () => {
    const { owner, teamId } = await teamWithOwner();
    const token = await invite(owner, teamId, 'right@acme.com');
    const wrong = await signUp(t, 'wrong@acme.com');
    expect((await wrong.post('/invites/accept', { token })).json().error.code).toBe('invite_email_mismatch');
  });

  it('never hands out more seats than the limit', async () => {
    const { owner, teamId } = await teamWithOwner();
    await t.ctx.c.teams.updateOne({ _id: teamId }, { $set: { seatLimit: 2 } });
    const tokens = [await invite(owner, teamId, 'a@acme.com'), await invite(owner, teamId, 'b@acme.com')];
    const a = await signUp(t, 'a@acme.com');
    const b = await signUp(t, 'b@acme.com');
    expect((await a.post('/invites/accept', { token: tokens[0] })).json().seatAssigned).toBe(true);
    // The team is full: b joins without a seat, and assigning one explicitly says why it failed.
    expect((await b.post('/invites/accept', { token: tokens[1] })).json().seatAssigned).toBe(false);
    const bId = (await b.get('/me')).json().user.id;
    const res = await owner.post(`/teams/${teamId}/seats/${bId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('seat_limit_reached');

    // Concurrent assignments still respect the limit.
    const aId = (await a.get('/me')).json().user.id;
    await owner.del(`/teams/${teamId}/seats/${aId}`);
    const results = await Promise.all([owner.post(`/teams/${teamId}/seats/${aId}`), owner.post(`/teams/${teamId}/seats/${bId}`)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await owner.get(`/teams/${teamId}`)).json().team.seatsUsed).toBe(2);
  });

  it('removing a member frees the seat, revokes the key and puts it on the manifest', async () => {
    const { owner, teamId } = await teamWithOwner();
    const token = await invite(owner, teamId, 'leaver@acme.com');
    const leaver = await signUp(t, 'leaver@acme.com');
    await leaver.post('/invites/accept', { token });
    const leaverId = (await leaver.get('/me')).json().user.id;
    const key = (await leaver.get('/me/licenses')).json().licenses.find((l: { source: string }) => l.source === 'team');

    expect((await owner.del(`/teams/${teamId}/members/${leaverId}`)).statusCode).toBe(204);
    expect(t.mailer.last('leaver@acme.com')!.subject).toContain('seat on MotionQL was removed');
    expect((await owner.get(`/teams/${teamId}`)).json().team.seatsUsed).toBe(1);
    const after = (await leaver.get('/me/licenses')).json().licenses.find((l: { licenseId: string }) => l.licenseId === key.licenseId);
    expect(after.status).toBe('revoked');
    const revoked = await t.ctx.c.licenses.findOne({ _id: key.licenseId });
    expect(revoked!.hash).toBe(licenseHashOf(key.licenseId));
    // Their own account and free key stay.
    expect((await leaver.get('/me/licenses')).json().licenses.some((l: { source: string; status: string }) => l.source === 'free' && l.status === 'active')).toBe(true);
  });

  it('reissues a member key and changes edition only within what the team allows', async () => {
    const { owner, teamId } = await teamWithOwner();
    const ownerId = (await owner.get('/me')).json().user.id;
    const reissued = await owner.post(`/teams/${teamId}/members/${ownerId}/reissue`);
    expect(reissued.statusCode).toBe(201);

    const denied = await owner.patch(`/teams/${teamId}/members/${ownerId}`, { edition: 'enterprise' });
    expect(denied.json().error.code).toBe('edition_not_allowed');

    const staff = await makeStaff(t, 'staff@motionql.com');
    expect((await staff.patch(`/admin/teams/${teamId}`, { allowedEditions: ['pro', 'enterprise'], allowedFeatures: ['team'] })).statusCode).toBe(200);
    const changed = await owner.patch(`/teams/${teamId}/members/${ownerId}`, { edition: 'enterprise', features: ['team'] });
    expect(changed.json().member).toMatchObject({ edition: 'enterprise', features: ['team'] });
    const keys = (await owner.get('/me/licenses')).json().licenses.filter((l: { source: string }) => l.source === 'team');
    expect(keys.map((k: { status: string; edition: string }) => [k.status, k.edition])).toEqual([
      ['active', 'enterprise'],
      ['replaced', 'pro'],
      ['replaced', 'pro'],
    ]);
  });

  it('only the owner makes admins; admins invite; ownership transfers; the owner cannot leave', async () => {
    const { owner, teamId } = await teamWithOwner();
    const token = await invite(owner, teamId, 'adam@acme.com', { role: 'admin' });
    const adam = await signUp(t, 'adam@acme.com');
    await adam.post('/invites/accept', { token });
    const adamId = (await adam.get('/me')).json().user.id;
    const ownerId = (await owner.get('/me')).json().user.id;

    expect((await adam.post(`/teams/${teamId}/invites`, { emails: ['new@acme.com'], role: 'admin' })).statusCode).toBe(403);
    expect((await adam.post(`/teams/${teamId}/invites`, { emails: ['new@acme.com'] })).statusCode).toBe(201);
    expect((await adam.del(`/teams/${teamId}/members/${ownerId}`)).json().error.code).toBe('owner_cannot_leave');

    expect((await owner.post(`/teams/${teamId}/transfer-ownership`, { userId: adamId })).statusCode).toBe(204);
    expect((await adam.get(`/teams/${teamId}`)).json().role).toBe('owner');
    expect((await owner.get(`/teams/${teamId}`)).json().role).toBe('admin');
    expect((await owner.del(`/teams/${teamId}/members/${ownerId}`)).statusCode).toBe(204);
  });

  it('keeps an audit log with a cursor and a CSV export', async () => {
    const { owner, teamId } = await teamWithOwner();
    await invite(owner, teamId, 'one@acme.com');
    await invite(owner, teamId, 'two@acme.com');
    const page1 = (await owner.get(`/teams/${teamId}/audit?limit=2`)).json();
    expect(page1.events).toHaveLength(2);
    expect(page1.events[0].action).toBe('team.invite.create');
    const page2 = (await owner.get(`/teams/${teamId}/audit?limit=50&before=${page1.nextCursor}`)).json();
    expect(page2.events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['team.create', 'license.issue', 'team.seat.assign']));
    const csv = await owner.get(`/teams/${teamId}/audit.csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('time,actor,action,target_type,target,details');
  });

  it('deletes an account: blocked while owning a team with members, then revokes keys and leaves teams', async () => {
    const { owner, teamId } = await teamWithOwner();
    const token = await invite(owner, teamId, 'del@acme.com');
    const del = await signUp(t, 'del@acme.com');
    await del.post('/invites/accept', { token });
    expect((await owner.req('DELETE', '/me', { password: 'correct horse battery' })).json().error.code).toBe('owns_team');
    expect((await del.req('DELETE', '/me', { password: 'wrong password!' })).json().error.code).toBe('wrong_password');
    expect((await del.req('DELETE', '/me', { password: 'correct horse battery' })).statusCode).toBe(204);
    expect((await del.get('/me')).statusCode).toBe(401);
    expect((await owner.get(`/teams/${teamId}`)).json().team.seatsUsed).toBe(1);
    const keys = await t.ctx.c.licenses.find({ 'payload.email': 'del@acme.com' }).toArray();
    expect(keys.length).toBe(2);
    expect(keys.every((k) => k.revokedAt && !k.userId)).toBe(true);
  });

  it('deleting a team revokes every team key', async () => {
    const { owner, teamId } = await teamWithOwner();
    expect((await owner.del(`/teams/${teamId}`)).statusCode).toBe(204);
    const teamKeys = (await owner.get('/me/licenses')).json().licenses.filter((l: { source: string }) => l.source === 'team');
    expect(teamKeys.every((k: { status: string }) => k.status === 'revoked')).toBe(true);
    expect((await owner.get('/me')).json().teams).toEqual([]);
  });
});
