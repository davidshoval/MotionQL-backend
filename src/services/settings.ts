import type { Actor, Ctx } from '../context.js';
import type { FreePlanSettings, TeamPlanSettings } from '../db.js';
import { audit } from './audit.js';

/** Owner decision (1 Oct 2026): every registered user gets a free 1-year Pro key for now. */
export const DEFAULT_FREE_PLAN: FreePlanSettings = {
  _id: 'free',
  enabled: true,
  edition: 'pro',
  features: [],
  durationDays: 365,
  renewable: true,
  renewWindowDays: 30,
};

/** Team seats are free for now, with a per-team limit staff can raise. */
export const DEFAULT_TEAM_PLAN: TeamPlanSettings = {
  _id: 'team',
  defaultSeatLimit: 25,
  edition: 'pro',
  durationDays: 365,
};

export async function getFreePlan(ctx: Ctx): Promise<FreePlanSettings> {
  const doc = (await ctx.c.plans.findOne({ _id: 'free' })) as FreePlanSettings | null;
  return { ...DEFAULT_FREE_PLAN, ...doc };
}

export async function getTeamPlan(ctx: Ctx): Promise<TeamPlanSettings> {
  const doc = (await ctx.c.plans.findOne({ _id: 'team' })) as TeamPlanSettings | null;
  return { ...DEFAULT_TEAM_PLAN, ...doc };
}

export async function updateFreePlan(ctx: Ctx, actor: Actor, patch: Partial<Omit<FreePlanSettings, '_id'>>): Promise<FreePlanSettings> {
  const next = { ...(await getFreePlan(ctx)), ...patch, updatedAt: ctx.now(), updatedBy: actor.email };
  await ctx.c.plans.replaceOne({ _id: 'free' }, next, { upsert: true });
  await audit(ctx, actor, 'settings.free_plan.update', { target: { type: 'settings', id: 'free' }, details: patch });
  return next;
}

export async function updateTeamPlan(ctx: Ctx, actor: Actor, patch: Partial<Omit<TeamPlanSettings, '_id'>>): Promise<TeamPlanSettings> {
  const next = { ...(await getTeamPlan(ctx)), ...patch, updatedAt: ctx.now(), updatedBy: actor.email };
  await ctx.c.plans.replaceOne({ _id: 'team' }, next, { upsert: true });
  await audit(ctx, actor, 'settings.team_plan.update', { target: { type: 'settings', id: 'team' }, details: patch });
  return next;
}
