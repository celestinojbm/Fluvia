import type { Pool, PoolClient } from '@fluvia/db';

/**
 * Rotación del pepper HMAC de API keys (F6, ADR-0012 — TERCERA pata). El pepper es
 * ONE-WAY, así que NO hay barrido que re-hashee: el re-hash pepper-viejo→nuevo es
 * PEREZOSO, dentro de `authenticate_api_key` (migr. 0044), en la misma llamada que
 * ya sube v1(sha256)→v2(hmac). Este módulo aporta las DOS piezas operativas que sí
 * corren fuera de banda:
 *
 *  - `inspectApiKeyPepper` (SOLO LECTURA) — el gate `--check`: cuenta las keys VIVAS
 *    por pepper (huella) para responder «¿queda alguna key bajo el pepper que voy a
 *    retirar?». Se retira un pepper cuando `underRetired === 0` Y `unmarked === 0` Y
 *    `unknown === 0` (las keys dormidas que sigan bajo el viejo se revocan+re-emiten).
 *  - `backfillApiKeyPepperFp` — paso ÚNICO previo a la primera rotación: marca las
 *    filas v2 sin huella (creadas antes de la migración 0044) como bajo el pepper
 *    ACTUAL, para que el gate sea exacto desde el arranque.
 *
 * Corren con el pool ADMIN: `api_keys` tiene RLS por-tenant (como `webhook_endpoints`),
 * así que ningún rol no-superusuario ve/actualiza cross-tenant — el superusuario es la
 * opción honesta (igual que el barrido de webhooks; NO como el de MFA, donde `users`
 * es global y bastaba `fluvia_auth`).
 */

export interface ApiKeyPepperStatus {
  /** Keys VIVAS (no revocadas ni borradas) — las únicas que importan para el gate. */
  total: number;
  /** v2 bajo la huella del pepper ACTUAL. */
  underCurrent: number;
  /** v2 bajo la huella de un pepper RETIRADO (pendiente de re-hash perezoso o revocación). */
  underRetired: number;
  /** v2 sin huella (previas a 0044 / sin backfill) — ambiguas: correr backfill primero. */
  unmarked: number;
  /** v2 bajo una huella que NO está en el keyring (pepper olvidado en config): investigar. */
  unknown: number;
  /** v1 sha256 (sin pepper); migran al pepper actual al autenticar. No bloquean el retiro. */
  legacyV1: number;
  /** Ids de keys vivas v2 que NO están bajo el pepper actual (acotado a 500), para revocar. */
  stragglerIds: string[];
}

export async function inspectApiKeyPepper(
  adminPool: Pool,
  opts: { currentFp: string; retiredFps: string[]; tenantIds?: string[] }
): Promise<ApiKeyPepperStatus> {
  // `tenantIds` acota el conteo (opcional; el CLI corre global). NULL/vacío = todos.
  // Un `[]` se trata como «todos» (no como «ningún tenant») para que un scope vacío
  // jamás produzca un gate en «safe» falso (all-zero) — falla ABIERTO, no cerrado.
  const tenants = opts.tenantIds && opts.tenantIds.length > 0 ? opts.tenantIds : null;
  const c = await adminPool.query<{
    total: number;
    under_current: number;
    under_retired: number;
    unmarked: number;
    unknown: number;
    legacy_v1: number;
  }>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE key_hash_version = 2 AND key_hash_pepper_fp = $1)::int AS under_current,
       count(*) FILTER (WHERE key_hash_version = 2 AND key_hash_pepper_fp = ANY($2::text[]))::int AS under_retired,
       count(*) FILTER (WHERE key_hash_version = 2 AND key_hash_pepper_fp IS NULL)::int AS unmarked,
       count(*) FILTER (WHERE key_hash_version = 2 AND key_hash_pepper_fp IS NOT NULL
                          AND key_hash_pepper_fp <> $1
                          AND NOT (key_hash_pepper_fp = ANY($2::text[])))::int AS unknown,
       count(*) FILTER (WHERE key_hash_version = 1)::int AS legacy_v1
     FROM api_keys
     WHERE deleted_at IS NULL AND revoked_at IS NULL
       AND ($3::uuid[] IS NULL OR tenant_id = ANY($3::uuid[]))`,
    [opts.currentFp, opts.retiredFps, tenants]
  );
  const s = c.rows[0]!;
  const ids = await adminPool.query<{ id: string }>(
    `SELECT id FROM api_keys
     WHERE deleted_at IS NULL AND revoked_at IS NULL
       AND key_hash_version = 2
       AND (key_hash_pepper_fp IS NULL OR key_hash_pepper_fp <> $1)
       AND ($2::uuid[] IS NULL OR tenant_id = ANY($2::uuid[]))
     ORDER BY id LIMIT 500`,
    [opts.currentFp, tenants]
  );
  return {
    total: s.total,
    underCurrent: s.under_current,
    underRetired: s.under_retired,
    unmarked: s.unmarked,
    unknown: s.unknown,
    legacyV1: s.legacy_v1,
    stragglerIds: ids.rows.map((r) => r.id),
  };
}

/** Cotas por transacción (ms), espejo de los defaults de pool.ts (V2-R1). */
const STATEMENT_TIMEOUT_MS = '30000';
const LOCK_TIMEOUT_MS = '15000';
const IDLE_IN_TX_TIMEOUT_MS = '60000';
const DEFAULT_BATCH_SIZE = 500;

/**
 * Marca las filas v2 SIN huella como bajo el pepper ACTUAL. Idempotente. CORRECTO
 * SOLO antes de la primera rotación (cuando el pepper actual == el que produjo esas
 * filas). Por lotes por keyset con cotas de tiempo (los locks se sueltan entre lotes).
 */
export async function backfillApiKeyPepperFp(
  adminPool: Pool,
  currentFp: string,
  opts: { batchSize?: number; tenantIds?: string[] } = {}
): Promise<{ updated: number }> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  // `[]` = «todos» (no «ningún tenant»), como en inspect — un scope vacío no debe
  // convertir el backfill en un no-op silencioso.
  const tenants = opts.tenantIds && opts.tenantIds.length > 0 ? opts.tenantIds : null;
  let updated = 0;
  // Sin keyset: cada lote fija la huella en `batchSize` filas, que así DEJAN de
  // cumplir `fp IS NULL` — el conjunto candidato solo se encoge. `create()` nace
  // con huella y el re-hash perezoso también, así que no aparecen filas NULL nuevas.
  // Termina cuando un lote no actualiza nada.
  for (;;) {
    const client: PoolClient = await adminPool.connect();
    let n: number;
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('statement_timeout', $1, true),
                set_config('lock_timeout', $2, true),
                set_config('idle_in_transaction_session_timeout', $3, true)`,
        [STATEMENT_TIMEOUT_MS, LOCK_TIMEOUT_MS, IDLE_IN_TX_TIMEOUT_MS]
      );
      const res = await client.query(
        `UPDATE api_keys SET key_hash_pepper_fp = $1
         WHERE id IN (
           SELECT id FROM api_keys
           WHERE key_hash_version = 2 AND key_hash_pepper_fp IS NULL
             AND ($3::uuid[] IS NULL OR tenant_id = ANY($3::uuid[]))
           ORDER BY id LIMIT $2 FOR UPDATE
         )`,
        [currentFp, batchSize, tenants]
      );
      n = res.rowCount ?? 0;
      updated += n;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (n < batchSize) break;
  }
  return { updated };
}
