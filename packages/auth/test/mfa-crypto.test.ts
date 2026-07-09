import { describe, expect, it } from 'vitest';
import {
  decryptMfaSecret,
  decryptMfaSecretWithKeyring,
  encryptMfaSecret,
  generateTotpSecret,
  toMfaKeyring,
} from '../src/index.js';

/**
 * F6 (ADR-0012) — keyring de rotación de la clave de cifrado de secretos TOTP
 * (`MFA_SECRET_KEY`). El descifrado prueba las claves; el TAG de AES-GCM
 * disambigua (una clave ajena jamás autentica). Pruebas puras (sin BD).
 */

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);
const KEY_C = 'cc'.repeat(32);

describe('keyring de descifrado MFA (trial-decrypt por tag AES-GCM)', () => {
  it('la clave ACTUAL descifra e informa isCurrent=true', () => {
    const secret = generateTotpSecret();
    const enc = encryptMfaSecret(KEY_A, secret);
    const r = decryptMfaSecretWithKeyring({ current: KEY_A, retired: [] }, enc);
    expect(r.plaintext).toBe(secret);
    expect(r.isCurrent).toBe(true);
  });

  it('una clave RETIRADA descifra un blob viejo e informa isCurrent=false', () => {
    const secret = generateTotpSecret();
    const encUnderA = encryptMfaSecret(KEY_A, secret);
    const r = decryptMfaSecretWithKeyring({ current: KEY_B, retired: [KEY_A] }, encUnderA);
    expect(r.plaintext).toBe(secret);
    expect(r.isCurrent).toBe(false);
  });

  it('prueba las retiradas en orden y salta las que no autentican (por el tag)', () => {
    const secret = generateTotpSecret();
    const encUnderA = encryptMfaSecret(KEY_A, secret);
    const r = decryptMfaSecretWithKeyring({ current: KEY_B, retired: [KEY_C, KEY_A] }, encUnderA);
    expect(r.plaintext).toBe(secret);
    expect(r.isCurrent).toBe(false);
  });

  it('lanza si NINGUNA clave del keyring autentica (keyring equivocado)', () => {
    const enc = encryptMfaSecret(KEY_A, generateTotpSecret());
    expect(() => decryptMfaSecretWithKeyring({ current: KEY_B, retired: [KEY_C] }, enc)).toThrow(
      /no MFA enc key/i
    );
  });

  it('cada cifrado usa un IV fresco (dos cifrados del mismo secreto difieren)', () => {
    const secret = generateTotpSecret();
    expect(encryptMfaSecret(KEY_A, secret)).not.toBe(encryptMfaSecret(KEY_A, secret));
  });

  it('retro-compatible: decryptMfaSecret acepta una clave o un keyring', () => {
    const secret = generateTotpSecret();
    const enc = encryptMfaSecret(KEY_A, secret);
    expect(decryptMfaSecret(KEY_A, enc)).toBe(secret);
    expect(decryptMfaSecret({ current: KEY_B, retired: [KEY_A] }, enc)).toBe(secret);
    expect(toMfaKeyring(KEY_A)).toEqual({ current: KEY_A, retired: [] });
  });

  it('una clave MAL FORMADA surge con su error accionable (no la enmascara como «clave equivocada»)', () => {
    const enc = encryptMfaSecret(KEY_A, generateTotpSecret());
    expect(() => decryptMfaSecretWithKeyring({ current: 'not-hex', retired: [] }, enc)).toThrow(
      /64 hex/i
    );
    expect(() =>
      decryptMfaSecretWithKeyring({ current: KEY_B, retired: ['zz'.repeat(32)] }, enc)
    ).toThrow(/64 hex/i);
  });
});
