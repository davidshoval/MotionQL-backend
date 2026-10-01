import type { Actor, Ctx } from '../context.js';
import type { AuditEventDoc, InviteDoc, LicenseDoc, TeamDoc, TeamMemberDoc, TeamRole, UserDoc } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { newId } from '../lib/ids.js';
import { addDays } from '../lib/time.js';
import { hashToken, newToken } from '../lib/tokens.js';
import type { LicenseEdition } from '../licensing/types.js';
import { audit } from './audit.js';
import { templates } from './email.js';
import { issueLicense, licenseStatus, reissueLicense, remainingDays, revokeLicense } from './licenses.js';
import { getTeamPlan } from './settings.js';
import { normalizeEmail } from './accounts.js';

const INVITE_DAYS = 14;
const ROLE_RANK: Record<TeamRole, number> = { member: 0, admin: 1, owner: 2 };

const actorOf = (user: UserDoc): Actor => ({ id: user._id, email: user.email, isStaff: user.isStaff });

export interface TeamAccess {
  team: TeamDoc;
  /** Undefined when staff look at a team they are not in. */
  member?: TeamMemberDoc;
  role: TeamRole | 'staff';
}

/** Loads a team and checks the caller's role. Staff may act as owner for support. */
export async function teamAccess(ctx: Ctx, teamId: string, user: UserDoc, minRole: TeamRole): Promise<TeamAccess> {
  const team = await ctx.c.teams.findOne({ _id: teamId });
  const member = team ? await ctx.c.teamMembers.findOne({ teamId, userId: user._id }) : null;
  if (!team || (!member && !user.isStaff)) throw notFound('Team not found.');
  if (member && ROLE_RANK[member.role] >= ROLE_RANK[minRole]) return { team, member, role: member.role };
  if (user.isStaff) return { team, member: member ?? undefined, role: 'staff' };
  throw forbidden(minRole === 'owner' ? 'Only the team owner can do that.' : 'Only team admins can do that.');
}

export const teamView = (team: TeamDoc) => ({
  id: team._id,
  name: team.name,
  seatLimit: team.seatLimit,
  seatsUsed: team.seatsUsed,
  allowedEditions: team.allowedEditions,
  allowedFeatures: team.allowedFeatures,
  createdAt: team.createdAt.toISOString(),
});

export async function createTeam(ctx: Ctx, user: UserDoc, name: string): Promise<TeamDoc> {
  const plan = await getTeamPlan(ctx);
  const now = ctx.now();
  const team: TeamDoc = {
    _id: newId('team'),
    name: name.trim(),
    ownerId: user._id,
    seatLimit: plan.defaultSeatLimit,
    seatsUsed: 0,
    allowedEditions: [plan.edition],
    allowedFeatures: [],
    createdAt: now,
    updatedAt: now,
  };
  await ctx.c.teams.insertOne(team);
  const member: TeamMemberDoc = {
    _id: newId('mem'),
    teamId: team._id,
    userId: user._id,
    role: 'owner',
    hasSeat: false,
    edition: plan.edition,
    features: [],
    joinedAt: now,
  };
  await ctx.c.teamMembers.insertOne(member);
  await audit(ctx, actorOf(user), 'team.create', { teamId: team._id, target: { type: 'team', id: team._id }, details: { name: team.name } });
  await assignSeat(ctx, team, member, user, actorOf(user));
  return (await ctx.c.teams.findOne({ _id: team._id }))!;
}

export async function renameTeam(ctx: Ctx, access: TeamAccess, actor: Actor, name: string): Promise<TeamDoc> {
  const team = await ctx.c.teams.findOneAndUpdate(
    { _id: access.team._id },
    { $set: { name: name.trim(), updatedAt: ctx.now() } },
    { returnDocument: 'after' },
  );
  await audit(ctx, actor, 'team.rename', { teamId: access.team._id, target: { type: 'team', id: access.team._id }, details: { from: access.team.name, to: name } });
  return team!;
}

