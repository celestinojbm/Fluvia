import { createHash } from 'node:crypto';

/**
 * UUID v5 (RFC 4122, SHA-1) sobre un namespace fijo de Fluvia: la MISMA clave
 * produce SIEMPRE el mismo id — la base de que `pnpm seed` sea reproducible.
 */
const SEED_NAMESPACE = '2f1c9e46-2f4b-5f6a-9c3d-8a1b2c3d4e5f';

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

export function seedUuid(key: string): string {
  const hash = createHash('sha1')
    .update(uuidBytes(SEED_NAMESPACE))
    .update(key, 'utf8')
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // variante RFC 4122
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
