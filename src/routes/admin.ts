import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { actorOf, requireStaff } from '../plugins/session.js';
import {
  extendLicense, issueManual, overview, revokeByStaff, searchLicenses, searchTeams, searchUsers, setStaff, updateTeamLimits, userDetail,
} from '../services/admin.js';
import { licenseView } from '../services/licenses.js';
import { getManifestSettings, updateManifestSettings } from '../services/product.js';
import { getFreePlan, getTeamPlan, updateFreePlan, updateTeamPlan } from '../services/settings.js';
import { listAudit } from '../services/teams.js';
import { edition, email, features, id, limit } from './schemas.js';

const search = z.object({ q: z.string().trim().max(200).optional(), limit });
const days = z.number().int().min(1).max(3650);

const planView = <T extends { _id: string; updatedAt?: Date }>({ _id, updatedAt, ...rest }: T) => ({ ...rest, updatedAt: updatedAt?.toISOString() ?? null });

/** The staff console. Every call requires a staff account (`npm run make-staff -- you@example.com`). */
export const adminRoutes = (ctx: Ctx): FastifyPluginAsyncZod => async (app) => {
  app.get('/admin/overview', { schema: { tags: ['admin'] } }, async (req) => {
    await requireStaff(ctx, req);
    return overview(ctx);
  });

  // The free-year switch: whether it is free, how long it lasts and which edition it gives.
  app.get('/admin/plans', { schema: { tags: ['admin'] } }, async (req) => {
    await requireStaff(ctx, req);
    return { free: planView(await getFreePlan(ctx)), team: planView(await getTeamPlan(ctx)) };
  });

  app.put('/admin/plans/free', {
    schema: {
      tags: ['admin'],
      body: z.object({ enabled: z.boolean(), edition, features, durationDays: days, renewable: z.boolean(), renewWindowDays: z.number().int().min(0).max(365) }).partial(),
    },
  }, async (req) => {
    const staff = await requireStaff(ctx, req);
    return { free: planView(await updateFreePlan(ctx, actorOf(staff), req.body)) };
  });

  app.put('/admin/plans/team', {
    schema: { tags: ['admin'], body: z.object({ defaultSeatLimit: z.number().int().min(1).max(100_000), edition, durationDays: days }).partial() },
  }, async (req) => {
    const staff = await requireStaff(ctx, req);
    return { team: planView(await updateTeamPlan(ctx, actorOf(staff), req.body)) };
  });

  app.get('/admin/users', { schema: { tags: ['admin'], querystring: search } }, async (req) => {
    await requireStaff(ctx, req);
    return { users: await searchUsers(ctx, req.query.q, req.query.limit) };
  });

  app.get('/admin/users/:userId', { schema: { tags: ['admin'], params: z.object({ userId: id }) } }, async (req) => {
    await requireStaff(ctx, req);
    return userDetail(ctx, req.params.userId);
  });

  app.put('/admin/users/:userId/staff', { schema: { tags: ['admin'], params: z.object({ userId: id }), body: z.object({ isStaff: z.boolean() }) } }, async (req) => {
    const staff = await requireStaff(ctx, req);
    return { user: await setStaff(ctx, actorOf(staff), req.params.userId, req.body.isStaff) };
  });

  app.get('/admin/teams', { schema: { tags: ['admin'], querystring: search } }, async (req) => {
    await requireStaff(ctx, req);
    return { teams: await searchTeams(ctx, req.query.q, req.query.limit) };
  });

  app.patch('/admin/teams/:teamId', {
    schema: {
      tags: ['admin'],
      params: z.object({ teamId: id }),
      body: z.object({ seatLimit: z.number().int().min(1).max(100_000), allowedEditions: z.array(edition).min(1), allowedFeatures: features }).partial(),
    },
  }, async (req) => {
    const staff = await requireStaff(ctx, req);
    return { team: await updateTeamLimits(ctx, actorOf(staff), req.params.teamId, req.body) };
  });

  app.get('/admin/licenses', { schema: { tags: ['admin'], querystring: search } }, async (req) => {
    await requireStaff(ctx, req);
    return { licenses: await searchLicenses(ctx, req.query.q, req.query.limit) };
  });

  app.post('/admin/licenses', {
    schema: { tags: ['admin'], body: z.object({ email, customer: z.string().trim().min(1).max(200), edition, features: features.default([]), durationDays: days }) },
  }, async (req, reply) => {
    const staff = await requireStaff(ctx, req);
    const doc = await issueManual(ctx, actorOf(staff), req.body);
    return reply.code(201).send({ license: licenseView(doc, ctx.now()) });
  });

  app.post('/admin/licenses/:licenseId/revoke', {
    schema: { tags: ['admin'], params: z.object({ licenseId: id }), body: z.object({ reason: z.string().trim().min(1).max(500) }) },
  }, async (req, reply) => {
    const staff = await requireStaff(ctx, req);
    await revokeByStaff(ctx, actorOf(staff), req.params.licenseId, req.body.reason);
    return reply.code(204).send();
  });

  app.post('/admin/licenses/:licenseId/extend', { schema: { tags: ['admin'], params: z.object({ licenseId: id }), body: z.object({ days }) } }, async (req, reply) => {
    const staff = await requireStaff(ctx, req);
    const doc = await extendLicense(ctx, actorOf(staff), req.params.licenseId, req.body.days);
    return reply.code(201).send({ license: licenseView(doc, ctx.now()) });
  });

  app.get('/admin/manifest', { schema: { tags: ['admin'] } }, async (req) => {
    await requireStaff(ctx, req);
    return getManifestSettings(ctx);
  });

  // Bodies are checked with the app's own manifest validator, so the staff console can send them as typed.
  app.put('/admin/manifest', {
    schema: { tags: ['admin'], body: z.object({ requiredUpdate: z.unknown().optional(), notifications: z.array(z.unknown()).max(50).optional(), includeRevocations: z.boolean().optional() }) },
  }, async (req) => {
    const staff = await requireStaff(ctx, req);
    await updateManifestSettings(ctx, actorOf(staff), req.body);
    return getManifestSettings(ctx);
  });

  app.get('/admin/audit', { schema: { tags: ['admin'], querystring: z.object({ before: id.optional(), limit, teamId: id.optional() }) } }, async (req) => {
    await requireStaff(ctx, req);
    return listAudit(ctx, { teamId: req.query.teamId }, req.query.before, req.query.limit);
  });
};
