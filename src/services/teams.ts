import type { Actor, Ctx } from '../context.js';
import type { AuditEventDoc, InviteDoc, LicenseDoc, TeamDoc, TeamMemberDoc, TeamRole, UserDoc } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { newId } from '../lib/ids.js';
import { addDays } from '../lib/time.js';
import { hashToken, newToken } from '../lib/tokens.js';
import type { LicenseEdition } from '../licensing/types.js';
import { audit } from './audit.js';
import { templates } from './email.js';
import { issueLicense, licenseStatus, licenseView, reissueLicense, remainingDays, revokeLicense } from './licenses.js';
import type { LicenseView } from './licenses.js';
import { getTeamPlan } from './settings.js';
import { normalizeEmail } from './accounts.js';

const INVITE_DAYS = 14;
const ROLE_RANK: Record<TeamRole, number> = { member: 0, admin: 1, owner: 2 };

const actorOf = (user: UserDoc): Actor => ({ id: user._id, email: user.email, isStaff: user.isStaff });

/** How a member is named in messages: their e-mail, or their name when the admin added them without one. */
const label = (m: Pick<TeamMemberDoc, 'email' | 'name'>) => m.email ?? m.name ?? 'This member';

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
  seatRequest: team.seatRequest ? { seats: team.seatRequest.seats, note: team.seatRequest.note ?? null, by: team.seatRequest.by, at: team.seatRequest.at.toISOString() } : null,
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
    email: user.email,
    name: user.name,
    role: 'owner',
    hasSeat: false,
    edition: plan.edition,
    features: [],
    joinedAt: now,
  };
  await ctx.c.teamMembers.insertOne(member);
  await audit(ctx, actorOf(user), 'team.create', { teamId: team._id, target: { type: 'team', id: team._id }, details: { name: team.name } });
  await assignSeat(ctx, team, member, actorOf(user));
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

/** The edition a new member starts with: the team plan's, when this team may hand it out. */
const startingEdition = (team: TeamDoc, planEdition: LicenseEdition) => (team.allowedEditions.includes(planEdition) ? planEdition : team.allowedEditions[0]);

/** E-mails a member their current team key. Someone without an account is told how to use it without one. */
async function sendKey(ctx: Ctx, member: TeamMemberDoc, team: TeamDoc, license: LicenseDoc): Promise<void> {
  if (!member.email) return;
  const user = member.userId ? await ctx.c.users.findOne({ _id: member.userId }, { projection: { name: 1 } }) : null;
  await ctx.mailer.send(
    templates.licenseKey(member.email, {
      name: user?.name || member.name || member.email,
      key: license.key,
      edition: license.payload.edition,
      expiresAt: license.payload.expiresAt,
      accountUrl: `${ctx.config.webUrl}/account/licenses`,
      teamName: team.name,
      ...(user ? {} : { signUpUrl: `${ctx.config.webUrl}/register?email=${encodeURIComponent(member.email)}`, downloadUrl: `${ctx.config.webUrl}/download` }),
    }),
  );
}

/**
 * The e-mail signed into a member's key. The app needs one, so someone added without an e-mail gets the admin's: the
 * app shows it as the contact for the license.
 */
const keyEmail = (member: TeamMemberDoc, actor: Pick<Actor, 'email'>) => member.email ?? member.addedBy ?? actor.email;

/** Takes one seat (atomically, never past the limit) and issues the member's personal team key. */
export async function assignSeat(ctx: Ctx, team: TeamDoc, member: TeamMemberDoc, actor: Actor, opts: { notify?: boolean } = {}): Promise<LicenseDoc> {
  const claimed = await ctx.c.teamMembers.updateOne({ _id: member._id, hasSeat: false }, { $set: { hasSeat: true } });
  if (!claimed.modifiedCount) throw conflict('already_has_seat', `${label(member)} already has a seat.`);
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
      email: keyEmail(member, actor),
      customer: team.name,
      edition: member.edition,
      features: member.features,
      durationDays: plan.durationDays,
      userId: member.userId,
      teamId: team._id,
      memberId: member._id,
      actor,
    });
    await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { licenseId: license._id } });
    await audit(ctx, actor, 'team.seat.assign', { teamId: team._id, target: memberTarget(member) });
    if (opts.notify !== false) await sendKey(ctx, member, team, license);
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
  await audit(ctx, actor, 'team.seat.free', { teamId: team._id, target: memberTarget(member), details: { reason } });
  return true;
}