async function sendKey(ctx: Ctx, user: UserDoc, team: TeamDoc, license: LicenseDoc): Promise<void> {
  await ctx.mailer.send(
    templates.licenseKey(user.email, {
      name: user.name,
      key: license.key,
      edition: license.payload.edition,
      expiresAt: license.payload.expiresAt,
      accountUrl: `${ctx.config.webUrl}/account/licenses`,
      teamName: team.name,
    }),
  );
}

/** Takes one seat (atomically, never past the limit) and issues the member's personal team key. */
export async function assignSeat(ctx: Ctx, team: TeamDoc, member: TeamMemberDoc, user: UserDoc, actor: Actor): Promise<LicenseDoc> {
  const claimed = await ctx.c.teamMembers.updateOne({ _id: member._id, hasSeat: false }, { $set: { hasSeat: true } });
  if (!claimed.modifiedCount) throw conflict('already_has_seat', `${user.email} already has a seat.`);
  const taken = await ctx.c.teams.updateOne(
    { _id: team._id, $expr: { $lt: ['$seatsUsed', '$seatLimit'] } },
    { $inc: { seatsUsed: 1 }, $set: { updatedAt: ctx.now() } },
  );
  if (!taken.modifiedCount) {
    await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { hasSeat: false } });
    throw conflict('seat_limit_reached', `All ${team.seatLimit} seats are in use. Free a seat or ask us for more.`);
  }
  try {
    const plan = await getTeamPlan(ctx);
    const license = await issueLicense(ctx, {
      source: 'team',
      email: user.email,
      customer: team.name,
      edition: member.edition,
      features: member.features,
      durationDays: plan.durationDays,
      userId: user._id,
      teamId: team._id,
      actor,
    });
    await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { licenseId: license._id } });
    await audit(ctx, actor, 'team.seat.assign', { teamId: team._id, target: { type: 'user', id: user._id, email: user.email } });
    await sendKey(ctx, user, team, license);
    return license;
  } catch (error) {
    await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { hasSeat: false } });
    await ctx.c.teams.updateOne({ _id: team._id }, { $inc: { seatsUsed: -1 } });
    throw error;
  }
}

/** Frees the seat and revokes the member's team key. */
export async function freeSeat(ctx: Ctx, team: TeamDoc, member: TeamMemberDoc, actor: Actor, reason: string): Promise<boolean> {
  const released = await ctx.c.teamMembers.findOneAndUpdate(
    { _id: member._id, hasSeat: true },
    { $set: { hasSeat: false }, $unset: { licenseId: '' } },
  );
  if (!released) return false;
  await ctx.c.teams.updateOne({ _id: team._id }, { $inc: { seatsUsed: -1 }, $set: { updatedAt: ctx.now() } });
  if (released.licenseId) await revokeLicense(ctx, released.licenseId, reason, actor);
  await audit(ctx, actor, 'team.seat.free', { teamId: team._id, target: { type: 'user', id: member.userId }, details: { reason } });
  return true;
}

async function memberOrThrow(ctx: Ctx, teamId: string, userId: string): Promise<{ member: TeamMemberDoc; user: UserDoc }> {
  const member = await ctx.c.teamMembers.findOne({ teamId, userId });
  const user = member ? await ctx.c.users.findOne({ _id: userId }) : null;
  if (!member || !user) throw notFound('Member not found.');
  return { member, user };
}

export async function assignSeatTo(ctx: Ctx, access: TeamAccess, actor: Actor, userId: string): Promise<LicenseDoc> {
  const { member, user } = await memberOrThrow(ctx, access.team._id, userId);
  return assignSeat(ctx, access.team, member, user, actor);
}

export async function freeSeatOf(ctx: Ctx, access: TeamAccess, actor: Actor, userId: string): Promise<void> {
  const { member, user } = await memberOrThrow(ctx, access.team._id, userId);
  if (!(await freeSeat(ctx, access.team, member, actor, 'seat freed by admin'))) throw conflict('no_seat', `${user.email} has no seat.`);
  await ctx.mailer.send(templates.seatRemoved(user.email, { teamName: access.team.name }));
}

