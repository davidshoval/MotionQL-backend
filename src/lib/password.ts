import { hash, verify } from '@node-rs/argon2';

// argon2id with OWASP's recommended minimum (19 MiB, 2 passes).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string) => hash(password, OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** A real hash to verify against when the e-mail is unknown, so login timing does not reveal accounts. */
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword('not-a-real-password-xquery'));
