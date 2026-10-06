import { afterEach, describe, expect, it } from 'vitest';
import { Client, makeApp, makeStaff, signUp, tokenFrom } from './helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY);

async function activeFreeKeys(client: Client) {
  const { licenses } = (await client.get('/me/licenses')).json() as { licenses: { status: string; source: string; issuedAt: string; expiresAt: string }[] };
  return licenses.filter((l) => l.status === 'active' && l.source === 'free');
}

describe('refer a friend', () => {
  it('gives every account an invite link and counts sign-ups through it, with no reward while it is off', async () => {
    t = await makeApp();
    const alice = await signUp(t, 'alice@example.com', 'Alice Smith');
    const mine = (await alice.get('/me/referral')).json();
    expect(mine.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(mine.url).toBe(`https://motionql.com/r/${mine.code}`);
    expect(mine).toMatchObject({ signups: 0, confirmed: 0, rewarded: 0, reward: null });
    // Same code on every call.
    expect((await alice.get('/me/referral')).json().code).toBe(mine.code);

    // The landing page shows the first name only, and accepts the code in any case.
    const preview = await new Client(t).get(`/referrals/${mine.code.toLowerCase()}`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ code: mine.code, inviterName: 'Alice', reward: null });
    expect((await new Client(t).get('/referrals/NOPE2345')).statusCode).toBe(404);

    const bob = await signUp(t, 'bob@example.com', 'Bob', { referralCode: mine.code, heardFrom: 'A friend' });
    // Signed up but not confirmed yet.
    await new Client(t).post('/auth/register', { email: 'carol@example.com', password: 'correct horse battery', name: 'Carol', referralCode: mine.code });
    expect((await alice.get('/me/referral')).json()).toMatchObject({ signups: 2, confirmed: 1, rewarded: 0 });

    const bobUser = await t.ctx.c.users.findOne({ email: 'bob@example.com' });
    const aliceUser = await t.ctx.c.users.findOne({ email: 'alice@example.com' });
    expect(bobUser).toMatchObject({ referredBy: aliceUser!._id, heardFrom: 'A friend' });
    expect(bobUser!.referralRewardedAt).toBeUndefined();
    // Reward off: both keep the plain free year.
    const [bobKey] = await activeFreeKeys(bob);
    expect(daysBetween(bobKey!.issuedAt, bobKey!.expiresAt)).toBe(365);
    expect(await activeFreeKeys(alice)).toHaveLength(1);
  });

  it('ignores an unknown code instead of failing the sign-up', async () => {
    t = await makeApp();
    await signUp(t, 'dan@example.com', 'Dan', { referralCode: 'ZZZZZZZZ' });
    const dan = await t.ctx.c.users.findOne({ email: 'dan@example.com' });
    expect(dan!.referredBy).toBeUndefined();
    expect(dan!.referralCode).toMatch(/^[A-Z2-9]{8}$/);
  });

  it('when on, adds the bonus to both free keys once the friend confirms, and caps rewards per inviter', async () => {
    t = await makeApp();
    const staff = await makeStaff(t, 'staff@motionql.com');
    expect((await staff.get('/admin/plans')).json().referral).toMatchObject({ enabled: false, bonusDays: 90, maxRewardsPerUser: 12 });
    const updated = await staff.put('/admin/plans/referral', { enabled: true, maxRewardsPerUser: 1 });
    expect(updated.json().referral).toMatchObject({ enabled: true, bonusDays: 90, maxRewardsPerUser: 1 });

    const alice = await signUp(t, 'alice@example.com', 'Alice');
    const { code } = (await alice.get('/me/referral')).json();
    expect((await new Client(t).get(`/referrals/${code}`)).json().reward).toEqual({ bonusDays: 90 });
    t.clock.advanceDays(10);

    const bob = await signUp(t, 'bob@example.com', 'Bob Jones', { referralCode: code });
    // Bob's first key already carries his bonus: one key, a year and 90 days.
    const bobKeys = await activeFreeKeys(bob);
    expect(bobKeys).toHaveLength(1);
    expect(daysBetween(bobKeys[0]!.issuedAt, bobKeys[0]!.expiresAt)).toBe(365 + 90);

    // Alice gets a new key running 90 days past her current one; the old key keeps working.
    const aliceKeys = await activeFreeKeys(alice);
    expect(aliceKeys).toHaveLength(2);
    expect(daysBetween(aliceKeys[1]!.expiresAt, aliceKeys[0]!.expiresAt)).toBe(90);
    const mail = t.mailer.last('alice@example.com')!;
    expect(mail.subject).toBe('You earned 3 extra months of MotionQL Pro');
    expect(mail.text).toContain('Bob joined MotionQL');
    expect(mail.text).toContain('MQL1.');
    expect((await alice.get('/me/referral')).json()).toMatchObject({ signups: 1, confirmed: 1, rewarded: 1, reward: { bonusDays: 90, maxRewards: 1, remaining: 0 } });

    // Over the cap: the sign-up still counts, with no reward.
    const carol = await signUp(t, 'carol@example.com', 'Carol', { referralCode: code });
    const [carolKey] = await activeFreeKeys(carol);
    expect(daysBetween(carolKey!.issuedAt, carolKey!.expiresAt)).toBe(365);
    expect(await activeFreeKeys(alice)).toHaveLength(2);

    const stats = (await staff.get('/admin/referrals')).json();
    expect(stats.referredSignups).toBe(2);
    expect(stats.topInviters[0]).toMatchObject({ email: 'alice@example.com', signups: 2, confirmed: 2, rewarded: 1 });
    const aliceId = (await t.ctx.c.users.findOne({ email: 'alice@example.com' }))!._id;
    expect((await staff.get(`/admin/users/${aliceId}`)).json().referral).toMatchObject({ code, signups: 2 });
  });

  it('banks the inviter reward when they have no free key, and adds it to their next one', async () => {
    t = await makeApp();
    const staff = await makeStaff(t, 'staff@motionql.com');
    await staff.put('/admin/plans/referral', { enabled: true, bonusDays: 30 });
    const alice = await signUp(t, 'alice@example.com', 'Alice');
    const { code } = (await alice.get('/me/referral')).json();
    const aliceUser = (await t.ctx.c.users.findOne({ email: 'alice@example.com' }))!;
    await t.ctx.c.licenses.updateMany({ userId: aliceUser._id }, { $set: { revokedAt: t.clock.now } });

    await signUp(t, 'bob@example.com', 'Bob', { referralCode: code });
    expect((await t.ctx.c.users.findOne({ _id: aliceUser._id }))!.bonusDays).toBe(30);
    expect(t.mailer.last('alice@example.com')!.text).toContain('added to your next free license key');

    const renewed = await alice.post('/me/licenses/renew');
    expect(renewed.statusCode).toBe(201);
    const key = renewed.json().license;
    expect(daysBetween(key.issuedAt, key.expiresAt)).toBe(365 + 30);
    expect((await t.ctx.c.users.findOne({ _id: aliceUser._id }))!.bonusDays).toBeUndefined();
  });

  it('pays once per invited user, and not for an unconfirmed inviter', async () => {
    t = await makeApp();
    const staff = await makeStaff(t, 'staff@motionql.com');
    await staff.put('/admin/plans/referral', { enabled: true });
    // An inviter who never confirmed their e-mail.
    await new Client(t).post('/auth/register', { email: 'ghost@example.com', password: 'correct horse battery', name: 'Ghost' });
    const ghost = (await t.ctx.c.users.findOne({ email: 'ghost@example.com' }))!;
    const bob = await signUp(t, 'bob@example.com', 'Bob', { referralCode: ghost.referralCode });
    const [bobKey] = await activeFreeKeys(bob);
    expect(daysBetween(bobKey!.issuedAt, bobKey!.expiresAt)).toBe(365);

    // A second verify link (resend) does not pay twice.
    const alice = await signUp(t, 'alice@example.com', 'Alice');
    const { code } = (await alice.get('/me/referral')).json();
    const carol = new Client(t);
    await carol.post('/auth/register', { email: 'carol@example.com', password: 'correct horse battery', name: 'Carol', referralCode: code });
    await carol.post('/auth/resend-verification', { email: 'carol@example.com' });
    await carol.post('/auth/verify-email', { token: tokenFrom(t.mailer.last('carol@example.com')!.text) });
    expect(await activeFreeKeys(alice)).toHaveLength(2);
    expect((await alice.get('/me/referral')).json().rewarded).toBe(1);
  });

  it('gives accounts made before referrals a code on first use', async () => {
    t = await makeApp();
    const old = await signUp(t, 'old@example.com', 'Old Timer');
    await t.ctx.c.users.updateOne({ email: 'old@example.com' }, { $unset: { referralCode: '' } });
    const { code } = (await old.get('/me/referral')).json();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect((await t.ctx.c.users.findOne({ email: 'old@example.com' }))!.referralCode).toBe(code);
  });
});
