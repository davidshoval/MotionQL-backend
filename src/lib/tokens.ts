import { createHash, randomBytes } from 'node:crypto';

/** A random token for a cookie or an e-mail link (256 bits). Only its hash is stored. */
export const newToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** The hash the app sends in its usage ping and that the manifest lists for revoked keys (the app's own function). */
export { licenseHash as licenseHashOf } from '../licensing/licenseFormat.js';