/** Finds a member by member id (mem_…) or, as older clients send, by account id. */
export async function findMember(ctx: Ctx, teamId: string, ref: string): Promise<TeamMemberDoc | null> {
  return ctx.c.teamMembers.findOne(ref.startsWith('mem_') ? { _id: ref, teamId } : { teamId, userId: ref });
}

async function memberOrThrow(ctx: Ctx, teamId: string, ref: string): Promise<TeamMemberDoc> {
  const member = await findMember(ctx, teamId, ref);
  if (!member) throw notFound('Member not found.');
  return member;
}

const memberTarget = (m: TeamMemberDoc) => ({ type: 'user' as const, id: m.userId ?? m._id, ...(m.email ? { email: m.email } : {}) });

export async function assignSeatTo(ctx: Ctx, access: TeamAccess, actor: Actor, ref: string): Promise<LicenseDoc> {
  const member = await memberOrThrow(ctx, access.team._id, ref);
  return assignSeat(ctx, access.team, member, actor);
}

export async function freeSeatOf(ctx: Ctx, access: TeamAccess, actor: Actor, ref: string): Promise<void> {
  const member = await memberOrThrow(ctx, access.team._id, ref);
  if (!(await freeSeat(ctx, access.team, member, actor, 'seat freed by admin'))) throw conflict('no_seat', `${label(member)} has no seat.`);
  if (member.email) await ctx.mailer.send(templates.seatRemoved(member.email, { teamName: access.team.name }));
}

async function currentKey(ctx: Ctx, member: TeamMemberDoc): Promise<LicenseDoc> {
  const key = member.hasSeat && member.licenseId ? await ctx.c.licenses.findOne({ _id: member.licenseId }) : null;
  if (!key) throw conflict('no_seat', `${label(member)} has no seat.`);
  return key;
}

/** Same term, new key: for a lost or leaked key. */
export async function reissueMemberKey(ctx: Ctx, access: TeamAccess, actor: Actor, ref: string): Promise<LicenseDoc> {
  const member = await memberOrThrow(ctx, access.team._id, ref);
  const old = await currentKey(ctx, member);
  return replaceMemberKey(ctx, access.team, member, old, actor, old.payload.edition, old.payload.features);
}

/** A new key for a full plan term from today (the old one stops working): for a key that is about to run out or has. */
export async function renewMemberKey(ctx: Ctx, access: TeamAccess, actor: Actor, ref: string, opts: { notify?: boolean } = {}): Promise<LicenseDoc> {
  const member = await memberOrThrow(ctx, access.team._id, ref);
  const old = await currentKey(ctx, member);
  const plan = await getTeamPlan(ctx);
  const fresh = await reissueLicense(ctx, { ...old, memberId: member._id, payload: { ...old.payload, email: keyEmail(member, actor), edition: member.edition, features: member.features } }, actor, plan.durationDays);
  await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { licenseId: fresh._id } });
  await audit(ctx, actor, 'team.seat.renew', { teamId: access.team._id, target: memberTarget(member), details: { from: old.payload.expiresAt, to: fresh.payload.expiresAt } });
  if (opts.notify !== false) await sendKey(ctx, member, access.team, fresh);
  return fresh;
}

/** Renews every seated key that ends within `withinDays` (or has ended). Returns how many were renewed. */
export async function renewExpiring(ctx: Ctx, access: TeamAccess, actor: Actor, withinDays: number, notify: boolean): Promise<number> {
  const seated = await ctx.c.teamMembers.find({ teamId: access.team._id, hasSeat: true, licenseId: { $type: 'string' } }).toArray();
  const due = await ctx.c.licenses
    .find({ _id: { $in: seated.map((m) => m.licenseId!) }, expiresAt: { $lte: addDays(ctx.now(), withinDays) } }, { projection: { _id: 1 } })
    .toArray();
  const dueIds = new Set(due.map((l) => l._id));
  let renewed = 0;
  for (const m of seated.filter((x) => dueIds.has(x.licenseId!))) {
    await renewMemberKey(ctx, access, actor, m._id, { notify });
    renewed++;
  }
  return renewed;
}

