import { describe, expect, it } from 'vitest';
import {
  decryptEndpointSecret,
  decryptEndpointSecretWithKeyring,
  encryptEndpointSecret,
  generateEndpointSecret,
  toKeyring,
} from '../src/index.js';

/**
 * F6 (ADR-0012) — keyring de rotación de la clave de cifrado de webhooks.
 * El descifrado prueba las claves; el TAG de AES-GCM disambigua (una clave
 * ajena jamás autentica). Pruebas puras (sin BD).
 */

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);
const KEY_C = 'cc'.repeat(32);

describe('keyring de descifrado (trial-decrypt por tag AES-GCM)', () => {
  it('la clave ACTUAL descifra e informa isCurrent=true', () => {
    const secret = generateEndpointSecret();
    const enc = encryptEndpointSecret(KEY_A, secret);
    const r = decryptEndpointSecretWithKeyring({ current: KEY_A, retired: [] }, enc);
    expect(r.plaintext).toBe(secret);
    expect(r.isCurrent).toBe(true);
  });

  it('una clave RETIRADA descifra un blob viejo e informa isCurrent=false', () => {
    const secret = generateEndpointSecret();
    const encUnderA = encryptEndpointSecret(KEY_A, secret);
    // Rotación: la actual es B, A quedó retirada.
    const r = decryptEndpointSecretWithKeyring({ current: KEY_B, retired: [KEY_A] }, encUnderA);
    expect(r.plaintext).toBe(secret);
    expect(r.isCurrent).toBe(false);
  });

  it('prueba las retiradas en orden y salta las que no autentican (por el tag)', () => {
    const secret = generateEndpointSecret();
    const encUnderA = encryptEndpointSecret(KEY_A, secret);
    // C no autentica (tag) → se prueba A → éxito.
    const r = decryptEndpointSecretWithKeyring(
      { current: KEY_B, retired: [KEY_C, KEY_A] },
      encUnderA
    );
    expect(r.plaintext).toBe(secret);
    expect(r.isCurrent).toBe(false);
  });

  it('lanza si NINGUNA clave del keyring autentica (keyring equivocado)', () => {
    const enc = encryptEndpointSecret(KEY_A, generateEndpointSecret());
    expect(() =>
      decryptEndpointSecretWithKeyring({ current: KEY_B, retired: [KEY_C] }, enc)
    ).toThrow(/no webhook enc key/i);
  });

  it('cada cifrado usa un IV fresco (dos cifrados del mismo secreto difieren)', () => {
    const secret = generateEndpointSecret();
    expect(encryptEndpointSecret(KEY_A, secret)).not.toBe(encryptEndpointSecret(KEY_A, secret));
  });

  it('retro-compatible: decryptEndpointSecret acepta una clave o un keyring', () => {
    const secret = generateEndpointSecret();
    const enc = encryptEndpointSecret(KEY_A, secret);
    expect(decryptEndpointSecret(KEY_A, enc)).toBe(secret);
    expect(decryptEndpointSecret({ current: KEY_B, retired: [KEY_A] }, enc)).toBe(secret);
    expect(toKeyring(KEY_A)).toEqual({ current: KEY_A, retired: [] });
  });

  it('una clave MAL FORMADA surge con su error accionable (no la enmascara como «clave equivocada»)', () => {
    const enc = encryptEndpointSecret(KEY_A, generateEndpointSecret());
    // Clave actual mal formada: error de FORMATO explícito, no el genérico «no key».
    expect(() =>
      decryptEndpointSecretWithKeyring({ current: 'not-hex', retired: [] }, enc)
    ).toThrow(/64 hex/i);
    // Clave retirada mal formada: idem al llegar a probarla (la actual no autentica).
    expect(() =>
      decryptEndpointSecretWithKeyring({ current: KEY_B, retired: ['zz'.repeat(32)] }, enc)
    ).toThrow(/64 hex/i);
  });
});
