/**
 * Writes a development Ed25519 key pair to .license-dev/ (gitignored) and prints the .env lines.
 * Keys it signs only work in app builds that embed its public key. For the app's own dev key, point
 * LICENSE_SIGNING_KEY_FILE at the Platform repo's .license-dev/motionql-license-private.pem instead.
 * Production keys are made offline with the app's `npm run license -- keygen` and never touch this repo.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { publicKeyBase64 } from '../src/config.js';

const dir = '.license-dev';
const file = `${dir}/motionql-license-private.pem`;
if (existsSync(file)) {
  console.error(`${file} already exists; delete it first to make a new one.`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const { privateKey } = generateKeyPairSync('ed25519');
writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
console.log(`Wrote ${file}\n\nAdd to .env:\nLICENSE_SIGNING_KEY_FILE=${file}\n\nPublic key (for a dev build of the app):\n${publicKeyBase64(privateKey)}`);