export async function reissueMemberKey(ctx: Ctx, access: TeamAccess, actor: Actor, userId: string): Promise<LicenseDoc> {
  const { member, user } = await memberOrThrow(ctx, access.team._id, userId);
  const old = member.licenseId ? await ctx.c.licenses.findOne({ _id: member.licenseId }) : null;
  if (!member.hasSeat || !old) throw conflict('no_seat', `${user.email} has no seat.`);
  return replaceMemberKey(ctx, access.team, member, user, old, actor, old.payload.edition, old.payload.features);
}

async function replaceMemberKey(
  ctx: Ctx,
  team: TeamDoc,
  member: TeamMemberDoc,
  user: UserDoc,
  old: LicenseDoc,
  actor: Actor,
  edition: LicenseEdition,
  features: string[],
): Promise<LicenseDoc> {
  const now = ctx.now();
  const days = licenseStatus(old, now) === 'active' ? remainingDays(old, now) : (await getTeamPlan(ctx)).durationDays;
  const fresh = await reissueLicense(ctx, { ...old, payload: { ...old.payload, edition, features } }, actor, days);
  await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { licenseId: fresh._id } });
  await sendKey(ctx, user, team, fresh);
  return fresh;
}

export async function updateMember(
  ctx: Ctx,
  access: TeamAccess,
  actor: Actor,
  userId: string,
  patch: { role?: 'admin' | 'member'; edition?: LicenseEdition; features?: string[] },
): Promise<TeamMemberDoc> {
  const { member, user } = await memberOrThrow(ctx, access.team._id, userId);
  const isOwner = access.role === 'owner' || access.role === 'staff';
  if (patch.role && patch.role !== member.role) {
    if (member.role === 'owner') throw badRequest('owner_role', 'Transfer ownership to change the owner’s role.');
    if (!isOwner) throw forbidden('Only the team owner can add or remove admins.');
    await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { role: patch.role } });
    await audit(ctx, actor, 'team.member.role', { teamId: access.team._id, target: { type: 'user', id: userId, email: user.email }, details: { from: member.role, to: patch.role } });
  }
  const edition = patch.edition ?? member.edition;
  const features = patch.features ? [...new Set(patch.features)] : member.features;
  const planChanged = edition !== member.edition || features.join() !== member.features.join();
  if (planChanged) {
    if (!access.team.allowedEditions.includes(edition)) {
      throw badRequest('edition_not_allowed', `This team cannot assign the ${edition} edition.`, { edition: 'Not included in your team plan.' });
    }
    const extra = features.filter((f) => !access.team.allowedFeatures.includes(f));
    if (extra.length) throw badRequest('feature_not_allowed', `This team cannot assign: ${extra.join(', ')}.`, { features: 'Not included in your team plan.' });
    await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { edition, features } });
    await audit(ctx, actor, 'team.member.plan', { teamId: access.team._id, target: { type: 'user', id: userId, email: user.email }, details: { edition, features } });
    const old = member.hasSeat && member.licenseId ? await ctx.c.licenses.findOne({ _id: member.licenseId }) : null;
    if (old) await replaceMemberKey(ctx, access.team, member, user, old, actor, edition, features);
  }
  return (await ctx.c.teamMembers.findOne({ _id: member._id }))!;
}

/** An admin removes someone, or a member leaves. The owner must transfer ownership or delete the team instead. */
export async function removeMember(ctx: Ctx, team: TeamDoc, actor: Actor, userId: string, self: boolean): Promise<void> {
  const { member, user } = await memberOrThrow(ctx, team._id, userId);
  if (member.role === 'owner') throw badRequest('owner_cannot_leave', 'Transfer ownership or delete the team first.');
  const hadSeat = await freeSeat(ctx, team, member, actor, self ? 'left the team' : 'removed from team');
  await ctx.c.teamMembers.deleteOne({ _id: member._id });
  await audit(ctx, actor, self ? 'team.member.leave' : 'team.member.remove', { teamId: team._id, target: { type: 'user', id: userId, email: user.email } });
  if (hadSeat && !self) await ctx.mailer.send(templates.seatRemoved(user.email, { teamName: team.name }));
}