/** E-mails the member their current key again. */
export async function sendMemberKey(ctx: Ctx, access: TeamAccess, actor: Actor, ref: string): Promise<void> {
  const member = await memberOrThrow(ctx, access.team._id, ref);
  if (!member.email) throw badRequest('no_email', `Add an e-mail for ${label(member)} to send them their key.`);
  const key = await currentKey(ctx, member);
  await sendKey(ctx, member, access.team, key);
  await audit(ctx, actor, 'team.key.send', { teamId: access.team._id, target: memberTarget(member) });
}

async function replaceMemberKey(
  ctx: Ctx,
  team: TeamDoc,
  member: TeamMemberDoc,
  old: LicenseDoc,
  actor: Actor,
  edition: LicenseEdition,
  features: string[],
): Promise<LicenseDoc> {
  const now = ctx.now();
  const days = licenseStatus(old, now) === 'active' ? remainingDays(old, now) : (await getTeamPlan(ctx)).durationDays;
  const fresh = await reissueLicense(ctx, { ...old, memberId: member._id, payload: { ...old.payload, email: keyEmail(member, actor), edition, features } }, actor, days);
  await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { licenseId: fresh._id } });
  await sendKey(ctx, member, team, fresh);
  return fresh;
}

export async function updateMember(
  ctx: Ctx,
  access: TeamAccess,
  actor: Actor,
  ref: string,
  patch: { role?: 'admin' | 'member'; edition?: LicenseEdition; features?: string[]; name?: string; email?: string | null },
): Promise<TeamMemberDoc> {
  let member = await memberOrThrow(ctx, access.team._id, ref);
  if (patch.name !== undefined || patch.email !== undefined) member = await updateContact(ctx, access, actor, member, patch);
  const isOwner = access.role === 'owner' || access.role === 'staff';
  if (patch.role && patch.role !== member.role) {
    if (member.role === 'owner') throw badRequest('owner_role', 'Transfer ownership to change the owner’s role.');
    if (!isOwner) throw forbidden('Only the team owner can add or remove admins.');
    await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { role: patch.role } });
    await audit(ctx, actor, 'team.member.role', { teamId: access.team._id, target: memberTarget(member), details: { from: member.role, to: patch.role } });
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
    await audit(ctx, actor, 'team.member.plan', { teamId: access.team._id, target: memberTarget(member), details: { edition, features } });
    const old = member.hasSeat && member.licenseId ? await ctx.c.licenses.findOne({ _id: member.licenseId }) : null;
    if (old) await replaceMemberKey(ctx, access.team, member, old, actor, edition, features);
  }
  return (await ctx.c.teamMembers.findOne({ _id: member._id }))!;
}

/**
 * Changes the name or e-mail an admin gave someone without an account. Their key is reissued (same term) so it carries
 * the new e-mail, and, when the address belongs to a confirmed account, the membership links to it.
 */
async function updateContact(
  ctx: Ctx,
  access: TeamAccess,
  actor: Actor,
  member: TeamMemberDoc,
  patch: { name?: string; email?: string | null },
): Promise<TeamMemberDoc> {
  const name = patch.name === undefined ? member.name : patch.name.trim() || undefined;
  const email = patch.email === undefined ? member.email : patch.email ? normalizeEmail(patch.email) : undefined;
  if (email !== member.email && member.userId) {
    throw badRequest('has_account', `${label(member)} has a MotionQL account; their e-mail comes from it.`, { email: 'Set by their account.' });
  }
  if (!email && !name) throw badRequest('validation_failed', 'Give a name or an e-mail.', { name: 'Enter a name or an e-mail.' });
  if (email === member.email && name === member.name) return member;
  const account = email && email !== member.email ? await ctx.c.users.findOne({ email, emailVerifiedAt: { $exists: true } }) : null;
  if (account && (await ctx.c.teamMembers.findOne({ teamId: access.team._id, userId: account._id }))) {
    throw conflict('already_member', `${email} is already on this team.`);
  }
  const set = { ...(email ? { email } : {}), ...(name ? { name } : {}), ...(account ? { userId: account._id } : {}) };
  const unset = { ...(email ? {} : { email: '' as const }), ...(name ? {} : { name: '' as const }) };
  try {
    await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw conflict('already_member', `${email} is already on this team.`);
    throw error;
  }
  await audit(ctx, actor, 'team.member.contact', {
    teamId: access.team._id,
    target: memberTarget(member),
    details: { ...(email !== member.email ? { email: email ?? null } : {}), ...(name !== member.name ? { name: name ?? null } : {}) },
  });
  const updated = (await ctx.c.teamMembers.findOne({ _id: member._id }))!;
  if (email !== member.email) {
    const old = updated.hasSeat && updated.licenseId ? await ctx.c.licenses.findOne({ _id: updated.licenseId }) : null;
    if (old) {
      const owned = account ? { ...old, userId: account._id } : old;
      await replaceMemberKey(ctx, access.team, updated, owned, actor, old.payload.edition, old.payload.features);
    }
  }
  return (await ctx.c.teamMembers.findOne({ _id: member._id }))!;
}

