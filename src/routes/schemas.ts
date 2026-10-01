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
