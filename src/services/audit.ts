import type { AuditEventDoc } from '../db.js';
import type { Actor, Ctx } from '../context.js';
import { newId } from '../lib/ids.js';

/** Every write that matters goes through here, so team admins and staff can see who did what. */
export async function audit(
  ctx: Ctx,
  actor: Pick<Actor, 'id' | 'email'> | undefined,
  action: string,
  event: Omit<AuditEventDoc, '_id' | 'at' | 'action' | 'actorId' | 'actorEmail'> = {},
): Promise<void> {
  await ctx.c.auditEvents.insertOne({
    _id: newId('evt'),
    at: ctx.now(),
    action,
    ...(actor ? { actorId: actor.id, actorEmail: actor.email } : {}),
    ...event,
  });
}
