import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbUrlsFromEnv } from '../src/config.js';
import { defaultMigrationsDir, migrate } from '../src/migrate.js';
import { createPool, type Pool } from '../src/pool.js';

/**
 * AUD-P2-008 (F1-09): las migraciones que crean roles con password de
 * desarrollo deben FALLAR fuera de local/test cuando el rol no llega ya
 * aprovisionado con credenciales gestionadas.
 *
 * Los roles son cluster-wide y ya existen en la BD de test, así que el guard
 * real de 0002/0004/0009/0010 no puede dispararse aquí. Se prueba en dos
 * capas complementarias:
 *  1. END-TO-END: una BD efímera + una migración que usa EXACTAMENTE el mismo
 *     guard (fluvia_assert_dev_role_creation) sobre un rol inexistente —
 *     verifica el plumbing completo migrate()->GUC->guard en ambos sentidos.
 *  2. META-TEST estático: TODA migración del repo que haga CREATE ROLE ...
 *     PASSWORD invoca el guard justo antes (ninguna alta de rol sin guard).
 */

const GUARD_DB = `fluvia_guard_${Date.now()}`;
const PROBE_ROLE = 'fluvia_guard_probe';

let admin: Pool;
let guardPool: Pool;
let migrationsDir: string;

beforeAll(async () => {
  const urls = dbUrlsFromEnv();
  admin = createPool({ connectionString: urls.admin, max: 2 });
  await admin.query(`CREATE DATABASE ${GUARD_DB}`);
  guardPool = createPool({
    connectionString: urls.admin.replace(/\/[^/]+$/, `/${GUARD_DB}`),
    max: 2,
  });
  // El teardown hace DROP DATABASE ... WITH (FORCE): si algun socket del pool
  // efimero sigue drenando su cierre, el servidor lo termina primero (FATAL
  // 57P01) y pg lo emite como 'error' asincrono. Esperado e inofensivo aqui.
  guardPool.on('error', () => undefined);

  migrationsDir = mkdtempSync(join(tmpdir(), 'fluvia-guard-'));
  // La MISMA definición del guard que 0002 (extraída del archivo real para
  // que este test no pueda divergir de la migración de producción)…
  const real0002 = readFileSync(join(defaultMigrationsDir, '0002_enable_rls.sql'), 'utf8');
  const guardFn = real0002.match(
    /CREATE OR REPLACE FUNCTION fluvia_assert_dev_role_creation[\s\S]*?\$\$;/
  );
  if (!guardFn) throw new Error('guard function not found in 0002 — did it move?');
  // …aplicada al patrón exacto de alta de rol de las migraciones reales.
  writeFileSync(
    join(migrationsDir, '0001_role_probe.sql'),
    `${guardFn[0]}
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
    PERFORM fluvia_assert_dev_role_creation('${PROBE_ROLE}');
    CREATE ROLE ${PROBE_ROLE} NOLOGIN;
  END IF;
END;
$$;
`
  );
}, 30_000);

afterAll(async () => {
  await guardPool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${GUARD_DB} WITH (FORCE)`).catch(() => undefined);
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => undefined);
  await admin.end();
  rmSync(migrationsDir, { recursive: true, force: true });
});

describe('guard de aprovisionamiento de roles (AUD-P2-008)', () => {
  it('a role-creating migration FAILS LOUDLY in a non-local environment', async () => {
    await expect(migrate(guardPool, migrationsDir, { environment: 'production' })).rejects.toThrow(
      /FLUVIA_CONFIG.*managed credentials.*AUD-P2-008/s
    );
    // Nada quedó registrado ni creado.
    const rec = await guardPool.query(`SELECT count(*)::int AS n FROM schema_migrations`);
    expect((rec.rows[0] as { n: number }).n).toBe(0);
    const role = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [PROBE_ROLE]);
    expect(role.rowCount).toBe(0);
  });

  it('the SAME migration applies cleanly in local/test (dev passwords allowed)', async () => {
    const applied = await migrate(guardPool, migrationsDir, { environment: 'test' });
    expect(applied).toEqual(['0001_role_probe.sql']);
    const role = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [PROBE_ROLE]);
    expect(role.rowCount).toBe(1);
  });

  it('META: every CREATE ROLE ... PASSWORD in the repo invokes the guard first', () => {
    let creations = 0;
    let guarded = 0;
    for (const file of readdirSync(defaultMigrationsDir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(join(defaultMigrationsDir, file), 'utf8');
      creations += (sql.match(/CREATE ROLE\s+\w+\s+LOGIN PASSWORD/g) ?? []).length;
      guarded += (
        sql.match(/PERFORM fluvia_assert_dev_role_creation\('fluvia_\w+'\);\s*\n\s*CREATE ROLE/g) ??
        []
      ).length;
    }
    // 5 roles de runtime: app, worker, auth, relay, inbox — todos con guard.
    expect(creations).toBe(5);
    expect(guarded).toBe(5);
  });
});