export async function transferOwnership(ctx: Ctx, access: TeamAccess, actor: Actor, userId: string): Promise<void> {
  const { member, user } = await memberOrThrow(ctx, access.team._id, userId);
  if (member.role === 'owner') return;
  await ctx.c.teamMembers.updateOne({ teamId: access.team._id, role: 'owner' }, { $set: { role: 'admin' } });
  await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { role: 'owner' } });
  await ctx.c.teams.updateOne({ _id: access.team._id }, { $set: { ownerId: userId, updatedAt: ctx.now() } });
  await audit(ctx, actor, 'team.transfer_ownership', { teamId: access.team._id, target: { type: 'user', id: userId, email: user.email } });
}

/** Revokes every team key, then removes the team, its members and invites. The audit log stays. */
export async function deleteTeam(ctx: Ctx, access: TeamAccess, actor: Actor): Promise<void> {
  const teamId = access.team._id;
  const keys = await ctx.c.licenses.find({ teamId, revokedAt: { $exists: false } }, { projection: { _id: 1 } }).toArray();
  for (const { _id } of keys) await revokeLicense(ctx, _id, 'team deleted', actor);
  await ctx.c.teamMembers.deleteMany({ teamId });
  await ctx.c.invites.deleteMany({ teamId });
  await ctx.c.teams.deleteOne({ _id: teamId });
  await audit(ctx, actor, 'team.delete', { teamId, target: { type: 'team', id: teamId }, details: { name: access.team.name, revokedKeys: keys.length } });
}

// Members list with usage from the opt-in app ping.

export interface MemberView {
  userId: string;
  email: string;
  name: string;
  role: TeamRole;
  hasSeat: boolean;
  edition: LicenseEdition;
  features: string[];
  joinedAt: string;
  license?: { licenseId: string; edition: LicenseEdition; features: string[]; issuedAt: string; expiresAt: string; status: string };
  usage?: { lastSeen: string; appVersion: string; platform: string; installs: number };
}

export async function listMembers(ctx: Ctx, teamId: string): Promise<MemberView[]> {
  const members = await ctx.c.teamMembers.find({ teamId }).sort({ joinedAt: 1 }).toArray();
  const users = new Map((await ctx.c.users.find({ _id: { $in: members.map((m) => m.userId) } }).toArray()).map((u) => [u._id, u]));
  const licenseIds = members.map((m) => m.licenseId).filter((id): id is string => Boolean(id));
  const licenses = new Map((await ctx.c.licenses.find({ _id: { $in: licenseIds } }).toArray()).map((l) => [l._id, l]));
  const hashes = [...licenses.values()].map((l) => l.hash);
  const usage = new Map(
    (
      await ctx.c.installs
        .aggregate<{ _id: string; installs: number; lastSeen: Date; appVersion: string; platform: string }>([
          { $match: { licenseHash: { $in: hashes } } },
          { $sort: { lastSeen: -1 } },
          { $group: { _id: '$licenseHash', installs: { $sum: 1 }, lastSeen: { $first: '$lastSeen' }, appVersion: { $first: '$appVersion' }, platform: { $first: '$platform' } } },
        ])
        .toArray()
    ).map((u) => [u._id, u]),
  );
  const now = ctx.now();
  return members.flatMap((m) => {
    const user = users.get(m.userId);
    if (!user) return [];
    const license = m.licenseId ? licenses.get(m.licenseId) : undefined;
    const use = license ? usage.get(license.hash) : undefined;
    return [
      {
        userId: m.userId,
        email: user.email,
        name: user.name,
        role: m.role,
        hasSeat: m.hasSeat,
        edition: m.edition,
        features: m.features,
        joinedAt: m.joinedAt.toISOString(),
        ...(license
          ? {
              license: {
                licenseId: license._id,
                edition: license.payload.edition,
                features: license.payload.features,
                issuedAt: license.payload.issuedAt,
                expiresAt: license.payload.expiresAt,
                status: licenseStatus(license, now),
              },
            }
          : {}),
        ...(use ? { usage: { lastSeen: use.lastSeen.toISOString(), appVersion: use.appVersion, platform: use.platform, installs: use.installs } } : {}),
      },
    ];
  });
}

