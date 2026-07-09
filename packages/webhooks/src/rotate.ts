import type { Pool, PoolClient } from '@fluvia/db';
import {
  decryptEndpointSecretWithKeyring,
  encryptEndpointSecret,
  type WebhookEncKeyring,
} from './crypto.js';

/**
 * Re-cifrado de los secretos de endpoint a la clave ACTUAL del keyring (F6,
 * ADR-0012 — pata de rotación de `WEBHOOK_SECRET_ENC_KEY`). Paso 2 de la
 * rotación sin downtime: tras poner la clave nueva como ACTUAL y la vieja como
 * RETIRADA (config), este barrido migra los blobs cifrados con la retirada a la
 * actual, para poder ELIMINAR la retirada. Runbook: webhook-enc-key-rotation.md.
 *
 * Corre con el pool ADMIN (superusuario: cruza tenants, salta RLS — la rotación
 * es una operación de plataforma, no de un tenant). El secreto en claro NO
 * cambia: solo su cifrado en reposo — las firmas hacia el comercio son idénticas.
 *
 * Discipline operativa (hallazgos de revisión):
 *  - LOTES por keyset (`id`), cada uno en su PROPIA transacción: los locks
 *    `FOR UPDATE` se sueltan al COMMIT de cada lote, así una escritura de gestión
 *    de endpoints (create/rotate/disable) espera a lo sumo UN lote, no el barrido
 *    entero. Reanudable e idempotente: un blob ya bajo la clave actual no se
 *    re-cifra; un lote que aborta no pierde el progreso ya commiteado.
 *  - COTAS DE TIEMPO por transacción (statement/lock/idle-in-tx, SET LOCAL) —
 *    las mismas que `withTenantTransaction` (pool.ts V2-R1); el camino crudo
 *    `pool.connect()` no las heredaba y podía colgar reteniendo locks.
 *  - RESILIENCIA por fila: un blob que NINGUNA clave del keyring descifra (clave
 *    ausente del keyring o dato corrupto) se REPORTA (`failed`/`failedIds`) y el
 *    barrido SIGUE, en vez de abortar toda la plataforma por una fila.
 */

export interface ReencryptWebhookSecretsResult {
  total: number;
  reencrypted: number;
  alreadyCurrent: number;
  /** Filas cuyo blob no descifra NINGUNA clave del keyring: quedan SIN migrar. */
  failed: number;
  /** Ids de esas filas — deben investigarse ANTES de retirar una clave. */
  failedIds: string[];
}

interface EndpointSecretRow {
  id: string;
  secret_enc: string;
  prev_secret_enc: string | null;
}

/** Foto de solo-lectura del estado de cifrado de los secretos frente a un keyring. */
export interface WebhookSecretKeyStatus {
  total: number;
  /** Ambos blobs (secret + prev) ya bajo la clave ACTUAL. */
  underCurrent: number;
  /** Algún blob todavía bajo una clave RETIRADA (pendiente de re-cifrar). */
  underRetired: number;
  /** Ningún key del keyring lo descifra (clave ausente / dato corrupto). */
  undecryptable: number;
  undecryptableIds: string[];
}

/** Filas por lote: acota el alcance/duración de los locks FOR UPDATE en la tabla. */
const DEFAULT_BATCH_SIZE = 500;

/** Cotas por transacción (ms), espejo de los defaults de pool.ts (V2-R1). */
const STATEMENT_TIMEOUT_MS = '30000';
const LOCK_TIMEOUT_MS = '15000';
const IDLE_IN_TX_TIMEOUT_MS = '60000';

/** Aplica las cotas de tiempo como SET LOCAL (mueren con el COMMIT/ROLLBACK). */
async function setTxTimeouts(client: PoolClient): Promise<void> {
  await client.query(
    `SELECT set_config('statement_timeout', $1, true),
            set_config('lock_timeout', $2, true),
            set_config('idle_in_transaction_session_timeout', $3, true)`,
    [STATEMENT_TIMEOUT_MS, LOCK_TIMEOUT_MS, IDLE_IN_TX_TIMEOUT_MS]
  );
}

