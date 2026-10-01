import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { actorOf, requireUser } from '../plugins/session.js';
import { licenseView } from '../services/licenses.js';
import {
  acceptInvite, assignSeatTo, auditCsv, cancelInvite, createTeam, deleteTeam, freeSeatOf, inviteMembers, inviteView, listAudit, listInvites,
  listMembers, previewInvite, reissueMemberKey, removeMember, renameTeam, resendInvite, teamAccess, teamView, transferOwnership, updateMember,
} from '../services/teams.js';
import { edition, email, features, id, token } from './schemas.js';

const teamName = z.string().trim().min(2, 'Use at least 2 characters.').max(100);
const teamParams = z.object({ teamId: id });
const memberParams = z.object({ teamId: id, userId: id });
const inviteParams = z.object({ teamId: id, inviteId: id });

export const teamRoutes = (ctx: Ctx): FastifyPluginAsyncZod => async (app) => {
  app.post('/teams', { schema: { tags: ['teams'], body: z.object({ name: teamName }) } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const team = await createTeam(ctx, user, req.body.name);
    return reply.code(201).send({ team: teamView(team) });
  });

  app.get('/teams/:teamId', { schema: { tags: ['teams'], params: teamParams } }, async (req) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'member');
    return { team: teamView(access.team), role: access.role };
  });

  app.patch('/teams/:teamId', { schema: { tags: ['teams'], params: teamParams, body: z.object({ name: teamName }) } }, async (req) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    return { team: teamView(await renameTeam(ctx, access, actorOf(user), req.body.name)) };
  });

  app.delete('/teams/:teamId', { schema: { tags: ['teams'], params: teamParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'owner');
    await deleteTeam(ctx, access, actorOf(user));
    return reply.code(204).send();
  });

  app.post('/teams/:teamId/transfer-ownership', { schema: { tags: ['teams'], params: teamParams, body: z.object({ userId: id }) } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'owner');
    await transferOwnership(ctx, access, actorOf(user), req.body.userId);
    return reply.code(204).send();
  });

  app.get('/teams/:teamId/members', { schema: { tags: ['teams'], params: teamParams } }, async (req) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'member');
    const members = await listMembers(ctx, access.team._id);
    // Members see the roster; only admins see keys' usage.
    const isAdmin = access.role !== 'member';
    return { members: isAdmin ? members : members.map(({ usage: _usage, ...m }) => m) };
  });

  app.patch('/teams/:teamId/members/:userId', {
    schema: { tags: ['teams'], params: memberParams, body: z.object({ role: z.enum(['admin', 'member']).optional(), edition: edition.optional(), features: features.optional() }) },
  }, async (req) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const m = await updateMember(ctx, access, actorOf(user), req.params.userId, req.body);
    return { member: { userId: m.userId, role: m.role, hasSeat: m.hasSeat, edition: m.edition, features: m.features } };
  });

  // Admins remove anyone but the owner; any member can remove themselves (leave).
  app.delete('/teams/:teamId/members/:userId', { schema: { tags: ['teams'], params: memberParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const self = req.params.userId === user._id;
    const access = await teamAccess(ctx, req.params.teamId, user, self ? 'member' : 'admin');
    await removeMember(ctx, access.team, actorOf(user), req.params.userId, self);
    return reply.code(204).send();
  });

  app.post('/teams/:teamId/seats/:userId', { schema: { tags: ['teams'], params: memberParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const license = await assignSeatTo(ctx, access, actorOf(user), req.params.userId);
    return reply.code(201).send({ license: licenseView(license, ctx.now(), access.team.name) });
  });

  app.delete('/teams/:teamId/seats/:userId', { schema: { tags: ['teams'], params: memberParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    await freeSeatOf(ctx, access, actorOf(user), req.params.userId);
    return reply.code(204).send();
  });

  app.post('/teams/:teamId/members/:userId/reissue', { schema: { tags: ['teams'], params: memberParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const license = await reissueMemberKey(ctx, access, actorOf(user), req.params.userId);
    return reply.code(201).send({ license: licenseView(license, ctx.now(), access.team.name) });
  });

  app.post('/teams/:teamId/invites', {
    schema: { tags: ['teams'], params: teamParams, body: z.object({ emails: z.array(email).min(1).max(100), role: z.enum(['admin', 'member']).default('member'), assignSeat: z.boolean().default(true) }) },
  }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const result = await inviteMembers(ctx, access, actorOf(user), req.body);
    return reply.code(201).send({ invites: result.invites.map((i) => inviteView(i)), skipped: result.skipped });
  });

  app.get('/teams/:teamId/invites', { schema: { tags: ['teams'], params: teamParams } }, async (req) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    return { invites: (await listInvites(ctx, access.team._id)).map((i) => inviteView(i)) };
  });

  app.post('/teams/:teamId/invites/:inviteId/resend', { schema: { tags: ['teams'], params: inviteParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    await resendInvite(ctx, access, actorOf(user), req.params.inviteId);
    return reply.code(204).send();
  });

  app.delete('/teams/:teamId/invites/:inviteId', { schema: { tags: ['teams'], params: inviteParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    await cancelInvite(ctx, access, actorOf(user), req.params.inviteId);
    return reply.code(204).send();
  });

  app.get('/teams/:teamId/audit', {
    schema: { tags: ['teams'], params: teamParams, querystring: z.object({ before: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) },
  }, async (req) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    return listAudit(ctx, { teamId: access.team._id }, req.query.before, req.query.limit);
  });

  app.get('/teams/:teamId/audit.csv', { schema: { tags: ['teams'], params: teamParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const csv = await auditCsv(ctx, access.team._id);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="xquery-team-audit-${access.team._id}.csv"`)
      .send(csv);
  });

  // Invitations, from the invitee's side.

  // POST so the token stays out of access logs.
  app.post('/invites/preview', { schema: { tags: ['teams'], body: z.object({ token }) } }, async (req) => previewInvite(ctx, req.body.token));

  app.post('/invites/accept', { schema: { tags: ['teams'], body: z.object({ token }) } }, async (req) => {
    const user = await requireUser(ctx, req);
    const { team, seatAssigned } = await acceptInvite(ctx, user, req.body.token);
    return { team: teamView(team), seatAssigned };
  });
};