// Invitations.

export const inviteView = (i: InviteDoc, inviterEmail?: string) => ({
  id: i._id,
  email: i.email,
  role: i.role,
  assignSeat: i.assignSeat,
  invitedBy: inviterEmail ?? i.invitedBy,
  createdAt: i.createdAt.toISOString(),
  expiresAt: i.expiresAt.toISOString(),
});

async function sendInvite(ctx: Ctx, team: TeamDoc, invite: InviteDoc, token: string, inviter: Actor): Promise<void> {
  await ctx.mailer.send(
    templates.invite(invite.email, {
      teamName: team.name,
      inviter: inviter.email,
      url: `${ctx.config.webUrl}/invite?token=${encodeURIComponent(token)}`,
      withSeat: invite.assignSeat,
    }),
  );
}

export async function inviteMembers(
  ctx: Ctx,
  access: TeamAccess,
  actor: Actor,
  input: { emails: string[]; role: 'admin' | 'member'; assignSeat: boolean },
): Promise<{ invites: InviteDoc[]; skipped: { email: string; reason: string }[] }> {
  if (input.role === 'admin' && access.role !== 'owner' && access.role !== 'staff') throw forbidden('Only the team owner can invite admins.');
  const team = access.team;
  const emails = [...new Set(input.emails.map(normalizeEmail))];
  const existingUsers = await ctx.c.users.find({ email: { $in: emails } }, { projection: { _id: 1, email: 1 } }).toArray();
  const memberIds = new Set(
    (await ctx.c.teamMembers.find({ teamId: team._id, userId: { $in: existingUsers.map((u) => u._id) } }).toArray()).map((m) => m.userId),
  );
  const alreadyMember = new Set(existingUsers.filter((u) => memberIds.has(u._id)).map((u) => u.email));
  const invites: InviteDoc[] = [];
  const skipped: { email: string; reason: string }[] = [];
  const now = ctx.now();
  for (const email of emails) {
    if (alreadyMember.has(email)) {
      skipped.push({ email, reason: 'already_member' });
      continue;
    }
    const token = newToken();
    const invite = await ctx.c.invites.findOneAndUpdate(
      { teamId: team._id, email },
      {
        $set: { role: input.role, assignSeat: input.assignSeat, tokenHash: hashToken(token), invitedBy: actor.email, expiresAt: addDays(now, INVITE_DAYS) },
        $setOnInsert: { _id: newId('inv'), teamId: team._id, email, createdAt: now },
      },
      { upsert: true, returnDocument: 'after' },
    );
    invites.push(invite!);
    await sendInvite(ctx, team, invite!, token, actor);
    await audit(ctx, actor, 'team.invite.create', { teamId: team._id, target: { type: 'invite', id: invite!._id, email }, details: { role: input.role, assignSeat: input.assignSeat } });
  }
  return { invites, skipped };
}

export async function listInvites(ctx: Ctx, teamId: string): Promise<InviteDoc[]> {
  return ctx.c.invites.find({ teamId, expiresAt: { $gt: ctx.now() } }).sort({ createdAt: -1 }).toArray();
}

export async function resendInvite(ctx: Ctx, access: TeamAccess, actor: Actor, inviteId: string): Promise<void> {
  const token = newToken();
  const invite = await ctx.c.invites.findOneAndUpdate(
    { _id: inviteId, teamId: access.team._id },
    { $set: { tokenHash: hashToken(token), expiresAt: addDays(ctx.now(), INVITE_DAYS) } },
    { returnDocument: 'after' },
  );
  if (!invite) throw notFound('Invitation not found.');
  await sendInvite(ctx, access.team, invite, token, actor);
  await audit(ctx, actor, 'team.invite.resend', { teamId: access.team._id, target: { type: 'invite', id: inviteId, email: invite.email } });
}

