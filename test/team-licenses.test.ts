import { MongoClient } from 'mongodb';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { collections, ensureIndexes } from '../src/db.js';
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

interface MemberRow {
  memberId: string;
  userId?: string;
  hasAccount: boolean;
  email?: string;
  name: string;
  role: string;
  hasSeat: boolean;
  license?: { licenseId: string; key?: string; expiresAt: string; status: string };
}

async function teamWithOwner() {
  const owner = await signUp(t, 'it@acme.com', 'Ivy IT');
  const created = await owner.post('/teams', { name: 'Acme Corp' });
  return { owner, teamId: created.json().team.id as string };
}

const members = async (c: Client, teamId: string) => (await c.get(`/teams/${teamId}/members`)).json().members as MemberRow[];

describe('adding people directly (no invitation)', () => {
  it('gives each person a seat and a key at once; the admin sees the key and its expiry', async () => {
    const { owner, teamId } = await teamWithOwner();
    const res = await owner.post(`/teams/${teamId}/members`, {
      members: [{ email: 'Dev1@acme.com', name: 'Dana Dev' }, { email: 'dev2@acme.com' }],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.team.seatsUsed).toBe(3);
    expect(body.skipped).toEqual([]);
    expect(body.members.map((m: MemberRow) => [m.email, m.name, m.hasAccount, m.hasSeat, m.license?.status])).toEqual([
      ['dev1@acme.com', 'Dana Dev', false, true, 'active'],
      ['dev2@acme.com', '', false, true, 'active'],
    ]);
    const key = body.members[0].license.key;
    expect(verifyLicense(key, t.ctx.config.publicKeyBase64)).toMatchObject({ ok: true, payload: { email: 'dev1@acme.com', customer: 'Acme Corp' } });
    expect(body.members[0].license.expiresAt.slice(0, 10)).toBe('2027-10-01');

    // The key is e-mailed with how to use it without an account; no invitation link.
    const mail = t.mailer.last('dev1@acme.com')!;
    expect(mail.subject).toBe('Your MotionQL Pro key from Acme Corp');
    expect(mail.text).toContain(key);
    expect(mail.text).toContain('No account is needed');
    expect(mail.text).not.toContain('/invite?token=');
    expect((await owner.get(`/teams/${teamId}/invites`)).json().invites).toEqual([]);

    // Adding the same address again is skipped.
    const again = (await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'dev1@acme.com' }] })).json();
    expect(again).toMatchObject({ members: [], skipped: [{ email: 'dev1@acme.com', reason: 'already_member' }] });
  });

  it('can skip the e-mail when IT hands keys out itself, and add without a seat', async () => {
    const { owner, teamId } = await teamWithOwner();
    const sent = t.mailer.sent.length;
    const res = (await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'quiet@acme.com' }], sendEmail: false })).json();
    expect(res.members[0].license.key).toMatch(/^MQL1\./);
    const noSeat = (await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'later@acme.com' }], assignSeat: false })).json();
    expect(noSeat.members[0]).toMatchObject({ hasSeat: false });
    expect(t.mailer.sent.length).toBe(sent);
  });

  it('refuses to add more people than there are free seats, before adding anyone', async () => {
    const { owner, teamId } = await teamWithOwner();
    await t.ctx.c.teams.updateOne({ _id: teamId }, { $set: { seatLimit: 2 } });
    const res = await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'a@acme.com' }, { email: 'b@acme.com' }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'seat_limit_reached', message: expect.stringContaining('only 1 seat is free') });
    expect(await members(owner, teamId)).toHaveLength(1);
  });

  it('links the seat to the account once the person signs up with that e-mail', async () => {
    const { owner, teamId } = await teamWithOwner();
    const added = (await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'new@acme.com', name: 'Nia' }] })).json().members[0];
    const nia = await signUp(t, 'new@acme.com', 'Nia New');
    const me = (await nia.get('/me')).json();
    expect(me.teams).toEqual([{ id: teamId, name: 'Acme Corp', role: 'member', hasSeat: true }]);
    const teamKey = (await nia.get('/me/licenses')).json().licenses.find((l: { source: string }) => l.source === 'team');
    expect(teamKey.licenseId).toBe(added.license.licenseId);
    const row = (await members(owner, teamId)).find((m) => m.email === 'new@acme.com')!;
    expect(row).toMatchObject({ hasAccount: true, name: 'Nia New', userId: me.user.id, memberId: added.memberId });
  });

  it('links someone who already has a confirmed account straight away, and drops their pending invite', async () => {
    const { owner, teamId } = await teamWithOwner();
    await owner.post(`/teams/${teamId}/invites`, { emails: ['sam@acme.com'] });
    const sam = await signUp(t, 'sam@acme.com', 'Sam');
    const res = (await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'sam@acme.com' }] })).json();
    expect(res.members[0]).toMatchObject({ hasAccount: true, name: 'Sam' });
    expect((await owner.get(`/teams/${teamId}/invites`)).json().invites).toEqual([]);
    expect((await sam.get('/me')).json().teams[0]).toMatchObject({ id: teamId, hasSeat: true });
    // An unconfirmed account with an address does not get linked.
    await new Client(t).post('/auth/register', { email: 'squat@acme.com', password: 'correct horse battery', name: 'Squatter' });
    const squat = (await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'squat@acme.com' }] })).json();
    expect(squat.members[0].hasAccount).toBe(false);
  });

  it('only the owner adds admins, and members never see keys', async () => {
    const { owner, teamId } = await teamWithOwner();
    await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'adam@acme.com' }], role: 'admin' });
    const adam = await signUp(t, 'adam@acme.com', 'Adam');
    expect((await adam.get(`/teams/${teamId}`)).json().role).toBe('admin');
    expect((await adam.post(`/teams/${teamId}/members`, { members: [{ email: 'x@acme.com' }], role: 'admin' })).statusCode).toBe(403);
    expect((await adam.post(`/teams/${teamId}/members`, { members: [{ email: 'mo@acme.com' }] })).statusCode).toBe(201);
    const mo = await signUp(t, 'mo@acme.com', 'Mo');
    const roster = await members(mo, teamId);
    expect(roster).toHaveLength(3);
    expect(roster.every((m) => m.license && !m.license.key)).toBe(true);
    expect((await mo.get(`/teams/${teamId}/licenses`)).statusCode).toBe(403);
  });
});

