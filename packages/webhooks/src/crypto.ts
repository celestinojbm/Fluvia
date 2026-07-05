import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Secretos de endpoint cifrados en reposo (AES-256-GCM, mismo formato que el
 * secreto TOTP de F1-04b: base64(iv12 | tag16 | ct)). El secreto DEBE ser
 * recuperable para firmar cada entrega; un dump de la base sin la clave de
 * servidor no permite forjar webhooks hacia los comercios.
 */

/** Clave SOLO desarrollo local (regimen R-12); fuera de local por entorno. */
export const DEV_WEBHOOK_SECRET_ENC_KEY_HEX =
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'; // gitleaks:allow

export function parseWebhookEncKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/iu.test(hex)) {
    throw new Error('WEBHOOK_SECRET_ENC_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/** Secreto por endpoint: se muestra UNA sola vez al crear/rotar. */
export function generateEndpointSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

export function encryptEndpointSecret(keyHex: string, secret: string): string {
  const key = parseWebhookEncKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptEndpointSecret(keyHex: string, encoded: string): string {
  const key = parseWebhookEncKey(keyHex);
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
