import { z } from 'zod';
import { EDITIONS, PRO_FEATURE_IDS } from '../licensing/types.js';

export const email = z.string().trim().max(254).email('Enter a valid e-mail address.');
export const password = z.string().min(10, 'Use at least 10 characters.').max(200);
export const personName = z.string().trim().min(1, 'Enter your name.').max(100);
export const company = z.string().trim().max(150);
export const token = z.string().min(20).max(200);
export const edition = z.enum(EDITIONS as unknown as [string, ...string[]]).transform((v) => v as (typeof EDITIONS)[number]);
export const features = z.array(z.enum(PRO_FEATURE_IDS)).max(32);
export const id = z.string().min(1).max(64);
export const limit = z.coerce.number().int().min(1).max(200).default(50);
export const heardFrom = z.string().trim().max(100).optional();

// First-touch marketing attribution the website records on the visitor's first page and sends with sign-up.
// Short, printable text only: these end up in a staff report, never in markup.
const printable = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, 'Must not contain control characters.');
export const ATTRIBUTION_LIMITS = { utm: 100, landingPath: 300, referrerHost: 253 } as const;
export const attribution = z
  .object({
    utmSource: printable(ATTRIBUTION_LIMITS.utm).optional(),
    utmMedium: printable(ATTRIBUTION_LIMITS.utm).optional(),
    utmCampaign: printable(ATTRIBUTION_LIMITS.utm).optional(),
    utmContent: printable(ATTRIBUTION_LIMITS.utm).optional(),
    landingPath: printable(ATTRIBUTION_LIMITS.landingPath)
      .refine((p) => p === '' || p.startsWith('/'), 'Must be a path starting with /.')
      .optional(),
    referrerHost: z
      .string()
      .trim()
      .max(ATTRIBUTION_LIMITS.referrerHost)
      .regex(/^[A-Za-z0-9.-]*(:\d{1,5})?$/, 'Must be a host name.')
      .optional(),
  })
  .optional();
