import type { Ctx } from '../context.js';
import type { UserDoc } from '../db.js';
import { badRequest, conflict } from '../errors.js';
import { verifyPassword } from '../lib/password.js';
import { audit } from './audit.js';
import { revokeLicense } from './licenses.js';
import { deleteTeam, freeSeat } from './teams.js';

/**
 * Deletes the account and everything personal: sessions, e-mail tokens, team memberships (a team where the user is
 * the only member is deleted too). Their keys are revoked. Owners of teams with other members must transfer first.
 * Audit events keep the e-mail so team admins can still read their history.
 */
export async function deleteAccount(ctx: Ctx, user: UserDoc, password: string): Promise<void> {
  if (!(await verifyPassword(user.passwordHash, password))) throw badRequest('wrong_password', 'Your password is not correct.');
  const actor = { id: user._id, email: user.email, isStaff: user.isStaff };
  const memberships = await ctx.c.teamMembers.find({ userId: user._id }).toArray();
  for (const m of memberships.filter((x) => x.role === 'owner')) {
    const others = await ctx.c.teamMembers.countDocuments({ teamId: m.teamId, userId: { $ne: user._id } });
    if (others > 0) throw conflict('owns_team', 'Transfer ownership of your teams before deleting your account.');
  }
  for (const m of memberships) {
    const team = await ctx.c.teams.findOne({ _id: m.teamId });
    if (!team) continue;
    if (m.role === 'owner') {
      await deleteTeam(ctx, { team, member: m, role: 'owner' }, actor);
    } else {
      await freeSeat(ctx, team, m, actor, 'account deleted');
      await ctx.c.teamMembers.deleteOne({ _id: m._id });
    }
  }
  const keys = await ctx.c.licenses.find({ userId: user._id, revokedAt: { $exists: false } }, { projection: { _id: 1 } }).toArray();
  for (const { _id } of keys) await revokeLicense(ctx, _id, 'account deleted', actor);
  await ctx.c.licenses.updateMany({ userId: user._id }, { $unset: { userId: '' } });
  await ctx.c.sessions.deleteMany({ userId: user._id });
  await ctx.c.emailTokens.deleteMany({ userId: user._id });
  await ctx.c.users.deleteOne({ _id: user._id });
  await audit(ctx, actor, 'user.delete', { target: { type: 'user', id: user._id, email: user.email } });
}
