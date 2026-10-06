import type { Actor, Ctx } from '../context.js';
import type { FeedbackDoc, FeedbackKind, FeedbackStatus, UserDoc } from '../db.js';
import { notFound } from '../errors.js';
import { newId } from '../lib/ids.js';
import { audit } from './audit.js';
import { templates } from './email.js';

export const FEEDBACK_KINDS = ['bug', 'idea', 'praise', 'other'] as const;
export const FEEDBACK_STATUSES = ['new', 'read', 'done'] as const;

const KIND_LABEL: Record<FeedbackKind, string> = { bug: 'Bug report', idea: 'Idea', praise: 'Praise', other: 'Other' };

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  email?: string;
  page?: string;
  app?: FeedbackDoc['app'];
}

function where(doc: FeedbackDoc): string {
  if (doc.app) {
    const extra = [doc.app.channel, doc.app.edition].filter(Boolean).join(', ');
    return `MotionQL ${doc.app.version} on ${doc.app.platform} ${doc.app.arch}${extra ? ` (${extra})` : ''}`;
  }
  return `the website${doc.page ? `, ${doc.page}` : ''}`;
}

/**
 * Stores the message, then e-mails it to every address in STAFF_EMAILS. Sending never fails the request: the
 * message is already saved and staff can read it with GET /admin/feedback.
 */
export async function submitFeedback(ctx: Ctx, source: FeedbackDoc['source'], input: FeedbackInput, user?: UserDoc | null): Promise<FeedbackDoc> {
  const email = input.email?.toLowerCase() || user?.email;
  const doc: FeedbackDoc = {
    _id: newId('fb'),
    kind: input.kind,
    message: input.message,
    source,
    ...(email ? { email } : {}),
    ...(user ? { userId: user._id } : {}),
    ...(input.page ? { page: input.page } : {}),
    ...(input.app ? { app: input.app } : {}),
    status: 'new',
    createdAt: ctx.now(),
  };
  await ctx.c.feedback.insertOne(doc);

  const results = await Promise.allSettled(
    ctx.config.staffEmails.map((to) =>
      ctx.mailer.send(templates.feedback(to, { kind: KIND_LABEL[doc.kind], message: doc.message, from: doc.email, where: where(doc) })),
    ),
  );
  for (const r of results) if (r.status === 'rejected') ctx.log.error({ err: r.reason, feedbackId: doc._id }, 'feedback e-mail failed');
  return doc;
}

export const feedbackView = (d: FeedbackDoc) => ({
  id: d._id,
  kind: d.kind,
  message: d.message,
  source: d.source,
  email: d.email ?? null,
  userId: d.userId ?? null,
  page: d.page ?? null,
  app: d.app ?? null,
  status: d.status,
  createdAt: d.createdAt.toISOString(),
});

/** Newest first; `before` is the id of the last item of the previous page. */
export async function listFeedback(ctx: Ctx, opts: { status?: FeedbackStatus; before?: string; limit: number }) {
  const docs = await ctx.c.feedback
    .find({ ...(opts.status ? { status: opts.status } : {}), ...(opts.before ? { _id: { $lt: opts.before } } : {}) })
    .sort({ _id: -1 })
    .limit(opts.limit + 1)
    .toArray();
  const page = docs.slice(0, opts.limit);
  return { feedback: page.map(feedbackView), nextCursor: docs.length > opts.limit ? page.at(-1)!._id : null };
}

export async function setFeedbackStatus(ctx: Ctx, actor: Actor, id: string, status: FeedbackStatus) {
  const doc = await ctx.c.feedback.findOneAndUpdate(
    { _id: id },
    { $set: { status, updatedAt: ctx.now(), updatedBy: actor.id } },
    { returnDocument: 'after' },
  );
  if (!doc) throw notFound();
  await audit(ctx, actor, 'feedback.status', { target: { type: 'feedback', id }, details: { status } });
  return feedbackView(doc);
}
