import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/**
 * Hashing de contraseñas con scrypt (node:crypto, sin dependencia nativa).
 * Parametros orientados a OWASP (N=2^15, r=8, p=1). Formato versionado
 * `scrypt$N$r$p$salt$hash`: permite migrar a argon2id u otros parametros
 * sin invalidar hashes existentes.
 */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 64 * 1024 * 1024;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(plain, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** Retorna false ante formato corrupto o password incorrecto; jamas lanza por input hostil. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const derived = await scrypt(plain, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAX_MEM,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

let dummyHashPromise: Promise<string> | undefined;

/**
 * Hash "sacrificial" para igualar el costo temporal del login cuando el email
 * no existe (anti account-enumeration por timing).
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(24).toString('hex'));
  return dummyHashPromise;
}
