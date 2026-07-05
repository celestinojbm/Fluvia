import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATION_LOCK_KEY = 727_270; // "FLUVIA" en el marcador de advisory lock

export const defaultMigrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations'
);

export interface MigrateOptions {
  /**
   * Entorno efectivo visto por las migraciones via el GUC fluvia.environment
   * (AUD-P2-008: fuera de local/test, las migraciones que crean roles FALLAN
   * si el rol no llega ya aprovisionado con credenciales gestionadas).
   * Default: FLUVIA_ENV, luego NODE_ENV, luego 'local'.
   */
  environment?: string;
}

/**
 * Runner de migraciones: aplica los .sql del directorio en orden lexicografico,
 * cada uno dentro de su propia transaccion, registrando en schema_migrations.
 * Un advisory lock global impide que dos procesos migren en paralelo.
 */
export async function migrate(
  pool: Pool,
  dir: string = defaultMigrationsDir,
  options: MigrateOptions = {}
): Promise<string[]> {
  const environment =
    options.environment ?? process.env.FLUVIA_ENV ?? process.env.NODE_ENV ?? 'local';
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query("SELECT set_config('fluvia.environment', $1, false)", [environment]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if ((done.rowCount ?? 0) > 0) continue;

      const sql = readFileSync(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return applied;
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}
