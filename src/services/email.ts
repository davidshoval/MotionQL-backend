import type { FastifyBaseLogger } from 'fastify';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Config } from '../config.js';

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Replies go here instead of to EMAIL_FROM (feedback: the sender). */
  replyTo?: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

/** Development: prints the message (with its links) to the log instead of sending it. */
export class ConsoleMailer implements Mailer {
  constructor(private readonly log: FastifyBaseLogger) {}
  async send(email: Email): Promise<void> {
    this.log.info({ to: email.to, subject: email.subject }, `email (not sent, EMAIL_PROVIDER=console)\n${email.text}`);
  }
}

/** Tests: keeps every message. */
export class MemoryMailer implements Mailer {
  readonly sent: Email[] = [];
  async send(email: Email): Promise<void> {
    this.sent.push(email);
  }
  last(to?: string): Email | undefined {
    return [...this.sent].reverse().find((e) => !to || e.to === to);
  }
}

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(email: Email): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, text: email.text, html: email.html, ...(email.replyTo ? { reply_to: email.replyTo } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Resend says why (unverified domain, test sender to another address, bad key); keep it for the log.
      const reason = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`Resend refused the message: HTTP ${res.status} ${reason}`.trim());
    }
  }
}

/** Any SMTP server, e.g. a Gmail account with an app password (smtp.gmail.com:465). */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  constructor(
    smtp: { host: string; port: number; user: string; pass: string },
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }
  async send(email: Email): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: email.to, subject: email.subject, text: email.text, html: email.html, ...(email.replyTo ? { replyTo: email.replyTo } : {}) });
  }
}

