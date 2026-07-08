import type { Pool, PoolClient } from '@fluvia/db';
import { decryptMfaSecretWithKeyring, encryptMfaSecret, type MfaEncKeyring } from './totp.js';

/**
 * Re-cifrado de los secretos TOTP a la clave ACTUAL del keyring (F6, ADR-0012 —
 * pata de rotación de `MFA_SECRET_KEY`, mismo mecanismo que la clave de webhooks).
 * Paso del runbook `mfa-key-rotation.md`: tras poner la clave nueva como ACTUAL y
 * la vieja como RETIRADA (config), este barrido migra `users.totp_secret_enc` y
 * `users.totp_pending_secret_enc` de la retirada a la actual, para poder ELIMINAR
 * la retirada. El secreto TOTP en claro NO cambia (los códigos del usuario siguen
 * verificando igual) — solo su cifrado en reposo.
 *
 * Corre con el pool `fluvia_auth` (mínimo privilegio, NO superusuario): a diferencia
 * de `webhook_endpoints` (RLS por-tenant, que exige superusuario para cruzar tenants),
 * `users` es GLOBAL y `fluvia_auth` ya tiene `SELECT/UPDATE` + la política
 * `auth_plane_access USING(true)` (0004) sobre TODA la tabla — ve y actualiza cada
 * usuario en el servicio normal (login por email), así que RLS FORCE no es barrera y
 * no hace falta bypass. Los `*_timeout` son USERSET (no superuser-only). Discipline
 * (heredada de la revisión adversarial del barrido de webhooks):
 *  - LOTES por keyset (`id`), cada uno en su PROPIA transacción con cotas de tiempo
 *    (statement/lock/idle, SET LOCAL): los locks `FOR UPDATE` se sueltan entre
 *    lotes. Idempotente y reanudable.
 *  - RESILIENCIA por fila: un blob que NINGUNA clave del keyring descifra se REPORTA
 *    (`failed`/`failedIds`) y el barrido SIGUE, en vez de abortar por una fila.
 */

export interface ReencryptMfaSecretsResult {
  total: number;
  reencrypted: number;
  alreadyCurrent: number;
  /** Usuarios cuyo secreto TOTP no descifra NINGUNA clave del keyring: SIN migrar. */
  failed: number;
  /** Ids de esos usuarios — deben investigarse ANTES de retirar una clave. */
  failedIds: string[];
}

/** Foto de solo-lectura del estado de cifrado de los secretos TOTP frente a un keyring. */
export interface MfaSecretKeyStatus {
  total: number;
  underCurrent: number;
  underRetired: number;
  undecryptable: number;
  undecryptableIds: string[];
}

interface MfaSecretRow {
  id: string;
  totp_secret_enc: string | null;
  totp_pending_secret_enc: string | null;
}

// Nota: la condición «tiene algún secreto TOTP» va INLINE en cada literal SQL (no
// como fragmento interpolado `${…}`) — el candado estático de parametrización
// (sql-parameterization.test.ts) prohíbe componer SQL desde fragmentos, aunque sean
// constantes sin input de usuario. Solo `$1/$2/$3` (placeholders) parametrizan.

/** Filas por lote: acota el alcance/duración de los locks FOR UPDATE. Más pequeño
 *  que el barrido de webhooks (500) porque `users` está en el camino crítico del
 *  login (que hace `SELECT … FOR UPDATE` sobre su propia fila): un lote más chico
 *  acorta la espera de un login concurrente que caiga dentro del lote. */
const DEFAULT_BATCH_SIZE = 200;

/** Cotas por transacción (ms), espejo de los defaults de pool.ts (V2-R1). */
const STATEMENT_TIMEOUT_MS = '30000';
const LOCK_TIMEOUT_MS = '15000';
const IDLE_IN_TX_TIMEOUT_MS = '60000';

async function setTxTimeouts(client: PoolClient): Promise<void> {
  await client.query(
    `SELECT set_config('statement_timeout', $1, true),
            set_config('lock_timeout', $2, true),
            set_config('idle_in_transaction_session_timeout', $3, true)`,
    [STATEMENT_TIMEOUT_MS, LOCK_TIMEOUT_MS, IDLE_IN_TX_TIMEOUT_MS]
  );
}

/** Re-cifra un blob a la clave actual SOLO si está bajo una retirada; devuelve el nuevo blob o el mismo. */
function migrateBlob(
  keyring: MfaEncKeyring,
  enc: string | null
): { value: string | null; wasRetired: boolean } {
  if (enc === null) return { value: null, wasRetired: false };
  const dec = decryptMfaSecretWithKeyring(keyring, enc);
  if (dec.isCurrent) return { value: enc, wasRetired: false };
  return { value: encryptMfaSecret(keyring.current, dec.plaintext), wasRetired: true };
}

