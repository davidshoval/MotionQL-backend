import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadSigningKey } from '../src/config.js';

const { privateKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'right' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('loadSigningKey', () => {
  it('reads a PEM whose line breaks were pasted as spaces, nothing or literal \\n', () => {
    for (const pem of [privateKey, privateKey.replace(/\n/g, ' '), privateKey.replace(/\n/g, ''), privateKey.replace(/\n/g, '\\n')]) {
      expect(loadSigningKey(pem, 'right').asymmetricKeyType).toBe('ed25519');
    }
  });

  it('explains a wrong or missing passphrase and a partial paste', () => {
    expect(() => loadSigningKey(privateKey, 'wrong')).toThrow(/PASSPHRASE does not unlock/);
    expect(() => loadSigningKey(privateKey)).toThrow(/set LICENSE_SIGNING_KEY_PASSPHRASE/);
    expect(() => loadSigningKey(privateKey.split('\n').slice(1, -2).join('\n'), 'right')).toThrow(/BEGIN and -----END/);
  });
});

describe('loadConfig', () => {
  it('asks for MONGODB_URI in production instead of falling back to localhost', async () => {
    const { loadConfig } = await import('../src/config.js');
    const env = { NODE_ENV: 'production', LICENSE_SIGNING_KEY: privateKey, LICENSE_SIGNING_KEY_PASSPHRASE: 'right' };
    expect(() => loadConfig(env)).toThrow(/Set MONGODB_URI/);
    expect(loadConfig({ ...env, MONGODB_URI: 'mongodb+srv://u:p@example.net' }).mongoUri).toContain('example.net');
  });
});

describe('e-mail settings', () => {
  it('sends through Gmail SMTP with only an address and an app password', async () => {
    const { loadConfig } = await import('../src/config.js');
    const base = { LICENSE_SIGNING_KEY: privateKey, LICENSE_SIGNING_KEY_PASSPHRASE: 'right', EMAIL_PROVIDER: 'smtp' };
    expect(() => loadConfig(base)).toThrow(/SMTP_USER and SMTP_PASS/);
    const { email } = loadConfig({ ...base, SMTP_USER: 'me@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop' });
    expect(email.smtp).toEqual({ host: 'smtp.gmail.com', port: 465, user: 'me@gmail.com', pass: 'abcdefghijklmnop' });
    expect(email.from).toBe('MotionQL <me@gmail.com>');
  });
});
