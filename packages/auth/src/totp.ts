import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP RFC 6238 (sobre HOTP RFC 4226), SHA-1, 6 digitos, paso de 30 s —
 * compatible con Google Authenticator/Authy/1Password. Implementacion propia
 * sin dependencias (verificada contra los vectores del RFC en tests).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/u, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** Secreto nuevo: 20 bytes aleatorios en base32 (160 bits, RFC 4226 §4). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Codigo HOTP para un contador dado (RFC 4226 §5, truncamiento dinamico). */
export function hotpCode(secretBase32: string, counter: bigint): string {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', key).update(msg).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    (((digest[offset]! & 0x7f) << 24) |
      ((digest[offset + 1]! & 0xff) << 16) |
      ((digest[offset + 2]! & 0xff) << 8) |
      (digest[offset + 3]! & 0xff)) %
    10 ** TOTP_DIGITS;
  return code.toString().padStart(TOTP_DIGITS, '0');
}

export function totpStep(nowMs: number, stepSeconds = TOTP_STEP_SECONDS): bigint {
  return BigInt(Math.floor(nowMs / 1000 / stepSeconds));
}

export function totpCode(
  secretBase32: string,
  nowMs: number,
  stepSeconds = TOTP_STEP_SECONDS
): string {
  return hotpCode(secretBase32, totpStep(nowMs, stepSeconds));
}

export interface VerifyTotpOptions {
  nowMs?: number;
  stepSeconds?: number;
  /** Pasos de tolerancia hacia cada lado (1 => +/-30 s de skew). */
  window?: number;
}

/**
 * Devuelve el STEP que produjo el match (para anti-replay: el llamador exige
 * step > totp_last_used_step) o null si el codigo no corresponde.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: VerifyTotpOptions = {}
): bigint | null {
  if (!/^\d{6}$/u.test(code)) return null;
  const stepSeconds = options.stepSeconds ?? TOTP_STEP_SECONDS;
  const window = options.window ?? 1;
  const current = totpStep(options.nowMs ?? Date.now(), stepSeconds);
  for (let i = -window; i <= window; i += 1) {
    const step = current + BigInt(i);
    if (step < 0n) continue;
    if (hotpCode(secretBase32, step) === code) return step;
  }
  return null;
}

export function otpauthUri(secretBase32: string, accountEmail: string, issuer = 'Fluvia'): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// ----------------------------------------------------------------------------
// Cifrado del secreto TOTP en reposo (AES-256-GCM). El secreto TOTP debe ser
// RECUPERABLE (a diferencia de un password) — cifrado con clave de entorno,
// no hasheado. Formato: base64(iv[12] | tag[16] | ciphertext).
// ----------------------------------------------------------------------------

/** SOLO desarrollo local (regimen R-12); fuera de local la clave viene por entorno. */
export const DEV_MFA_SECRET_KEY_HEX =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

export function parseMfaKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/iu.test(hex)) {
    throw new Error('MFA_SECRET_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(key: Buffer, payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
