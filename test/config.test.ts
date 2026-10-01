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