export async function cancelInvite(ctx: Ctx, access: TeamAccess, actor: Actor, inviteId: string): Promise<void> {
  const invite = await ctx.c.invites.findOneAndDelete({ _id: inviteId, teamId: access.team._id });
  if (!invite) throw notFound('Invitation not found.');
  await audit(ctx, actor, 'team.invite.cancel', { teamId: access.team._id, target: { type: 'invite', id: inviteId, email: invite.email } });
}

async function inviteByToken(ctx: Ctx, token: string): Promise<{ invite: InviteDoc; team: TeamDoc }> {
  const invite = await ctx.c.invites.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: ctx.now() } });
  const team = invite ? await ctx.c.teams.findOne({ _id: invite.teamId }) : null;
  if (!invite || !team) throw notFound('This invitation is invalid or has expired. Ask your admin for a new one.');
  return { invite, team };
}

export async function previewInvite(ctx: Ctx, token: string) {
  const { invite, team } = await inviteByToken(ctx, token);
  return { teamName: team.name, email: invite.email, role: invite.role, invitedBy: invite.invitedBy, assignSeat: invite.assignSeat };
}

/** Joins the team; takes a seat when the invite says so and one is free (otherwise joins without one). */
export async function acceptInvite(ctx: Ctx, user: UserDoc, token: string): Promise<{ team: TeamDoc; seatAssigned: boolean }> {
  const { invite, team } = await inviteByToken(ctx, token);
  if (invite.email !== user.email) {
    throw new AppError(403, 'invite_email_mismatch', `This invitation is for ${invite.email}. Sign in with that e-mail to accept it.`);
  }
  const plan = await getTeamPlan(ctx);
  const member: TeamMemberDoc = {
    _id: newId('mem'),
    teamId: team._id,
    userId: user._id,
    role: invite.role,
    hasSeat: false,
    edition: team.allowedEditions.includes(plan.edition) ? plan.edition : team.allowedEditions[0],
    features: [],
    joinedAt: ctx.now(),
  };
  try {
    await ctx.c.teamMembers.insertOne(member);
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    await ctx.c.invites.deleteOne({ _id: invite._id });
    return { team, seatAssigned: false };
  }
  await ctx.c.invites.deleteOne({ _id: invite._id });
  const actor = actorOf(user);
  await audit(ctx, actor, 'team.invite.accept', { teamId: team._id, target: { type: 'user', id: user._id, email: user.email }, details: { role: invite.role } });
  let seatAssigned = false;
  if (invite.assignSeat) {
    try {
      await assignSeat(ctx, team, member, user, actor);
      seatAssigned = true;
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'seat_limit_reached')) throw error;
    }
  }
  return { team: (await ctx.c.teams.findOne({ _id: team._id })) ?? team, seatAssigned };
}

// Audit log.

export const auditView = (e: AuditEventDoc) => ({
  id: e._id,
  at: e.at.toISOString(),
  actor: e.actorId ? { id: e.actorId, email: e.actorEmail } : null,
  action: e.action,
  target: e.target ?? null,
  details: e.details ?? {},
});

/** Newest first; ids are ULIDs, so `before` is a stable cursor. */
export async function listAudit(ctx: Ctx, filter: { teamId?: string }, before: string | undefined, limit: number) {
  const events = await ctx.c.auditEvents
    .find({ ...(filter.teamId ? { teamId: filter.teamId } : {}), ...(before ? { _id: { $lt: before } } : {}) })
    .sort({ _id: -1 })
    .limit(limit + 1)
    .toArray();
  const page = events.slice(0, limit);
  return { events: page.map(auditView), nextCursor: events.length > limit ? page[page.length - 1]._id : null };
}

const csvCell = (value: unknown) => {
  let s = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  // Stop spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function auditCsv(ctx: Ctx, teamId: string): Promise<string> {
  const rows = await ctx.c.auditEvents.find({ teamId }).sort({ _id: -1 }).limit(50_000).toArray();
  const lines = [['time', 'actor', 'action', 'target_type', 'target', 'details'].join(',')];
  for (const e of rows) {
    lines.push([e.at.toISOString(), e.actorEmail, e.action, e.target?.type, e.target?.email ?? e.target?.id, e.details].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
