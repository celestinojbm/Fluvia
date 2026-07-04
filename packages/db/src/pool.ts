import pg from 'pg';

export type { Pool, PoolClient } from 'pg';

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
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
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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
