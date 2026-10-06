import { afterEach, describe, expect, it } from 'vitest';
import { Client, makeApp, makeStaff, signUp } from './helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

const APP = { version: '1.2.1', platform: 'darwin', arch: 'arm64', channel: 'stable', edition: 'pro' };

describe('feedback', () => {
  it('stores website feedback and e-mails every staff address, replying to the sender', async () => {
    t = await makeApp({ env: { STAFF_EMAILS: 'owner@motionql.com,second@motionql.com' } });
    const res = await new Client(t).post('/feedback', { kind: 'idea', message: 'Dark mode for charts\nplease', email: 'Fan@Example.com', page: '/pricing' });
    expect(res.statusCode).toBe(204);

    const doc = await t.ctx.c.feedback.findOne({});
    expect(doc).toMatchObject({ kind: 'idea', source: 'website', email: 'fan@example.com', page: '/pricing', status: 'new' });
    expect(doc!.userId).toBeUndefined();

    const mail = t.mailer.last('owner@motionql.com')!;
    expect(mail.subject).toBe('MotionQL feedback (Idea): Dark mode for charts');
    expect(mail.replyTo).toBe('fan@example.com');
    expect(mail.text).toContain('please');
    expect(mail.text).toContain('Sent from: the website, /pricing');
    expect(t.mailer.last('second@motionql.com')).toBeDefined();
  });

  it('attaches the signed-in user and uses their address when none is given', async () => {
    t = await makeApp({ env: { STAFF_EMAILS: 'owner@motionql.com' } });
    const user = await signUp(t, 'member@example.com');
    expect((await user.post('/feedback', { kind: 'bug', message: 'The download button is grey', email: '' })).statusCode).toBe(204);
    const doc = await t.ctx.c.feedback.findOne({});
    expect(doc).toMatchObject({ email: 'member@example.com', kind: 'bug' });
    expect(doc!.userId).toMatch(/^usr_/);
  });

  it('refuses empty messages and drops what bots send through the hidden field', async () => {
    t = await makeApp({ env: { STAFF_EMAILS: 'owner@motionql.com' } });
    const c = new Client(t);
    const short = await c.post('/feedback', { kind: 'bug', message: '  ' });
    expect(short.statusCode).toBe(400);
    expect(short.json().error.fields.message).toBeDefined();
    expect((await c.post('/feedback', { kind: 'nope', message: 'hello there' })).statusCode).toBe(400);
    expect((await c.post('/feedback', { kind: 'bug', message: 'buy cheap things', website: 'http://spam' })).statusCode).toBe(204);
    expect(await t.ctx.c.feedback.countDocuments()).toBe(0);
    expect(t.mailer.sent).toHaveLength(0);
  });

  it('refuses website feedback from another origin', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'POST', url: '/feedback', headers: { origin: 'https://evil.example' }, payload: { kind: 'bug', message: 'hello there' } });
    expect(res.statusCode).toBe(403);
  });

  it('takes app feedback without cookies or Origin, with what the app runs on', async () => {
    t = await makeApp({ env: { STAFF_EMAILS: 'owner@motionql.com' } });
    const res = await t.app.inject({ method: 'POST', url: '/v1/feedback', payload: { kind: 'bug', message: 'Crash when exporting', app: APP } });
    expect(res.statusCode).toBe(204);
    expect(await t.ctx.c.feedback.findOne({})).toMatchObject({ source: 'app', app: APP });
    const mail = t.mailer.last('owner@motionql.com')!;
    expect(mail.text).toContain('Sent from: MotionQL 1.2.1 on darwin arm64 (stable, pro)');
    expect(mail.text).toContain('From: no e-mail address given');
    expect(mail.replyTo).toBeUndefined();

    const extra = await t.app.inject({ method: 'POST', url: '/v1/feedback', payload: { kind: 'bug', message: 'hello there', app: APP, installId: 'x' } });
    expect(extra.statusCode).toBe(400);
  });

  it('still saves the message when e-mail fails', async () => {
    t = await makeApp({ env: { STAFF_EMAILS: 'owner@motionql.com' } });
    t.ctx.mailer.send = async () => {
      throw new Error('Resend is down');
    };
    expect((await new Client(t).post('/feedback', { kind: 'other', message: 'Just saying hi' })).statusCode).toBe(204);
    expect(await t.ctx.c.feedback.countDocuments()).toBe(1);
  });

  it('lets staff list feedback and mark it done', async () => {
    t = await makeApp();
    const c = new Client(t);
    for (const message of ['first one', 'second one', 'third one']) await c.post('/feedback', { kind: 'idea', message });
    expect((await c.get('/admin/feedback')).statusCode).toBe(401);

    const staff = await makeStaff(t, 'staff@motionql.com');
    const page = (await staff.get('/admin/feedback?limit=2')).json();
    expect(page.feedback.map((f: { message: string }) => f.message)).toEqual(['third one', 'second one']);
    const rest = (await staff.get(`/admin/feedback?limit=2&before=${page.nextCursor}`)).json();
    expect(rest.feedback.map((f: { message: string }) => f.message)).toEqual(['first one']);
    expect(rest.nextCursor).toBeNull();

    const done = await staff.patch(`/admin/feedback/${page.feedback[0].id}`, { status: 'done' });
    expect(done.json().feedback.status).toBe('done');
    expect((await staff.get('/admin/feedback?status=new')).json().feedback).toHaveLength(2);
    expect((await staff.patch('/admin/feedback/fb_missing', { status: 'read' })).statusCode).toBe(404);
  });
});
