import { createHash, randomBytes } from 'node:crypto';

export interface GeneratedToken {
  /** Se entrega UNA sola vez al cliente; jamas se persiste. */
  plaintext: string;
  /** SHA-256 hex; lo unico que toca la base de datos. */
  hash: string;
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function generateToken(prefix: string): GeneratedToken {
  const plaintext = `${prefix}_${randomBytes(32).toString('hex')}`;
  return { plaintext, hash: hashToken(plaintext) };
}
