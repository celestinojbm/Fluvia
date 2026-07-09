import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Secretos de endpoint cifrados en reposo (AES-256-GCM, mismo formato que el
 * secreto TOTP de F1-04b: base64(iv12 | tag16 | ct)). El secreto DEBE ser
 * recuperable para firmar cada entrega; un dump de la base sin la clave de
 * servidor no permite forjar webhooks hacia los comercios.
 *
 * ROTACIÓN de la CLAVE de cifrado (F6, ADR-0012): un KEYRING con una clave
 * ACTUAL (cifra) + claves RETIRADAS (solo descifran) permite rotar sin downtime.
 * El descifrado PRUEBA cada clave: el TAG de autenticación de AES-GCM es un
 * check criptográfico de «¿es esta la clave correcta?» (un tag ajeno jamás
 * autentica salvo forja de 2^-128), así que NO hace falta versionar el blob ni
 * añadir columnas. Tras la rotación, `reencryptWebhookSecrets` (rotate.ts)
 * migra los blobs a la clave actual y la retirada se puede eliminar.
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

/**
 * Keyring de descifrado: la clave ACTUAL (con la que se cifra) + las RETIRADAS
 * (solo descifran, durante la ventana de rotación). Sin retiradas = comportamiento
 * de clave única.
 */
export interface WebhookEncKeyring {
  current: string;
  retired: string[];
}

/** Normaliza un hex o un keyring a keyring (retro-compatibilidad de firmas). */
export function toKeyring(key: string | WebhookEncKeyring): WebhookEncKeyring {
  return typeof key === 'string' ? { current: key, retired: [] } : key;
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

/** Descifra con UNA clave; devuelve null si el tag no autentica (clave equivocada). */
function tryDecrypt(keyHex: string, encoded: string): string | null {
  // La validación de FORMATO de la clave se hace FUERA del try: una clave mal
  // configurada (longitud/hex) debe surgir con su error accionable, no quedar
  // enmascarada como «clave equivocada». Solo el fallo del TAG (clave ajena o
  // dato corrupto) es lo que degradamos a null para seguir probando el keyring.
  const key = parseWebhookEncKey(keyHex);
  try {
    const raw = Buffer.from(encoded, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // Tag inválido para esta clave (o entrada corrupta): la prueba de la
    // siguiente clave del keyring decidirá. Si ninguna autentica, el llamador lanza.
    return null;
  }
}

/**
 * Descifra probando el keyring: primero la ACTUAL (isCurrent=true), luego cada
 * RETIRADA en orden (isCurrent=false). `isCurrent` le dice a la rotación si el
 * blob ya está bajo la clave actual o hay que re-cifrarlo. Lanza si ninguna clave
 * autentica (keyring equivocado o dato corrupto).
 */
export function decryptEndpointSecretWithKeyring(
  keyring: WebhookEncKeyring,
  encoded: string
): { plaintext: string; isCurrent: boolean } {
  const asCurrent = tryDecrypt(keyring.current, encoded);
  if (asCurrent !== null) return { plaintext: asCurrent, isCurrent: true };
  for (const retired of keyring.retired) {
    const asRetired = tryDecrypt(retired, encoded);
    if (asRetired !== null) return { plaintext: asRetired, isCurrent: false };
  }
  throw new Error('no webhook enc key in the keyring can decrypt this secret');
}

/** Retro-compatible: descifra con una clave (o keyring) y devuelve solo el claro. */
export function decryptEndpointSecret(key: string | WebhookEncKeyring, encoded: string): string {
  return decryptEndpointSecretWithKeyring(toKeyring(key), encoded).plaintext;
}
