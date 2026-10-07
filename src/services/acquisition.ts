import type { Ctx } from '../context.js';
import { companyDomain } from '../lib/freeMail.js';

// Where sign-ups come from, per first-touch utm_source (the website records it on the visitor's first page and sends
// it with sign-up). Companies are counted by e-mail domain; personal mailboxes (gmail.com and the like) are not
// companies. A company's size is every account at its domain up to the end of the range, whatever brought them in,
// so a newsletter that brings in one person whose colleagues follow gets the credit. A company can appear under
// more than one source.

export interface AcquisitionRow {
  /** Lower-cased utm_source; null for sign-ups without one (direct, search, older accounts). */
  utmSource: string | null;
  signups: number;
  /** Signed up and confirmed their e-mail. */
  confirmed: number;
  /** Distinct company domains among these sign-ups. */
  companies: number;
  /** Of those companies, how many have 2 or more, and 3 or more, accounts. */
  companies2Plus: number;
  companies3Plus: number;
  /** Signed-up users whose key (free, team or staff-issued) has been seen in the app's usage ping. */
  activated: number;
}

export interface AcquisitionRange {
  from?: Date;
  to?: Date;
}

const sourceOf = (s: string | undefined) => s?.trim().toLowerCase() || null;

export async function acquisitionReport(ctx: Ctx, range: AcquisitionRange) {
  const createdAt = { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lt: range.to } : {}) };
  const users = await ctx.c.users
    .find(Object.keys(createdAt).length ? { createdAt } : {}, { projection: { _id: 1, email: 1, emailVerifiedAt: 1, 'attribution.utmSource': 1 } })
    .toArray();

  // Accounts per company domain, up to the end of the range.
  const domains = [...new Set(users.map((u) => companyDomain(u.email)).filter((d): d is string => Boolean(d)))];
  const sizes = new Map<string, number>();
  if (domains.length) {
    const rows = await ctx.c.users
      .aggregate<{ _id: string; n: number }>([
        ...(range.to ? [{ $match: { createdAt: { $lt: range.to } } }] : []),
        { $project: { d: { $toLower: { $arrayElemAt: [{ $split: ['$email', '@'] }, -1] } } } },
        { $match: { d: { $in: domains } } },
        { $group: { _id: '$d', n: { $sum: 1 } } },
      ])
      .toArray();
    for (const r of rows) sizes.set(r._id, r.n);
  }

  // Activated: one of the user's keys has been seen in a usage ping.
  const licenses = users.length
    ? await ctx.c.licenses.find({ userId: { $in: users.map((u) => u._id) } }, { projection: { userId: 1, hash: 1 } }).toArray()
    : [];
  const seen = new Set(
    licenses.length ? (await ctx.c.installs.distinct('licenseHash', { licenseHash: { $in: licenses.map((l) => l.hash) } })).filter(Boolean) : [],
  );
  const activatedUsers = new Set(licenses.filter((l) => l.userId && seen.has(l.hash)).map((l) => l.userId!));

  const bySource = new Map<string | null, { signups: number; confirmed: number; activated: number; domains: Set<string> }>();
  for (const u of users) {
    const key = sourceOf(u.attribution?.utmSource);
    let row = bySource.get(key);
    if (!row) bySource.set(key, (row = { signups: 0, confirmed: 0, activated: 0, domains: new Set() }));
    row.signups++;
    if (u.emailVerifiedAt) row.confirmed++;
    if (activatedUsers.has(u._id)) row.activated++;
    const d = companyDomain(u.email);
    if (d) row.domains.add(d);
  }

  const sources: AcquisitionRow[] = [...bySource.entries()]
    .map(([utmSource, r]) => {
      const counts = [...r.domains].map((d) => sizes.get(d) ?? 1);
      return {
        utmSource,
        signups: r.signups,
        confirmed: r.confirmed,
        companies: r.domains.size,
        companies2Plus: counts.filter((n) => n >= 2).length,
        companies3Plus: counts.filter((n) => n >= 3).length,
        activated: r.activated,
      };
    })
    .sort((a, b) => b.signups - a.signups || (a.utmSource ?? '￿').localeCompare(b.utmSource ?? '￿'));

  return {
    from: range.from?.toISOString() ?? null,
    to: range.to?.toISOString() ?? null,
    totals: {
      signups: users.length,
      confirmed: users.filter((u) => u.emailVerifiedAt).length,
      companies: domains.length,
      activated: activatedUsers.size,
    },
    sources,
  };
}