/** An admin removes someone, or a member leaves. The owner must transfer ownership or delete the team instead. */
export async function removeMember(ctx: Ctx, team: TeamDoc, actor: Actor, ref: string, self: boolean): Promise<void> {
  const member = await memberOrThrow(ctx, team._id, ref);
  if (member.role === 'owner') throw badRequest('owner_cannot_leave', 'Transfer ownership or delete the team first.');
  const hadSeat = await freeSeat(ctx, team, member, actor, self ? 'left the team' : 'removed from team');
  await ctx.c.teamMembers.deleteOne({ _id: member._id });
  await audit(ctx, actor, self ? 'team.member.leave' : 'team.member.remove', { teamId: team._id, target: memberTarget(member) });
  if (hadSeat && !self && member.email) await ctx.mailer.send(templates.seatRemoved(member.email, { teamName: team.name }));
}

export async function transferOwnership(ctx: Ctx, access: TeamAccess, actor: Actor, ref: string): Promise<void> {
  const member = await memberOrThrow(ctx, access.team._id, ref);
  if (member.role === 'owner') return;
  if (!member.userId) throw badRequest('no_account', `${label(member)} needs a MotionQL account before they can own the team.`);
  await ctx.c.teamMembers.updateOne({ teamId: access.team._id, role: 'owner' }, { $set: { role: 'admin' } });
  await ctx.c.teamMembers.updateOne({ _id: member._id }, { $set: { role: 'owner' } });
  await ctx.c.teams.updateOne({ _id: access.team._id }, { $set: { ownerId: member.userId, updatedAt: ctx.now() } });
  await audit(ctx, actor, 'team.transfer_ownership', { teamId: access.team._id, target: memberTarget(member) });
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

/** Seats are free for now and staff set the limit: an admin asks for more, staff get an e-mail and raise it. */
export async function requestSeats(ctx: Ctx, access: TeamAccess, actor: Actor, seats: number, note: string | undefined): Promise<TeamDoc> {
  const team = access.team;
  if (seats <= team.seatLimit) throw badRequest('validation_failed', `The team already has ${team.seatLimit} seats.`, { seats: `Ask for more than ${team.seatLimit}.` });
  const request = { seats, ...(note?.trim() ? { note: note.trim() } : {}), by: actor.email, at: ctx.now() };
  const updated = await ctx.c.teams.findOneAndUpdate({ _id: team._id }, { $set: { seatRequest: request, updatedAt: ctx.now() } }, { returnDocument: 'after' });
  await audit(ctx, actor, 'team.seat.request', { teamId: team._id, target: { type: 'team', id: team._id }, details: { from: team.seatLimit, to: seats } });
  const results = await Promise.allSettled(
    ctx.config.staffEmails.map((to) =>
      ctx.mailer.send(
        templates.seatRequest(to, {
          teamName: team.name,
          teamId: team._id,
          by: actor.email,
          seatLimit: team.seatLimit,
          seatsUsed: team.seatsUsed,
          seats,
          note: request.note,
          url: `${ctx.config.webUrl}/admin/teams?q=${encodeURIComponent(team._id)}`,
        }),
      ),
    ),
  );
  // The request is saved and shows on the staff page, so a failed e-mail does not fail it.
  for (const r of results) if (r.status === 'rejected') ctx.log.error({ err: r.reason, teamId: team._id }, 'seat request e-mail failed');
  return updated!;
}

// Adding people directly: the admin types e-mails, each person gets a seat and a key, no invitation to accept.

/** At least one of the two: someone added by name only gets a key the admin hands over. */
export interface NewMember {
  email?: string;
  name?: string;
}

export interface AddResult {
  added: { memberId: string; email?: string; name?: string; seatAssigned: boolean }[];
  skipped: { email: string; reason: 'already_member' }[];
}

export async function addMembers(
  ctx: Ctx,
  access: TeamAccess,
  actor: Actor,
  input: { people: NewMember[]; role: 'admin' | 'member'; assignSeat: boolean; sendEmail: boolean },
): Promise<AddResult> {
  if (input.role === 'admin' && access.role !== 'owner' && access.role !== 'staff') throw forbidden('Only the team owner can add admins.');
  const teamId = access.team._id;
  const people: [string | undefined, string | undefined][] = [];
  const seen = new Set<string>();
  for (const p of input.people) {
    const email = p.email?.trim() ? normalizeEmail(p.email) : undefined;
    const name = p.name?.trim() || undefined;
    if (!email && !name) throw badRequest('validation_failed', 'Give each person a name or an e-mail.', { members: 'Give each person a name or an e-mail.' });
    // The same e-mail twice is one person; two people may share a name.
    if (email && seen.has(email)) continue;
    if (email) seen.add(email);
    people.push([email, name]);
  }
  const emails = people.flatMap(([email]) => (email ? [email] : []));
  const existing = new Set(
    (await ctx.c.teamMembers.find({ teamId, email: { $in: emails } }, { projection: { email: 1 } }).toArray()).map((m) => m.email),
  );
  const skipped: AddResult['skipped'] = emails.filter((email) => existing.has(email)).map((email) => ({ email, reason: 'already_member' }));
  const fresh = people.filter(([email]) => !email || !existing.has(email));
  const team = (await ctx.c.teams.findOne({ _id: teamId })) ?? access.team;
  if (input.assignSeat && fresh.length > team.seatLimit - team.seatsUsed) {
    const free = Math.max(0, team.seatLimit - team.seatsUsed);
    throw conflict(
      'seat_limit_reached',
      `You are adding ${fresh.length} ${fresh.length === 1 ? 'person' : 'people'} but ${free === 0 ? 'no seats are' : `only ${free} seat${free === 1 ? ' is' : 's are'}`} free. Free some seats or ask us for more.`,
    );
  }
  // Only a confirmed address links to an account: anyone can register an e-mail, not everyone can read it.
  const accounts = new Map(
    (await ctx.c.users.find({ email: { $in: fresh.flatMap(([email]) => (email ? [email] : [])) }, emailVerifiedAt: { $exists: true } }).toArray()).map((u) => [u.email, u]),
  );
  const plan = await getTeamPlan(ctx);
  const added: AddResult['added'] = [];
  for (const [email, name] of fresh) {
    const user = email ? accounts.get(email) : undefined;
    const member: TeamMemberDoc = {
      _id: newId('mem'),
      teamId,
      ...(user ? { userId: user._id } : {}),
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
      role: input.role,
      hasSeat: false,
      edition: startingEdition(team, plan.edition),
      features: [],
      joinedAt: ctx.now(),
      addedBy: actor.email,
    };
    try {
      await ctx.c.teamMembers.insertOne(member);
    } catch (error) {
      if ((error as { code?: number }).code !== 11000 || !email) throw error;
      skipped.push({ email, reason: 'already_member' });
      continue;
    }
    // Adding someone replaces an invitation they had not accepted yet.
    if (email) await ctx.c.invites.deleteMany({ teamId, email });
    await audit(ctx, actor, 'team.member.add', { teamId, target: memberTarget(member), details: { role: input.role, hasAccount: Boolean(user) } });
    let seatAssigned = false;
    if (input.assignSeat) {
      try {
        await assignSeat(ctx, team, member, actor, { notify: input.sendEmail });
        seatAssigned = true;
      } catch (error) {
        // Another admin took the last seat meanwhile: the person stays on the team without one.
        if (!(error instanceof AppError && error.code === 'seat_limit_reached')) throw error;
      }
    }
    added.push({ memberId: member._id, ...(email ? { email } : {}), ...(name ? { name } : {}), seatAssigned });
  }
  return { added, skipped };
}

/** Takes the seat from one member (their key is revoked) and gives it to someone else, added to the team if new. */
export async function reassignSeat(ctx: Ctx, access: TeamAccess, actor: Actor, ref: string, to: NewMember, sendEmail: boolean): Promise<string> {
  const from = await memberOrThrow(ctx, access.team._id, ref);
  if (!from.hasSeat) throw conflict('no_seat', `${label(from)} has no seat.`);
  const email = to.email?.trim() ? normalizeEmail(to.email) : undefined;
  const name = to.name?.trim() || undefined;
  if (!email && !name) throw badRequest('validation_failed', 'Give a name or an e-mail.', { email: 'Enter a name or an e-mail.' });
  if (email && email === from.email) throw badRequest('same_member', 'Pick someone else to give the seat to.');
  const target = email ? await ctx.c.teamMembers.findOne({ teamId: access.team._id, email }) : null;
  if (target?.hasSeat) throw conflict('already_has_seat', `${email} already has a seat.`);
  await freeSeat(ctx, access.team, from, actor, 'seat reassigned');
  if (from.email) await ctx.mailer.send(templates.seatRemoved(from.email, { teamName: access.team.name }));
  await audit(ctx, actor, 'team.seat.reassign', { teamId: access.team._id, target: memberTarget(from), details: { to: email ?? name } });
  if (target) {
    await assignSeat(ctx, access.team, target, actor, { notify: sendEmail });
    return target._id;
  }
  const { added } = await addMembers(ctx, access, actor, { people: [{ email, name }], role: 'member', assignSeat: true, sendEmail });
  return added[0].memberId;
}

/**
 * Links memberships an admin created by e-mail to the account that just confirmed that e-mail, with their team keys,
 * so the person sees them on /account and can sign in as an admin when they are one.
 */
export async function linkMemberships(ctx: Ctx, user: UserDoc): Promise<void> {
  if (!user.emailVerifiedAt) return;
  const pending = await ctx.c.teamMembers.find({ email: user.email, userId: { $exists: false } }).toArray();
  for (const m of pending) {
    const linked = await ctx.c.teamMembers.updateOne({ _id: m._id, userId: { $exists: false } }, { $set: { userId: user._id } }).catch((error) => {
      // Already a member under the account (cannot happen while e-mails are unique, but never fail a sign-up on it).
      if ((error as { code?: number }).code === 11000) return null;
      throw error;
    });
    if (!linked?.modifiedCount) continue;
    await ctx.c.licenses.updateMany(
      { teamId: m.teamId, source: 'team', userId: { $exists: false }, $or: [{ memberId: m._id }, { memberId: { $exists: false }, 'payload.email': user.email }] },
      { $set: { userId: user._id } },
    );
    await audit(ctx, actorOf(user), 'team.member.link', { teamId: m.teamId, target: { type: 'user', id: user._id, email: user.email } });
  }
}

// Members list with usage from the opt-in app ping.

export interface MemberView {
  memberId: string;
  /** Unset while the person has no MotionQL account. */
  userId?: string;
  hasAccount: boolean;
  /** Unset for someone added by name only. */
  email?: string;
  name: string;
  role: TeamRole;
  hasSeat: boolean;
  edition: LicenseEdition;
  features: string[];
  joinedAt: string;
  addedBy?: string;
  license?: { licenseId: string; key: string; edition: LicenseEdition; features: string[]; issuedAt: string; expiresAt: string; status: string };
  usage?: { lastSeen: string; appVersion: string; platform: string; installs: number };
}

export async function listMembers(ctx: Ctx, teamId: string): Promise<MemberView[]> {
  const members = await ctx.c.teamMembers.find({ teamId }).sort({ joinedAt: 1, _id: 1 }).toArray();
  const userIds = members.flatMap((m) => (m.userId ? [m.userId] : []));
  const users = new Map((await ctx.c.users.find({ _id: { $in: userIds } }).toArray()).map((u) => [u._id, u]));
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
  return members.map((m) => {
    const user = m.userId ? users.get(m.userId) : undefined;
    const license = m.licenseId ? licenses.get(m.licenseId) : undefined;
    const use = license ? usage.get(license.hash) : undefined;
    return {
      memberId: m._id,
      ...(m.userId ? { userId: m.userId } : {}),
      hasAccount: Boolean(user),
      ...(m.email ? { email: m.email } : {}),
      name: user?.name ?? m.name ?? '',
      role: m.role,
      hasSeat: m.hasSeat,
      edition: m.edition,
      features: m.features,
      joinedAt: m.joinedAt.toISOString(),
      ...(m.addedBy ? { addedBy: m.addedBy } : {}),
      ...(license
        ? {
            license: {
              licenseId: license._id,
              key: license.key,
              edition: license.payload.edition,
              features: license.payload.features,
              issuedAt: license.payload.issuedAt,
              expiresAt: license.payload.expiresAt,
              status: licenseStatus(license, now),
            },
          }
        : {}),
      ...(use ? { usage: { lastSeen: use.lastSeen.toISOString(), appVersion: use.appVersion, platform: use.platform, installs: use.installs } } : {}),
    };
  });
}

// Every key the team has issued, for the admin's license inventory.

export interface TeamLicenseView extends Omit<LicenseView, 'key' | 'team'> {
  /** Only while the key works: a dead key is history, not something to hand out. */
  key?: string;
  /** Whether it is the key a member holds now. */
  current: boolean;
  /** `email` is the one in the key: the admin's for someone added without one. */
  assignee: { memberId?: string; email: string; name: string };
  revokeReason?: string;
  replacedBy?: string;
  issuedBy?: string;
}

export async function listTeamLicenses(ctx: Ctx, teamId: string): Promise<TeamLicenseView[]> {
  const [docs, members] = await Promise.all([
    ctx.c.licenses.find({ teamId }).sort({ issuedAt: -1, _id: -1 }).limit(5_000).toArray(),
    ctx.c.teamMembers.find({ teamId }).toArray(),
  ]);
  const users = new Map(
    (await ctx.c.users.find({ _id: { $in: members.flatMap((m) => (m.userId ? [m.userId] : [])) } }, { projection: { name: 1 } }).toArray()).map((u) => [u._id, u.name]),
  );
  const byId = new Map(members.map((m) => [m._id, m]));
  const byEmail = new Map(members.flatMap((m) => (m.email ? [[m.email, m] as const] : [])));
  const current = new Set(members.flatMap((m) => (m.licenseId ? [m.licenseId] : [])));
  const now = ctx.now();
  return docs.map((d) => {
    const { key, team: _team, ...view } = licenseView(d, now);
    const m = d.memberId ? byId.get(d.memberId) : byEmail.get(d.payload.email);
    return {
      ...view,
      ...(view.status === 'active' ? { key } : {}),
      current: current.has(d._id),
      assignee: { ...(m ? { memberId: m._id } : {}), email: m?.email ?? d.payload.email, name: (m?.userId ? users.get(m.userId) : undefined) ?? m?.name ?? '' },
      ...(d.revokeReason ? { revokeReason: d.revokeReason } : {}),
      ...(d.replacedBy ? { replacedBy: d.replacedBy } : {}),
      ...(d.issuedBy ? { issuedBy: d.issuedBy } : {}),
    };
  });
}

/** One row per key a member holds now, with the key itself, for IT to deploy (e.g. through device management). */
export async function licensesCsv(ctx: Ctx, teamId: string): Promise<string> {
  const members = await listMembers(ctx, teamId);
  const lines = [['email', 'name', 'role', 'has_account', 'status', 'edition', 'issued_at', 'expires_at', 'license_id', 'key'].join(',')];
  for (const m of members) {
    const l = m.license;
    lines.push(
      [m.email ?? '', m.name, m.role, m.hasAccount ? 'yes' : 'no', l?.status ?? 'no seat', l?.edition, l?.issuedAt, l?.expiresAt, l?.licenseId, l?.status === 'active' ? l.key : '']
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
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
  const alreadyMember = new Set((await ctx.c.teamMembers.find({ teamId: team._id, email: { $in: emails } }, { projection: { email: 1 } }).toArray()).map((m) => m.email));
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
    email: user.email,
    name: user.name,
    role: invite.role,
    hasSeat: false,
    edition: startingEdition(team, plan.edition),
    features: [],
    joinedAt: ctx.now(),
  };
  try {
    await ctx.c.teamMembers.insertOne(member);
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    // Already on the team, possibly added by e-mail before they had an account.
    await ctx.c.invites.deleteOne({ _id: invite._id });
    await linkMemberships(ctx, user);
    return { team, seatAssigned: false };
  }
  await ctx.c.invites.deleteOne({ _id: invite._id });
  const actor = actorOf(user);
  await audit(ctx, actor, 'team.invite.accept', { teamId: team._id, target: { type: 'user', id: user._id, email: user.email }, details: { role: invite.role } });
  let seatAssigned = false;
  if (invite.assignSeat) {
    try {
      await assignSeat(ctx, team, member, actor);
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
