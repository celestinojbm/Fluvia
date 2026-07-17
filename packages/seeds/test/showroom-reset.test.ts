import { afterAll, describe, expect, it } from 'vitest';
import { createPool, dbUrlsFromEnv, type Pool } from '@fluvia/db';
import { serializeShowroomManifest } from '../src/manifest.js';
import { runShowroomReset, type ShowroomResetResult } from '../src/reset.js';
import { SHOWROOM_EXPECTED_BALANCES } from '../src/showroom.js';
import { MAINTENANCE_URL, ephemeralDbName, resetRequestFor } from './showroom-helpers.js';

/**
 * F6.5C3 — reset REAL contra una base efimera `fluvia_showroom_test_<id>`:
 * guard -> maintenance -> current_database() -> DROP/CREATE -> cierre de la
 * maintenance -> migrate -> seed por servicios -> invariantes [1]-[9] ->
 * manifiesto. DOS ciclos completos e independientes producen manifiestos
 * semanticos IDENTICOS; la base principal del job JAMAS se toca (todos los
 * dbnames usados quedan capturados y afirmados); cero pools abiertos al final.
 */

const DB = ephemeralDbName();
const REQ = resetRequestFor(DB);

interface TrackedPool {
  connectionString: string;
  pool: Pool;
}

function trackingFactory(track: TrackedPool[]) {
  return (opts: { connectionString: string; max?: number }): Pool => {
    const pool = createPool(opts);
    track.push({ connectionString: opts.connectionString, pool });
    return pool;
  };
}

const dbNameOf = (cs: string) => new URL(cs).pathname.slice(1);

afterAll(async () => {
  const maintenance = createPool({ connectionString: MAINTENANCE_URL, max: 1 });
  await maintenance.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await maintenance.end();
});

describe('demo:reset real (dos ciclos completos)', () => {
  it('dos ciclos reset->migrate->seed->invariantes producen manifiestos IDENTICOS sin tocar la base principal', async () => {
    const tracked1: TrackedPool[] = [];
    const phases1: string[] = [];
    const cycle1: ShowroomResetResult = await runShowroomReset(REQ, {
      createPool: trackingFactory(tracked1),
      onPhase: (p) => phases1.push(p),
    });

    const tracked2: TrackedPool[] = [];
    const cycle2: ShowroomResetResult = await runShowroomReset(REQ, {
      createPool: trackingFactory(tracked2),
    });

    // Ambos ciclos exitosos, con la secuencia completa y las invariantes verdes.
    expect(phases1).toEqual(['guard', 'drop-create', 'migrate', 'seed', 'invariants', 'manifest']);
    expect(cycle1.invariants).toBe('passed');
    expect(cycle2.invariants).toBe('passed');
    expect(cycle1.targetDbName).toBe(DB);

    // Determinismo SEMANTICO: manifiestos deep-equal y serializacion
    // byte-for-byte identica entre ciclos independientes.
    expect(cycle2.manifest).toEqual(cycle1.manifest);
    expect(serializeShowroomManifest(cycle2.manifest)).toBe(
      serializeShowroomManifest(cycle1.manifest)
    );
    expect(cycle1.manifest.balances).toEqual(SHOWROOM_EXPECTED_BALANCES);

    // TODOS los dbnames usados quedan afirmados: las conexiones target
    // apuntaron SOLO a la base efimera; la maintenance SOLO a postgres;
    // `fluvia` (base principal) jamas aparece.
    for (const tracked of [tracked1, tracked2]) {
      const names = tracked.map((t) => dbNameOf(t.connectionString));
      expect(new Set(names)).toEqual(new Set([DB, 'postgres']));
      const maintenanceUses = names.filter((n) => n === 'postgres');
      expect(maintenanceUses).toHaveLength(1); // una unica conexion de mantenimiento
      expect(names).not.toContain('fluvia');
      // Cero pools abiertos al terminar: el reset cierra TODO incluso la
      // maintenance (que jamas convive con migrate/seed).
      for (const t of tracked) {
        expect((t.pool as unknown as { ended: boolean }).ended).toBe(true);
      }
    }

    // La base principal del job quedo INTACTA: ni una fila showroom en ella
    // (la prueba estructural de "cero DROP/CREATE/migrate/seed contra la
    // principal" es la captura de dbnames de arriba — `fluvia` nunca se usa;
    // los conteos globales de la principal no se comparan porque otras
    // suites del paquete escriben en ella EN PARALELO por diseño).
    const main = createPool({ connectionString: dbUrlsFromEnv().admin, max: 1 });
    try {
      const org = await main.query(
        `SELECT 1 FROM organizations WHERE slug = 'showroom-fluvia' OR name = 'Showroom Fluvia'`
      );
      expect(org.rowCount).toBe(0);
      const users = await main.query(
        `SELECT 1 FROM users WHERE email LIKE '%@showroom.fluvia.test'`
      );
      expect(users.rowCount).toBe(0);
    } finally {
      await main.end();
    }
  }, 1_500_000);
});