export async function reencryptMfaSecrets(
  authPool: Pool,
  keyring: MfaEncKeyring,
  opts: { userIds?: string[]; batchSize?: number } = {}
): Promise<ReencryptMfaSecretsResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const result: ReencryptMfaSecretsResult = {
    total: 0,
    reencrypted: 0,
    alreadyCurrent: 0,
    failed: 0,
    failedIds: [],
  };

  let afterId: string | null = null;
  for (;;) {
    const client = await authPool.connect();
    let batch: MfaSecretRow[];
    try {
      await client.query('BEGIN');
      await setTxTimeouts(client);
      const rows = await client.query<MfaSecretRow>(
        opts.userIds
          ? `SELECT id, totp_secret_enc, totp_pending_secret_enc FROM users
             WHERE id = ANY($1::uuid[])
               AND (totp_secret_enc IS NOT NULL OR totp_pending_secret_enc IS NOT NULL)
               AND ($2::uuid IS NULL OR id > $2::uuid)
             ORDER BY id LIMIT $3 FOR UPDATE`
          : `SELECT id, totp_secret_enc, totp_pending_secret_enc FROM users
             WHERE (totp_secret_enc IS NOT NULL OR totp_pending_secret_enc IS NOT NULL)
               AND ($1::uuid IS NULL OR id > $1::uuid)
             ORDER BY id LIMIT $2 FOR UPDATE`,
        opts.userIds ? [opts.userIds, afterId, batchSize] : [afterId, batchSize]
      );
      batch = rows.rows;
      for (const row of batch) {
        result.total += 1;
        let secret: { value: string | null; wasRetired: boolean };
        let pending: { value: string | null; wasRetired: boolean };
        try {
          secret = migrateBlob(keyring, row.totp_secret_enc);
          pending = migrateBlob(keyring, row.totp_pending_secret_enc);
        } catch {
          // Ninguna clave del keyring descifra este usuario (clave ausente /
          // dato corrupto): se reporta y se SIGUE (sin SQL fallido, la tx vive).
          result.failed += 1;
          result.failedIds.push(row.id);
          continue;
        }
        if (!secret.wasRetired && !pending.wasRetired) {
          result.alreadyCurrent += 1;
          continue;
        }
        await client.query(
          `UPDATE users SET totp_secret_enc = $2, totp_pending_secret_enc = $3 WHERE id = $1`,
          [row.id, secret.value, pending.value]
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
 * Prueba de vuelo de SOLO LECTURA: ¿bajo qué clave está cada secreto TOTP? Responde
 * la pregunta irreversible del runbook —«¿quedan blobs cifrados con la clave que voy
 * a ELIMINAR?»— SIN mutar ni tomar locks. Gate para retirar una clave:
 * `underRetired === 0` Y `undecryptable === 0`.
 */
export async function inspectMfaSecretKeys(
  pool: Pool,
  keyring: MfaEncKeyring,
  opts: { userIds?: string[] } = {}
): Promise<MfaSecretKeyStatus> {
  const rows = await pool.query<MfaSecretRow>(
    opts.userIds
      ? `SELECT id, totp_secret_enc, totp_pending_secret_enc FROM users
         WHERE id = ANY($1::uuid[])
           AND (totp_secret_enc IS NOT NULL OR totp_pending_secret_enc IS NOT NULL)`
      : `SELECT id, totp_secret_enc, totp_pending_secret_enc FROM users
         WHERE (totp_secret_enc IS NOT NULL OR totp_pending_secret_enc IS NOT NULL)`,
    opts.userIds ? [opts.userIds] : []
  );
  const status: MfaSecretKeyStatus = {
    total: 0,
    underCurrent: 0,
    underRetired: 0,
    undecryptable: 0,
    undecryptableIds: [],
  };
  // Clasifica un blob SIN re-cifrar (solo lectura): ¿está bajo una retirada?
  const underRetired = (enc: string | null): boolean =>
    enc !== null && !decryptMfaSecretWithKeyring(keyring, enc).isCurrent;
  for (const row of rows.rows) {
    status.total += 1;
    try {
      if (underRetired(row.totp_secret_enc) || underRetired(row.totp_pending_secret_enc))
        status.underRetired += 1;
      else status.underCurrent += 1;
    } catch {
      status.undecryptable += 1;
      status.undecryptableIds.push(row.id);
    }
  }
  return status;
}
