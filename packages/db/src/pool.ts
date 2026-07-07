import pg from 'pg';

export type { Pool, PoolClient } from 'pg';

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
}

/**
 * Cotas de tiempo por transacción (re-auditoría v2, hallazgo V2-R1). Sin ellas,
 * una query patológica, un lock no resuelto o un cliente que deja la tx abierta
 * mantiene una conexión del pool ocupada indefinidamente → agotamiento de pool y
 * cascading failure. Se aplican como SET LOCAL (mueren con el COMMIT/ROLLBACK).
 * Defaults conservadores; un caller con trabajo legítimamente largo (p. ej. una
 * conciliación batch) puede subirlos por transacción.
 */
export interface TxTimeouts {
  /** Máximo por sentencia (ms). Default 30 s. */
  statementTimeoutMs?: number;
  /** Máxima espera por un lock (ms). Default 15 s — holgado para la contención
   *  legítima de los tests de concurrencia, pero acota un hang real. */
  lockTimeoutMs?: number;
  /** Máximo idle DENTRO de una tx antes de abortarla (ms). Default 60 s. */
  idleInTxTimeoutMs?: number;
}

const DEFAULT_TX_TIMEOUTS: Required<TxTimeouts> = {
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 15_000,
  idleInTxTimeoutMs: 60_000,
};

/** ms → string entero no-negativo para set_config (0 = sin límite; lo evitamos). */
function ms(value: number, fallback: number): string {
  const n = Math.trunc(value);
  return String(Number.isFinite(n) && n > 0 ? n : fallback);
}

export function createPool(options: CreatePoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    // Fail fast: en fintech preferimos error explicito a requests colgados.
    connectionTimeoutMillis: 10_000,
  });
}

/**
 * Ejecuta `fn` dentro de una transaccion con el contexto de tenant inyectado
 * como variable local (SET LOCAL via set_config(..., is_local: true)).
 *
 * Este es el UNICO camino sancionado para tocar tablas con RLS desde la API:
 * el contexto muere en el COMMIT/ROLLBACK, por lo que una conexion del pool
 * jamas puede "filtrar" el tenant de un request anterior.
 */
export async function withTenantTransaction<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  timeouts: TxTimeouts = {}
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // V2-R1: contexto de tenant + cotas de tiempo, todo como SET LOCAL en una
    // ronda. `set_config(..., is_local=true)` es SET LOCAL parametrizable (sin
    // interpolar SQL). Los timeouts numéricos van como texto en ms.
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('statement_timeout', $2, true),
              set_config('lock_timeout', $3, true),
              set_config('idle_in_transaction_session_timeout', $4, true)`,
      [
        tenantId,
        ms(timeouts.statementTimeoutMs ?? NaN, DEFAULT_TX_TIMEOUTS.statementTimeoutMs),
        ms(timeouts.lockTimeoutMs ?? NaN, DEFAULT_TX_TIMEOUTS.lockTimeoutMs),
        ms(timeouts.idleInTxTimeoutMs ?? NaN, DEFAULT_TX_TIMEOUTS.idleInTxTimeoutMs),
      ]
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
