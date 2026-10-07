import type { Ctx } from '../context.js';
import type { UsageEventDoc, UsageEventName } from '../db.js';
import { newId } from '../lib/ids.js';
import { DAY_MS } from '../lib/time.js';

// Opt-in usage pings from the app (POST /v1/usage) and the retention report built from them. The app sends these only
// after the user turns them on. Stored: the ping's fields and the server's date; never the IP or anything else about
// the request. Rows go 25 months after they were written (TTL index), like installs.

export interface UsageInput {
  installId: string;
  appVersion: string;
  os: string;
  arch: string;
  event: UsageEventName;
  /** The license hash the app already has (sha256 of "motionql-license-id:" + licenseId). */
  licenseId?: string;
}

/**
 * `app_open` is stored every time. `first_connection` is kept once per install (installs that upgrade send one late;
 * repeats are ignored) and `active_day` once per install per UTC day: both get a deterministic id and are only
 * inserted when that id is new, so the first one wins.
 */
export async function recordUsage(ctx: Ctx, input: UsageInput): Promise<void> {
  const now = ctx.now();
  const installId = input.installId.toLowerCase();
  const fields: Omit<UsageEventDoc, '_id'> = {
    installId,
    appVersion: input.appVersion,
    os: input.os,
    arch: input.arch,
    event: input.event,
    ...(input.licenseId ? { licenseHash: input.licenseId.toLowerCase() } : {}),
    at: now,
  };
  if (input.event === 'app_open') {
    await ctx.c.usageEvents.insertOne({ _id: newId('use'), ...fields });
    return;
  }
  const _id = input.event === 'first_connection' ? `${installId}:first_connection` : `${installId}:active_day:${now.toISOString().slice(0, 10)}`;
  try {
    await ctx.c.usageEvents.updateOne({ _id }, { $setOnInsert: fields }, { upsert: true });
  } catch (error) {
    // Two copies at once: the other one was stored.
    if ((error as { code?: number }).code !== 11000) throw error;
  }
}

export const RETENTION_DAYS = [1, 7, 30] as const;

interface Point {
  /** Installs whose day N is over, so they could have come back on it. */
  eligible: number;
  /** Of those, active (any event) on day N after their first day. */
  retained: number;
  /** retained / eligible, 0 to 1; null while nobody is eligible. */
  rate: number | null;
}

interface RetentionRow {
  installs: number;
  d1: Point;
  d7: Point;
  d30: Point;
}

interface InstallDays {
  id: string;
  /** Start (UTC) of the first day the install sent anything. */
  first: number;
  /** Starts (UTC) of every day it sent anything. */
  days: Set<number>;
}

const dayStart = (d: Date) => Math.floor(d.getTime() / DAY_MS) * DAY_MS;
/** Monday 00:00 UTC of the week holding `ms` (1970-01-01 was a Thursday). */
const weekStart = (ms: number) => ms - ((Math.floor(ms / DAY_MS) + 3) % 7) * DAY_MS;

function summarize(installs: InstallDays[], todayStart: number): RetentionRow {
  const point = (n: number): Point => {
    // Day N is over once the day after it has begun.
    const eligible = installs.filter((i) => i.first + (n + 1) * DAY_MS <= todayStart);
    const retained = eligible.filter((i) => i.days.has(i.first + n * DAY_MS)).length;
    return { eligible: eligible.length, retained, rate: eligible.length ? Math.round((retained / eligible.length) * 1000) / 1000 : null };
  };
  return { installs: installs.length, d1: point(1), d7: point(7), d30: point(30) };
}

function groupBy<K>(items: InstallDays[], key: (i: InstallDays) => K | undefined): Map<K, InstallDays[]> {
  const out = new Map<K, InstallDays[]>();
  for (const i of items) {
    const k = key(i);
    if (k === undefined) continue;
    const list = out.get(k);
    if (list) list.push(i);
    else out.set(k, [i]);
  }
  return out;
}

const bySourceOrder = (a: { installs: number; utmSource: string | null }, b: { installs: number; utmSource: string | null }) =>
  b.installs - a.installs || (a.utmSource ?? '￿').localeCompare(b.utmSource ?? '￿');

/**
 * D1/D7/D30 retention of installs by the week (Monday, UTC) of their first usage ping, and the same per first-touch
 * utm_source for installs whose license hash belongs to an account. `from`/`to` filter on the install's first ping.
 */
export async function retentionReport(ctx: Ctx, range: { from?: Date; to?: Date }) {
  const todayStart = dayStart(ctx.now());
  const first = { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lt: range.to } : {}) };
  const grouped = await ctx.c.usageEvents
    .aggregate<{ _id: string; first: Date; days: Date[] }>([
      { $group: { _id: '$installId', first: { $min: '$at' }, days: { $addToSet: { $dateTrunc: { date: '$at', unit: 'day' } } } } },
      ...(Object.keys(first).length ? [{ $match: { first } }] : []),
    ])
    .toArray();
  const installs: InstallDays[] = grouped.map((g) => ({ id: g._id, first: dayStart(g.first), days: new Set(g.days.map((d) => d.getTime())) }));

  const cohorts = [...groupBy(installs, (i) => weekStart(i.first)).entries()]
    .sort(([a], [b]) => a - b)
    .map(([w, list]) => ({ week: new Date(w).toISOString().slice(0, 10), ...summarize(list, todayStart) }));

  // Link installs to accounts: the latest license hash the install sent, the license with that hash, its owner.
  const latestHash = installs.length
    ? await ctx.c.usageEvents
        .aggregate<{ _id: string; hash: string }>([
          { $match: { installId: { $in: installs.map((i) => i.id) }, licenseHash: { $type: 'string' } } },
          { $sort: { at: -1 } },
          { $group: { _id: '$installId', hash: { $first: '$licenseHash' } } },
        ])
        .toArray()
    : [];
  const licenses = latestHash.length
    ? await ctx.c.licenses
        .find({ hash: { $in: [...new Set(latestHash.map((h) => h.hash))] }, userId: { $type: 'string' } }, { projection: { hash: 1, userId: 1 } })
        .toArray()
    : [];
  const ownerOfHash = new Map(licenses.map((l) => [l.hash, l.userId!]));
  const users = licenses.length
    ? await ctx.c.users.find({ _id: { $in: [...new Set(licenses.map((l) => l.userId!))] } }, { projection: { 'attribution.utmSource': 1 } }).toArray()
    : [];
  const sourceOfUser = new Map(users.map((u) => [u._id, u.attribution?.utmSource?.trim().toLowerCase() || null]));
  const sourceOfInstall = new Map<string, string | null>();
  for (const h of latestHash) {
    const owner = ownerOfHash.get(h.hash);
    if (owner && sourceOfUser.has(owner)) sourceOfInstall.set(h._id, sourceOfUser.get(owner)!);
  }

  const bySource = [...groupBy(installs, (i) => sourceOfInstall.get(i.id)).entries()]
    .map(([utmSource, list]) => ({ utmSource, ...summarize(list, todayStart) }))
    .sort(bySourceOrder);

  return {
    from: range.from?.toISOString() ?? null,
    to: range.to?.toISOString() ?? null,
    days: RETENTION_DAYS,
    totals: { linkedInstalls: sourceOfInstall.size, ...summarize(installs, todayStart) },
    cohorts,
    bySource,
  };
}