export function createMailer(config: Config, log: FastifyBaseLogger): Mailer {
  const { provider, from } = config.email;
  if (provider === 'resend') return new ResendMailer(config.email.resendApiKey!, from);
  if (provider === 'smtp') return new SmtpMailer(config.email.smtp!, from);
  return new ConsoleMailer(log);
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** One plain layout for every message: a heading, paragraphs, an optional button and an optional key block. */
function layout(opts: { heading: string; paragraphs: string[]; button?: { label: string; url: string }; code?: string; footer?: string }) {
  const text = [
    opts.heading,
    '',
    ...opts.paragraphs.flatMap((p) => [p, '']),
    ...(opts.button ? [`${opts.button.label}: ${opts.button.url}`, ''] : []),
    ...(opts.code ? [opts.code, ''] : []),
    opts.footer ?? 'MotionQL, the MongoDB GUI for everyone.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#0b1020;font-family:Inter,Segoe UI,Arial,sans-serif;color:#e6e9f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#121933;border-radius:16px;padding:32px">
<tr><td style="font-size:20px;font-weight:700;color:#ffffff;padding-bottom:8px">Motion<span style="color:#22c55e">QL</span></td></tr>
<tr><td style="font-size:22px;font-weight:600;color:#ffffff;padding:16px 0">${escapeHtml(opts.heading)}</td></tr>
${opts.paragraphs.map((p) => `<tr><td style="font-size:15px;line-height:1.6;color:#c4cadb;padding-bottom:12px">${escapeHtml(p)}</td></tr>`).join('\n')}
${opts.button ? `<tr><td style="padding:16px 0"><a href="${escapeHtml(opts.button.url)}" style="display:inline-block;background:#22c55e;color:#06210f;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:10px">${escapeHtml(opts.button.label)}</a></td></tr>` : ''}
${opts.code ? `<tr><td style="padding:8px 0"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;background:#0b1020;border:1px solid #26305a;border-radius:10px;padding:12px;color:#e6e9f2">${escapeHtml(opts.code)}</div></td></tr>` : ''}
<tr><td style="font-size:12px;color:#7d86a3;padding-top:24px">${escapeHtml(opts.footer ?? 'MotionQL, the MongoDB GUI for everyone.')}</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

export const templates = {
  verifyEmail(to: string, name: string, url: string): Email {
    return {
      to,
      subject: 'Confirm your e-mail for MotionQL',
      ...layout({
        heading: `Welcome, ${name}`,
        paragraphs: ['Confirm your e-mail address to get your MotionQL license key and download the app. The link is valid for 24 hours.'],
        button: { label: 'Confirm e-mail', url },
        footer: 'If you did not create a MotionQL account, ignore this message.',
      }),
    };
  },
  passwordReset(to: string, url: string): Email {
    return {
      to,
      subject: 'Reset your MotionQL password',
      ...layout({
        heading: 'Reset your password',
        paragraphs: ['Use the button below to choose a new password. The link is valid for 1 hour and works once.'],
        button: { label: 'Choose a new password', url },
        footer: 'If you did not ask for this, ignore this message; your password stays the same.',
      }),
    };
  },
  licenseKey(to: string, opts: { name: string; key: string; edition: string; expiresAt: string; accountUrl: string; teamName?: string }): Email {
    const edition = opts.edition === 'pro' ? 'Pro' : opts.edition === 'enterprise' ? 'Enterprise' : 'Trial';
    return {
      to,
      subject: opts.teamName ? `Your MotionQL ${edition} key from ${opts.teamName}` : `Your MotionQL ${edition} license key`,
      ...layout({
        heading: opts.teamName ? `${opts.teamName} gave you a MotionQL ${edition} seat` : `Your MotionQL ${edition} key is ready`,
        paragraphs: [
          `Hi ${opts.name}, here is your personal license key. It is valid until ${opts.expiresAt.slice(0, 10)}.`,
          'In MotionQL, open Settings → License, paste the key and click Activate. No internet connection is needed to activate.',
        ],
        code: opts.key,
        button: { label: 'Open your account', url: opts.accountUrl },
        footer: 'Keep this key private: it is tied to your e-mail address.',
      }),
    };
  },
  referralReward(to: string, opts: { name: string; friendName: string; days: number; accountUrl: string; key?: string; expiresAt?: string }): Email {
    const extra = opts.days % 30 === 0 ? `${opts.days / 30} extra month${opts.days === 30 ? '' : 's'}` : `${opts.days} extra days`;
    return {
      to,
      subject: `You earned ${extra} of MotionQL Pro`,
      ...layout({
        heading: `Thanks for inviting ${opts.friendName || 'a friend'}`,
        paragraphs: opts.key
          ? [
              `Hi ${opts.name}, ${opts.friendName || 'your friend'} joined MotionQL with your invite link, so you both get ${extra} of Pro.`,
              `Here is your new key. It is valid until ${opts.expiresAt!.slice(0, 10)}. In MotionQL, open Settings → License, paste it and click Activate. Your current key keeps working until its own date.`,
            ]
          : [
              `Hi ${opts.name}, ${opts.friendName || 'your friend'} joined MotionQL with your invite link, so you both get ${extra} of Pro.`,
              'The extra time will be added to your next free license key, which you can get from your account.',
            ],
        button: { label: 'Open your account', url: opts.accountUrl },
        ...(opts.key ? { code: opts.key, footer: 'Keep this key private: it is tied to your e-mail address.' } : {}),
      }),
    };
  },
  invite(to: string, opts: { teamName: string; inviter: string; url: string; withSeat: boolean }): Email {
    return {
      to,
      subject: `${opts.inviter} invited you to ${opts.teamName} on MotionQL`,
      ...layout({
        heading: `Join ${opts.teamName} on MotionQL`,
        paragraphs: [
          `${opts.inviter} invited you to the ${opts.teamName} team.${opts.withSeat ? ' You get your own Pro license key when you join.' : ''}`,
          'The invitation is valid for 14 days.',
        ],
        button: { label: 'Accept invitation', url: opts.url },
      }),
    };
  },
  seatRemoved(to: string, opts: { teamName: string }): Email {
    return {
      to,
      subject: `Your ${opts.teamName} seat on MotionQL was removed`,
      ...layout({
        heading: 'Your team seat was removed',
        paragraphs: [
          `An admin of ${opts.teamName} removed your seat. Your team license key stops working within a few hours.`,
          'Your MotionQL account stays, and everything that is free in the app keeps working.',
        ],
      }),
    };
  },
  feedback(to: string, opts: { kind: string; message: string; from?: string; where: string }): Email {
    const firstLine = opts.message.split('\n').find((l) => l.trim())?.trim() ?? '';
    const preview = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
    return {
      to,
      subject: `MotionQL feedback (${opts.kind}): ${preview}`,
      ...(opts.from ? { replyTo: opts.from } : {}),
      ...layout({
        heading: `New feedback: ${opts.kind}`,
        paragraphs: [
          ...opts.message.split(/\n+/).map((l) => l.trim()).filter(Boolean),
          `From: ${opts.from ?? 'no e-mail address given'}`,
          `Sent from: ${opts.where}`,
        ],
        footer: opts.from ? 'Reply to this e-mail to answer the sender.' : 'The sender left no e-mail address, so there is no one to reply to.',
      }),
    };
  },
};