describe('people without an e-mail', () => {
  it('adds someone by name only: the key carries the admin e-mail and nothing is mailed', async () => {
    const { owner, teamId } = await teamWithOwner();
    const sent = t.mailer.sent.length;
    const res = await owner.post(`/teams/${teamId}/members`, { members: [{ name: 'Lab PC 3' }, { name: 'Lab PC 3', email: '' }] });
    expect(res.statusCode).toBe(201);
    const [a, b] = res.json().members as MemberRow[];
    expect(a).toMatchObject({ name: 'Lab PC 3', hasAccount: false, hasSeat: true });
    expect(a.email).toBeUndefined();
    expect(b.memberId).not.toBe(a.memberId);
    expect(verifyLicense(a.license!.key!, t.ctx.config.publicKeyBase64)).toMatchObject({ ok: true, payload: { email: 'it@acme.com', customer: 'Acme Corp' } });
    expect(t.mailer.sent.length).toBe(sent);
    expect((await owner.post(`/teams/${teamId}/members/${a.memberId}/send-key`)).json().error.code).toBe('no_email');
    // Neither a name nor an e-mail is refused.
    expect((await owner.post(`/teams/${teamId}/members`, { members: [{ email: '' }] })).statusCode).toBe(400);

    // The inventory names the person, not the admin whose e-mail is in the key, and the admin's own key stays theirs.
    const licenses = (await owner.get(`/teams/${teamId}/licenses`)).json().licenses as { assignee: { memberId?: string; name: string; email: string } }[];
    expect(licenses.filter((l) => l.assignee.memberId === a.memberId)).toHaveLength(1);
    expect(licenses.find((l) => l.assignee.memberId === a.memberId)!.assignee).toMatchObject({ name: 'Lab PC 3', email: '' });
    expect(licenses.filter((l) => l.assignee.name === 'Ivy IT')).toHaveLength(1);
    expect((await owner.get('/me/licenses')).json().licenses.filter((l: { source: string }) => l.source === 'team')).toHaveLength(1);

    // Freeing the seat revokes the key without mailing anyone.
    expect((await owner.del(`/teams/${teamId}/seats/${b.memberId}`)).statusCode).toBe(204);
    expect(t.mailer.sent.length).toBe(sent);
  });

  it('an e-mail added later goes into a new key, is mailed, and links the account once confirmed', async () => {
    const { owner, teamId } = await teamWithOwner();
    const added = (await owner.post(`/teams/${teamId}/members`, { members: [{ name: 'Rae' }] })).json().members[0] as MemberRow;
    const res = await owner.patch(`/teams/${teamId}/members/${added.memberId}`, { email: 'Rae@acme.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json().member).toMatchObject({ email: 'rae@acme.com', name: 'Rae' });
    const row = (await members(owner, teamId)).find((m) => m.memberId === added.memberId)!;
    expect(row.license!.licenseId).not.toBe(added.license!.licenseId);
    expect(row.license!.expiresAt).toBe(added.license!.expiresAt);
    expect(verifyLicense(row.license!.key!, t.ctx.config.publicKeyBase64)).toMatchObject({ ok: true, payload: { email: 'rae@acme.com' } });
    expect(t.mailer.last('rae@acme.com')!.text).toContain(row.license!.key!);

    const rae = await signUp(t, 'rae@acme.com', 'Rae Ray');
    expect((await rae.get('/me')).json().teams[0]).toMatchObject({ id: teamId, hasSeat: true });
    // The owner (whose e-mail was in Rae's first key) did not get Rae's keys.
    expect((await owner.get('/me/licenses')).json().licenses.filter((l: { source: string }) => l.source === 'team')).toHaveLength(1);
    // An account's e-mail is not the admin's to change; another member's e-mail is refused.
    expect((await owner.patch(`/teams/${teamId}/members/${added.memberId}`, { email: 'other@acme.com' })).json().error.code).toBe('has_account');
    const other = (await owner.post(`/teams/${teamId}/members`, { members: [{ name: 'Oz' }] })).json().members[0] as MemberRow;
    expect((await owner.patch(`/teams/${teamId}/members/${other.memberId}`, { email: 'rae@acme.com' })).statusCode).toBe(409);
    // Clearing the e-mail needs a name to remain.
    const pat = (await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'pat@acme.com' }] })).json().members[0] as MemberRow;
    expect((await owner.patch(`/teams/${teamId}/members/${pat.memberId}`, { email: null })).statusCode).toBe(400);
    const cleared = await owner.patch(`/teams/${teamId}/members/${pat.memberId}`, { email: null, name: 'Pat' });
    expect(cleared.json().member).toMatchObject({ email: null, name: 'Pat' });
  });

  it('reassigns a seat to someone given by name only', async () => {
    const { owner, teamId } = await teamWithOwner();
    const dev = (await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'dev@acme.com' }] })).json().members[0] as MemberRow;
    const res = await owner.post(`/teams/${teamId}/members/${dev.memberId}/reassign`, { name: 'Contractor' });
    expect(res.statusCode).toBe(201);
    expect(res.json().member).toMatchObject({ name: 'Contractor', hasSeat: true });
  });
});

