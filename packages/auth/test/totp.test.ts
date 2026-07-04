import { describe, expect, it } from 'vitest';
import {
  DEV_MFA_SECRET_KEY_HEX,
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  hotpCode,
  otpauthUri,
  parseMfaKey,
  totpCode,
  verifyTotp,
} from '../src/index.js';

/** Secreto de los vectores RFC 6238 ("12345678901234567890" en base32). */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('TOTP RFC 6238 (SHA-1, 6 digitos, 30 s)', () => {
  it('matches the RFC 6238 Appendix B test vectors (truncated to 6 digits)', () => {
    // (epoch segundos, codigo de 8 digitos del RFC) — se comparan los 6 finales.
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, rfc8] of vectors) {
      expect(totpCode(RFC_SECRET, seconds * 1000), `t=${seconds}`).toBe(rfc8.slice(2));
    }
  });

  it('verifyTotp accepts the +/-1 step window, rejects outside, returns the matched step', () => {
    const now = 1_111_111_109_000; // step 37037036
    const code = totpCode(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now })).toBe(37037036n);
    // Mismo codigo evaluado un paso despues: sigue dentro de la ventana.
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now + 30_000 })).toBe(37037036n);
    // Dos pasos despues: fuera.
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now + 61_000 })).toBeNull();
    // Basura y formato invalido.
    expect(verifyTotp(RFC_SECRET, '000000', { nowMs: now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', { nowMs: now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', { nowMs: now })).toBeNull();
  });

  it('base32 roundtrips and rejects invalid characters', () => {
    const buf = Buffer.from('fluvia-totp-roundtrip');
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(() => base32Decode('abc$def')).toThrow(/invalid base32/);
  });

  it('generates 160-bit secrets and a scannable otpauth URI', () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    const uri = otpauthUri(secret, 'ops@fluvia.dev');
    expect(uri).toContain('otpauth://totp/Fluvia%3Aops%40fluvia.dev');
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('period=30');
  });

  it('hotp codes differ per counter (sanity against constant output)', () => {
    const codes = new Set(Array.from({ length: 10 }, (_, i) => hotpCode(RFC_SECRET, BigInt(i))));
    expect(codes.size).toBeGreaterThan(8);
  });
});

describe('cifrado del secreto TOTP en reposo (AES-256-GCM)', () => {
  const key = parseMfaKey(DEV_MFA_SECRET_KEY_HEX);

  it('roundtrips and produces distinct ciphertexts (IV aleatorio)', () => {
    const secret = generateTotpSecret();
    const a = encryptSecret(key, secret);
    const b = encryptSecret(key, secret);
    expect(a).not.toBe(b);
    expect(decryptSecret(key, a)).toBe(secret);
    expect(decryptSecret(key, b)).toBe(secret);
  });

  it('tampered ciphertext or wrong key fails authentication', () => {
    const secret = generateTotpSecret();
    const enc = encryptSecret(key, secret);
    const tampered = Buffer.from(enc, 'base64');
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(() => decryptSecret(key, tampered.toString('base64'))).toThrow();
    const otherKey = parseMfaKey('f'.repeat(64));
    expect(() => decryptSecret(otherKey, enc)).toThrow();
  });

  it('rejects malformed keys', () => {
    expect(() => parseMfaKey('short')).toThrow(/64 hex/);
    expect(() => parseMfaKey('g'.repeat(64))).toThrow(/64 hex/);
  });
});