export async function reencryptWebhookSecrets(
  adminPool: Pool,
  keyring: WebhookEncKeyring,
  opts: { tenantIds?: string[]; batchSize?: number } = {}
): Promise<ReencryptWebhookSecretsResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const result: ReencryptWebhookSecretsResult = {
    total: 0,
    reencrypted: 0,
    alreadyCurrent: 0,
    failed: 0,
    failedIds: [],
  };

  // Keyset por `id` (uuid tiene orden total): cada lote lee/bloquea SOLO su
  // ventana. Filas insertadas tras arrancar el barrido ya nacen bajo la clave
  // ACTUAL (el servicio de endpoints cifra con la actual), así que no migrarlas
  // en esta corrida es correcto e idempotente.
  let afterId: string | null = null;
  for (;;) {
    const client = await adminPool.connect();
    let batch: EndpointSecretRow[];
    try {
      await client.query('BEGIN');
      await setTxTimeouts(client);
      const rows = await client.query<EndpointSecretRow>(
        opts.tenantIds
          ? `SELECT id, secret_enc, prev_secret_enc FROM webhook_endpoints
             WHERE tenant_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR id > $2::uuid)
             ORDER BY id LIMIT $3 FOR UPDATE`
          : `SELECT id, secret_enc, prev_secret_enc FROM webhook_endpoints
             WHERE ($1::uuid IS NULL OR id > $1::uuid)
             ORDER BY id LIMIT $2 FOR UPDATE`,
        opts.tenantIds ? [opts.tenantIds, afterId, batchSize] : [afterId, batchSize]
      );
      batch = rows.rows;
      for (const row of batch) {
        result.total += 1;
        let cur: { plaintext: string; isCurrent: boolean };
        let prev: { plaintext: string; isCurrent: boolean } | null;
        try {
          cur = decryptEndpointSecretWithKeyring(keyring, row.secret_enc);
          prev =
            row.prev_secret_enc === null
              ? null
              : decryptEndpointSecretWithKeyring(keyring, row.prev_secret_enc);
        } catch {
          // Ninguna clave del keyring descifra este blob (clave ausente / dato
          // corrupto): se reporta y se SIGUE (sin SQL fallido, la tx sigue viva).
          result.failed += 1;
          result.failedIds.push(row.id);
          continue;
        }
        // Re-cifrar la fila SOLO si algún blob está bajo una clave retirada.
        if (cur.isCurrent && (prev === null || prev.isCurrent)) {
          result.alreadyCurrent += 1;
          continue;
        }
        await client.query(
          `UPDATE webhook_endpoints
           SET secret_enc = $2,
               prev_secret_enc = $3,
               updated_at = now()
           WHERE id = $1`,
          [
            row.id,
            encryptEndpointSecret(keyring.current, cur.plaintext),
            prev === null ? null : encryptEndpointSecret(keyring.current, prev.plaintext),
          ]
        );
        result.reencrypted += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (batch.length < batchSize) break;
    afterId = batch[batch.length - 1]!.id;
  }
  return result;
}

/**
 * Prueba de vuelo de SOLO LECTURA: ¿bajo qué clave del keyring está cada secreto?
 * Responde la pregunta irreversible del runbook —«¿quedan blobs cifrados con la
 * clave que voy a ELIMINAR?»— SIN mutar ni tomar locks `FOR UPDATE` (un simple
 * SELECT). El gate para retirar una clave es `underRetired === 0` (nada que
 * migrar) Y `undecryptable === 0` (ningún blob bajo una clave fuera del keyring
 * que haya que investigar antes). Complementa al barrido (cuya prueba es
 * `reencrypted === 0`) con un chequeo que no reescribe nada.
 */
export async function inspectWebhookSecretKeys(
  pool: Pool,
  keyring: WebhookEncKeyring,
  opts: { tenantIds?: string[] } = {}
): Promise<WebhookSecretKeyStatus> {
  const rows = await pool.query<EndpointSecretRow>(
    opts.tenantIds
      ? `SELECT id, secret_enc, prev_secret_enc FROM webhook_endpoints
         WHERE tenant_id = ANY($1::uuid[])`
      : `SELECT id, secret_enc, prev_secret_enc FROM webhook_endpoints`,
    opts.tenantIds ? [opts.tenantIds] : []
  );
  const status: WebhookSecretKeyStatus = {
    total: 0,
    underCurrent: 0,
    underRetired: 0,
    undecryptable: 0,
    undecryptableIds: [],
  };
  for (const row of rows.rows) {
    status.total += 1;
    try {
      const cur = decryptEndpointSecretWithKeyring(keyring, row.secret_enc);
      const prev =
        row.prev_secret_enc === null
          ? null
          : decryptEndpointSecretWithKeyring(keyring, row.prev_secret_enc);
      if (cur.isCurrent && (prev === null || prev.isCurrent)) status.underCurrent += 1;
      else status.underRetired += 1;
    } catch {
      status.undecryptable += 1;
      status.undecryptableIds.push(row.id);
    }
  }
  return status;
}