describe('managing keys', () => {
  async function teamWithDev() {
    const { owner, teamId } = await teamWithOwner();
    const dev = (await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'dev@acme.com', name: 'Dev' }] })).json().members[0] as MemberRow;
    return { owner, teamId, dev };
  }

  it('renews a key for a full term from today, and renews every key close to expiry in one go', async () => {
    const { owner, teamId, dev } = await teamWithDev();
    t.clock.advanceDays(340);
    // Sessions last 30 days: sign in again.
    expect((await owner.post('/auth/login', { email: 'it@acme.com', password: 'correct horse battery' })).statusCode).toBe(200);
    const renewed = await owner.post(`/teams/${teamId}/members/${dev.memberId}/renew`);
    expect(renewed.statusCode).toBe(201);
    expect(renewed.json().license.expiresAt.slice(0, 10)).toBe('2028-09-05');
    expect(t.mailer.last('dev@acme.com')!.text).toContain(renewed.json().license.key);
    const old = await t.ctx.c.licenses.findOne({ _id: dev.license!.licenseId });
    expect(old!.replacedBy).toBe(renewed.json().license.licenseId);

    // The owner's key (issued on day 0) is now due; the dev's is not.
    const bulk = await owner.post(`/teams/${teamId}/licenses/renew-expiring`, { withinDays: 30 });
    expect(bulk.json()).toEqual({ renewed: 1 });
    const rows = await members(owner, teamId);
    expect(rows.every((m) => m.license!.expiresAt.startsWith('2028-09-05'))).toBe(true);
  });

  it('re-sends the current key, and reassigns a seat to a new person', async () => {
    const { owner, teamId, dev } = await teamWithDev();
    const before = t.mailer.sent.length;
    expect((await owner.post(`/teams/${teamId}/members/${dev.memberId}/send-key`)).statusCode).toBe(204);
    expect(t.mailer.sent.length).toBe(before + 1);
    expect(t.mailer.last('dev@acme.com')!.text).toContain(dev.license!.key);

    await t.ctx.c.teams.updateOne({ _id: teamId }, { $set: { seatLimit: 2 } });
    const moved = await owner.post(`/teams/${teamId}/members/${dev.memberId}/reassign`, { email: 'next@acme.com', name: 'Next' });
    expect(moved.statusCode).toBe(201);
    expect(moved.json().member).toMatchObject({ email: 'next@acme.com', hasSeat: true, license: { status: 'active' } });
    expect(t.mailer.last('dev@acme.com')!.subject).toContain('seat on MotionQL was removed');
    const rows = await members(owner, teamId);
    expect(rows.find((m) => m.email === 'dev@acme.com')).toMatchObject({ hasSeat: false });
    expect((await owner.get(`/teams/${teamId}`)).json().team.seatsUsed).toBe(2);
    const old = await t.ctx.c.licenses.findOne({ _id: dev.license!.licenseId });
    expect(old!.revokeReason).toBe('seat reassigned');
  });

  it('lists every key the team issued with its status and exports the current ones as CSV', async () => {
    const { owner, teamId, dev } = await teamWithDev();
    await owner.post(`/teams/${teamId}/members/${dev.memberId}/reissue`);
    await owner.del(`/teams/${teamId}/seats/${dev.memberId}`);
    const list = (await owner.get(`/teams/${teamId}/licenses`)).json().licenses as {
      status: string;
      current: boolean;
      key?: string;
      assignee: { email: string; name: string };
    }[];
    expect(list.map((l) => [l.assignee.email, l.status, l.current, Boolean(l.key)])).toEqual([
      ['dev@acme.com', 'revoked', false, false],
      ['dev@acme.com', 'replaced', false, false],
      ['it@acme.com', 'active', true, true],
    ]);
    const csv = await owner.get(`/teams/${teamId}/licenses.csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.trim().split('\n');
    expect(lines[0]).toBe('email,name,role,has_account,status,edition,issued_at,expires_at,license_id,key');
    expect(lines[1]).toMatch(/^it@acme\.com,Ivy IT,owner,yes,active,pro,.*,MQL1\./);
    expect(lines[2]).toMatch(/^dev@acme\.com,Dev,member,no,no seat,/);
  });

  it('acts on members without an account by member id; ownership needs an account', async () => {
    const { owner, teamId, dev } = await teamWithDev();
    expect((await owner.patch(`/teams/${teamId}/members/${dev.memberId}`, { role: 'admin' })).json().member).toMatchObject({ role: 'admin', userId: null });
    expect((await owner.post(`/teams/${teamId}/transfer-ownership`, { memberId: dev.memberId })).json().error.code).toBe('no_account');
    expect((await owner.del(`/teams/${teamId}/members/${dev.memberId}`)).statusCode).toBe(204);
    expect((await owner.get(`/teams/${teamId}`)).json().team.seatsUsed).toBe(1);
  });

  it('an invite to someone already added by e-mail just links them', async () => {
    const { owner, teamId } = await teamWithOwner();
    const res = await owner.post(`/teams/${teamId}/invites`, { emails: ['both@acme.com'] });
    const token = tokenFrom(t.mailer.last('both@acme.com')!.text);
    expect(res.statusCode).toBe(201);
    await t.ctx.c.teamMembers.insertOne({
      _id: 'mem_manual', teamId, email: 'both@acme.com', role: 'member', hasSeat: false, edition: 'pro', features: [], joinedAt: t.clock.now,
    });
    const both = await signUp(t, 'both@acme.com', 'Both');
    expect((await both.post('/invites/accept', { token })).json()).toMatchObject({ seatAssigned: false });
    expect((await both.get('/me')).json().teams).toHaveLength(1);
  });
});

describe('asking for more seats', () => {
  it('e-mails staff, shows the request on the team, and clears it once staff raise the limit', async () => {
    await t.close();
    t = await makeApp({ env: { STAFF_EMAILS: 'ops@motionql.com' } });
    const { owner, teamId } = await teamWithOwner();
    expect((await owner.post(`/teams/${teamId}/seat-request`, { seats: 10 })).json().error.code).toBe('validation_failed');
    const res = await owner.post(`/teams/${teamId}/seat-request`, { seats: 60, note: 'New data team starts in May' });
    expect(res.statusCode).toBe(200);
    expect(res.json().team.seatRequest).toMatchObject({ seats: 60, note: 'New data team starts in May', by: 'it@acme.com' });
    const mail = t.mailer.last('ops@motionql.com')!;
    expect(mail.subject).toBe('Acme Corp asks for 60 MotionQL seats');
    expect(mail.text).toContain(`/admin/teams?q=${teamId}`);

    const dev = (await owner.post(`/teams/${teamId}/members`, { members: [{ email: 'dev@acme.com' }] })).json().members[0];
    const devClient = await signUp(t, 'dev@acme.com');
    expect((await devClient.post(`/teams/${teamId}/seat-request`, { seats: 99 })).statusCode).toBe(403);
    expect(dev.hasSeat).toBe(true);

    const staff = await makeStaff(t, 'ops@motionql.com');
    const listed = (await staff.get('/admin/teams')).json().teams;
    expect(listed[0]).toMatchObject({ id: teamId, seatRequest: { seats: 60 } });
    expect((await staff.patch(`/admin/teams/${teamId}`, { seatLimit: 40 })).json().team.seatRequest).toMatchObject({ seats: 60 });
    expect((await staff.patch(`/admin/teams/${teamId}`, { seatLimit: 60 })).json().team).toMatchObject({ seatLimit: 60, seatRequest: null });
  });
});

describe('member migration', () => {
  it('copies e-mails onto older member rows and replaces the old unique index', async () => {
    const client = new MongoClient(inject('mongoUri'));
    await client.connect();
    const db = client.db(`mq_migrate_${process.pid}_${Date.now()}`);
    try {
      const c = collections(db);
      await c.teamMembers.createIndex({ teamId: 1, userId: 1 }, { unique: true });
      await c.users.insertOne({ _id: 'usr_1', email: 'old@acme.com', name: 'Old', passwordHash: 'x', isStaff: false, createdAt: new Date(), updatedAt: new Date() });
      await c.teamMembers.insertOne({ _id: 'mem_1', teamId: 'team_1', userId: 'usr_1', role: 'owner', hasSeat: false, edition: 'pro', features: [], joinedAt: new Date() } as never);
      await ensureIndexes(c);
      await ensureIndexes(c);
      expect(await c.teamMembers.findOne({ _id: 'mem_1' })).toMatchObject({ email: 'old@acme.com', name: 'Old' });
      const names = (await c.teamMembers.indexes()).map((i) => i.name);
      expect(names).not.toContain('teamId_1_userId_1');
      expect(names).toContain('teamId_1_userId_1_linked');
      // Two people without accounts in one team no longer clash.
      await c.teamMembers.insertMany([
        { _id: 'mem_2', teamId: 'team_1', email: 'a@acme.com', role: 'member', hasSeat: false, edition: 'pro', features: [], joinedAt: new Date() },
        { _id: 'mem_3', teamId: 'team_1', email: 'b@acme.com', role: 'member', hasSeat: false, edition: 'pro', features: [], joinedAt: new Date() },
      ]);
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  });
});
