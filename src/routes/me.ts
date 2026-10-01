import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { clearSessionCookie, requireUser } from '../plugins/session.js';
import { deleteAccount } from '../services/accountDeletion.js';
import { updateProfile, userView } from '../services/accounts.js';
import { licenseView, reissueOwnLicense, renewFreeLicense } from '../services/licenses.js';
import { getFreePlan } from '../services/settings.js';
import { company, id, personName } from './schemas.js';

export const meRoutes = (ctx: Ctx): FastifyPluginAsyncZod => async (app) => {
  app.get('/me', { schema: { tags: ['me'] } }, async (req) => {
    const user = await requireUser(ctx, req);
    const memberships = await ctx.c.teamMembers.find({ userId: user._id }).toArray();
    const teams = await ctx.c.teams.find({ _id: { $in: memberships.map((m) => m.teamId) } }).toArray();
    const invites = await ctx.c.invites.find({ email: user.email, expiresAt: { $gt: ctx.now() } }).toArray();
    const inviteTeams = await ctx.c.teams.find({ _id: { $in: invites.map((i) => i.teamId) } }).toArray();
    return {
      user: userView(user),
      teams: memberships.flatMap((m) => {
        const t = teams.find((x) => x._id === m.teamId);
        return t ? [{ id: t._id, name: t.name, role: m.role, hasSeat: m.hasSeat }] : [];
      }),
      pendingInvites: invites.flatMap((i) => {
        const t = inviteTeams.find((x) => x._id === i.teamId);
        return t ? [{ id: i._id, teamName: t.name, role: i.role, invitedBy: i.invitedBy }] : [];
      }),
    };
  });

  app.patch('/me', { schema: { tags: ['me'], body: z.object({ name: personName.optional(), company: company.nullable().optional() }) } }, async (req) => {
    const user = await requireUser(ctx, req);
    return { user: userView(await updateProfile(ctx, user, req.body)) };
  });

  app.delete('/me', { schema: { tags: ['me'], body: z.object({ password: z.string().min(1).max(200) }) } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    await deleteAccount(ctx, user, req.body.password);
    clearSessionCookie(ctx, reply);
    return reply.code(204).send();
  });

  app.get('/me/licenses', { schema: { tags: ['me'] } }, async (req) => {
    const user = await requireUser(ctx, req);
    const docs = await ctx.c.licenses.find({ userId: user._id }).sort({ issuedAt: -1, _id: -1 }).limit(100).toArray();
    const teams = new Map((await ctx.c.teams.find({ _id: { $in: docs.flatMap((d) => (d.teamId ? [d.teamId] : [])) } }).toArray()).map((t) => [t._id, t.name]));
    const now = ctx.now();
    return { licenses: docs.map((d) => licenseView(d, now, d.teamId ? teams.get(d.teamId) : undefined)) };
  });

  app.post('/me/licenses/renew', { schema: { tags: ['me'] } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const doc = await renewFreeLicense(ctx, user);
    return reply.code(201).send({ license: licenseView(doc, ctx.now()) });
  });

  app.post('/me/licenses/:licenseId/reissue', { schema: { tags: ['me'], params: z.object({ licenseId: id }) } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const doc = await reissueOwnLicense(ctx, user, req.params.licenseId);
    return reply.code(201).send({ license: licenseView(doc, ctx.now()) });
  });

  app.get('/plans/free', { schema: { tags: ['public'] } }, async () => {
    const plan = await getFreePlan(ctx);
    return { enabled: plan.enabled, edition: plan.edition, features: plan.features, durationDays: plan.durationDays, renewable: plan.renewable };
  });
};
