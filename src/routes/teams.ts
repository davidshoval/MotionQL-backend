import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { actorOf, requireUser } from '../plugins/session.js';
import { licenseView } from '../services/licenses.js';
import {
  acceptInvite, addMembers, assignSeatTo, auditCsv, cancelInvite, createTeam, deleteTeam, findMember, freeSeatOf, inviteMembers, inviteView,
  licensesCsv, listAudit, listInvites, listMembers, listTeamLicenses, previewInvite, reassignSeat, reissueMemberKey, removeMember, renameTeam,
  renewExpiring, renewMemberKey, requestSeats, resendInvite, sendMemberKey, teamAccess, teamView, transferOwnership, updateMember,
} from '../services/teams.js';
import type { MemberView } from '../services/teams.js';
import { edition, email, features, id, token } from './schemas.js';

const teamName = z.string().trim().min(2, 'Use at least 2 characters.').max(100);
const teamParams = z.object({ teamId: id });
// :memberId is a member id (mem_…) or, as older clients send, the member's account id.
const memberParams = z.object({ teamId: id, memberId: id });
const optionalName = z.string().trim().max(100).optional();
const person = z.object({ email, name: optionalName });
const inviteParams = z.object({ teamId: id, inviteId: id });

const rosterOnly = ({ usage: _usage, license, addedBy: _addedBy, ...m }: MemberView) => ({
  ...m,
  ...(license ? { license: { licenseId: license.licenseId, edition: license.edition, features: license.features, issuedAt: license.issuedAt, expiresAt: license.expiresAt, status: license.status } } : {}),
});

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

  app.post('/teams/:teamId/transfer-ownership', {
    schema: { tags: ['teams'], params: teamParams, body: z.object({ memberId: id.optional(), userId: id.optional() }).refine((b) => b.memberId || b.userId, 'Say who.') },
  }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'owner');
    await transferOwnership(ctx, access, actorOf(user), (req.body.memberId ?? req.body.userId)!);
    return reply.code(204).send();
  });

  app.get('/teams/:teamId/members', { schema: { tags: ['teams'], params: teamParams } }, async (req) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'member');
    const members = await listMembers(ctx, access.team._id);
    // Members see the roster; only admins see keys and their usage.
    const isAdmin = access.role !== 'member';
    return { members: isAdmin ? members : members.map(rosterOnly) };
  });

  // The IT-manager way: add people by e-mail and hand each a seat and key at once, no invitation to accept.
  app.post('/teams/:teamId/members', {
    schema: {
      tags: ['teams'],
      params: teamParams,
      body: z.object({
        members: z.array(person).min(1).max(200),
        role: z.enum(['admin', 'member']).default('member'),
        assignSeat: z.boolean().default(true),
        /** Off when IT hands out keys itself (e.g. device management): nothing is e-mailed. */
        sendEmail: z.boolean().default(true),
      }),
    },
  }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const result = await addMembers(ctx, access, actorOf(user), { people: req.body.members, role: req.body.role, assignSeat: req.body.assignSeat, sendEmail: req.body.sendEmail });
    const ids = new Set(result.added.map((a) => a.memberId));
    const members = (await listMembers(ctx, access.team._id)).filter((m) => ids.has(m.memberId));
    const team = await ctx.c.teams.findOne({ _id: access.team._id });
    return reply.code(201).send({ members, skipped: result.skipped, team: teamView(team ?? access.team) });
  });

  app.post('/teams/:teamId/seat-request', {
    schema: { tags: ['teams'], params: teamParams, body: z.object({ seats: z.number().int().min(2).max(100_000), note: z.string().trim().max(1000).optional() }) },
  }, async (req) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    return { team: teamView(await requestSeats(ctx, access, actorOf(user), req.body.seats, req.body.note)) };
  });

  app.get('/teams/:teamId/licenses', { schema: { tags: ['teams'], params: teamParams } }, async (req) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    return { licenses: await listTeamLicenses(ctx, access.team._id) };
  });

  app.get('/teams/:teamId/licenses.csv', { schema: { tags: ['teams'], params: teamParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const csv = await licensesCsv(ctx, access.team._id);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-disposition', `attachment; filename="motionql-team-licenses-${access.team._id}.csv"`)
      .send(csv);
  });

  app.post('/teams/:teamId/licenses/renew-expiring', {
    schema: { tags: ['teams'], params: teamParams, body: z.object({ withinDays: z.number().int().min(0).max(365).default(30), sendEmail: z.boolean().default(true) }).default({ withinDays: 30, sendEmail: true }) },
  }, async (req) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    return { renewed: await renewExpiring(ctx, access, actorOf(user), req.body.withinDays, req.body.sendEmail) };
  });

  app.patch('/teams/:teamId/members/:memberId', {
    schema: { tags: ['teams'], params: memberParams, body: z.object({ role: z.enum(['admin', 'member']).optional(), edition: edition.optional(), features: features.optional() }) },
  }, async (req) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const m = await updateMember(ctx, access, actorOf(user), req.params.memberId, req.body);
    return { member: { memberId: m._id, userId: m.userId ?? null, email: m.email, role: m.role, hasSeat: m.hasSeat, edition: m.edition, features: m.features } };
  });

  // Admins remove anyone but the owner; any member can remove themselves (leave).
  app.delete('/teams/:teamId/members/:memberId', { schema: { tags: ['teams'], params: memberParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const self = (await findMember(ctx, req.params.teamId, req.params.memberId))?.userId === user._id;
    const access = await teamAccess(ctx, req.params.teamId, user, self ? 'member' : 'admin');
    await removeMember(ctx, access.team, actorOf(user), req.params.memberId, self);
    return reply.code(204).send();
  });

  app.post('/teams/:teamId/seats/:memberId', { schema: { tags: ['teams'], params: memberParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const license = await assignSeatTo(ctx, access, actorOf(user), req.params.memberId);
    return reply.code(201).send({ license: licenseView(license, ctx.now(), access.team.name) });
  });

  app.delete('/teams/:teamId/seats/:memberId', { schema: { tags: ['teams'], params: memberParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    await freeSeatOf(ctx, access, actorOf(user), req.params.memberId);
    return reply.code(204).send();
  });

  app.post('/teams/:teamId/members/:memberId/reissue', { schema: { tags: ['teams'], params: memberParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const license = await reissueMemberKey(ctx, access, actorOf(user), req.params.memberId);
    return reply.code(201).send({ license: licenseView(license, ctx.now(), access.team.name) });
  });

  app.post('/teams/:teamId/members/:memberId/renew', { schema: { tags: ['teams'], params: memberParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const license = await renewMemberKey(ctx, access, actorOf(user), req.params.memberId);
    return reply.code(201).send({ license: licenseView(license, ctx.now(), access.team.name) });
  });

  app.post('/teams/:teamId/members/:memberId/send-key', { schema: { tags: ['teams'], params: memberParams } }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    await sendMemberKey(ctx, access, actorOf(user), req.params.memberId);
    return reply.code(204).send();
  });

  app.post('/teams/:teamId/members/:memberId/reassign', {
    schema: { tags: ['teams'], params: memberParams, body: person.extend({ sendEmail: z.boolean().default(true) }) },
  }, async (req, reply) => {
    const user = await requireUser(ctx, req);
    const access = await teamAccess(ctx, req.params.teamId, user, 'admin');
    const memberId = await reassignSeat(ctx, access, actorOf(user), req.params.memberId, req.body, req.body.sendEmail);
    const member = (await listMembers(ctx, access.team._id)).find((m) => m.memberId === memberId);
    return reply.code(201).send({ member });
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
      .header('content-disposition', `attachment; filename="motionql-team-audit-${access.team._id}.csv"`)
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
