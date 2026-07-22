import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, dbUrlsFromEnv, type Pool } from '@fluvia/db';
import { ShowroomUnverifiedTargetError, verifyShowroomTarget } from '../src/live-identity.js';
import {
  ShowroomAlreadySeededError,
  ShowroomDatabaseMismatchError,
  seedShowroom,
  type ShowroomPhase,
  type ShowroomPools,
  type ShowroomSeedResult,
} from '../src/showroom.js';
import { MAINTENANCE_URL, TEST_PG_HOST, targetUrlsFor } from './showroom-helpers.js';

/**
 * F6.5C3 (revision pre-auditoria + RA-F65C3-EXT-001) — defensa LIVE contra la
 * base principal: `verifyShowroomTarget` (el UNICO productor del handle que
 * `seedShowroom` acepta) pregunta a la PROPIA base a donde apuntan de verdad
 * los cinco pools ANTES de mirar contenido. Pools hacia la base principal
 * `fluvia`, hacia una base arbitraria o hacia bases MEZCLADAS abortan con
 * ShowroomDatabaseMismatchError (distinto de ShowroomAlreadySeededError), sin
 * crear usuario/org/merchant/auditoria, sin imprimir credenciales, sin
 * receptor HTTP y sin espera del checkout. Y `seedShowroom` con un objeto de
 * pools PLANO (sin handle) rechaza en runtime sin tocar la base.
 *
 * El caso POSITIVO (base efimera autorizada => attestation + seed completo)
 * lo cubren showroom-seed.test.ts y showroom-cluster-identity.test.ts.
 */

/** Base efimera SIN nombre de showroom: el rechazo debe ser por DESTINO. */
const FOREIGN_DB = `fluvia_seedguard_foreign_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

let mainPools: ShowroomPools;
let foreignPools: ShowroomPools;
let maintenance: Pool;

function poolsFor(urls: ReturnType<typeof targetUrlsFor>): ShowroomPools {
  return {
    admin: createPool({ connectionString: urls.admin, max: 2 }),
    app: createPool({ connectionString: urls.app, max: 2 }),
    auth: createPool({ connectionString: urls.auth, max: 2 }),
    relay: createPool({ connectionString: urls.relay, max: 2 }),
    webhook: createPool({ connectionString: urls.webhook, max: 2 }),
  };
}

async function endPools(pools: ShowroomPools): Promise<void> {
  await Promise.all(Object.values(pools).map((p: Pool) => p.end()));
}

/** Marcadores showroom en una base: la evidencia de cero mutacion. */
async function showroomMarkers(pool: Pool): Promise<{ orgs: number; users: number }> {
  const orgs = await pool.query(
    `SELECT 1 FROM organizations WHERE name = 'Showroom Fluvia' OR slug = 'showroom-fluvia'`
  );
  const users = await pool.query(`SELECT 1 FROM users WHERE email LIKE '%@showroom.fluvia.test'`);
  return { orgs: orgs.rowCount ?? 0, users: users.rowCount ?? 0 };
}

/**
 * El destino ilegitimo se rechaza DOS veces: (1) la attestation live jamas
 * emite un handle; (2) seedShowroom con los pools planos (el unico camino
 * restante) rechaza el objeto sin marca runtime ANTES de tocar la base.
 */
async function expectLiveBlocked(pools: ShowroomPools): Promise<ShowroomDatabaseMismatchError> {
  let handle: unknown;
  let error: unknown;
  try {
    handle = await verifyShowroomTarget('test', pools);
  } catch (err) {
    error = err;
  }
  expect(handle).toBeUndefined();
  expect(error).toBeInstanceOf(ShowroomDatabaseMismatchError);
  expect(error).not.toBeInstanceOf(ShowroomAlreadySeededError);
  // El error jamas transporta credenciales sandbox.
  expect(String(error)).not.toMatch(/showroom-owner-sandbox|showroom-revisor-sandbox|fluvia_sk_/);

  // Sin handle no hay seed: el objeto plano se rechaza en runtime, sin fases,
  // sin receptor HTTP, sin espera del checkout, sin identidad creada.
  const phases: ShowroomPhase[] = [];
  let result: ShowroomSeedResult | undefined;
  let seedError: unknown;
  try {
    result = await seedShowroom('test', { pools, identity: undefined, plan: null } as never, {
      onPhase: (p) => phases.push(p),
    });
  } catch (err) {
    seedError = err;
  }
  expect(result).toBeUndefined();
  expect(seedError).toBeInstanceOf(ShowroomUnverifiedTargetError);
  expect(phases).toEqual([]);
  return error as ShowroomDatabaseMismatchError;
}

beforeAll(async () => {
  maintenance = createPool({ connectionString: MAINTENANCE_URL, max: 1 });
  // Reintento acotado: los OTROS archivos de esta suite preparan bases
  // efimeras EN PARALELO y dos CREATE DATABASE simultaneos chocan al copiar
  // template1 (mismo fenomeno serializado dentro de prepareShowroomDatabase).
  for (let attempt = 1; ; attempt++) {
    try {
      await maintenance.query(`CREATE DATABASE ${FOREIGN_DB}`);
      break;
    } catch (err) {
      if (attempt >= 10 || !/being accessed by other users/.test(String(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }

  // Pools hacia la base PRINCIPAL del job (los 7 roles reales existen en ella).
  const main = dbUrlsFromEnv();
  mainPools = poolsFor({
    admin: main.admin,
    app: main.app,
    auth: main.auth,
    relay: main.relay,
    webhook: main.webhook,
  });
  // Pools hacia una base arbitraria VACIA (sin migrar): la defensa corre antes
  // de tocar tabla alguna, asi que ni siquiera hace falta esquema.
  const foreignUrl = (role: string, pass: string) =>
    `postgres://${role}:${pass}@${TEST_PG_HOST}/${FOREIGN_DB}`;
  foreignPools = {
    admin: createPool({ connectionString: foreignUrl('postgres', 'postgres'), max: 2 }),
    app: createPool({ connectionString: foreignUrl('postgres', 'postgres'), max: 2 }),
    auth: createPool({ connectionString: foreignUrl('postgres', 'postgres'), max: 2 }),
    relay: createPool({ connectionString: foreignUrl('postgres', 'postgres'), max: 2 }),
    webhook: createPool({ connectionString: foreignUrl('postgres', 'postgres'), max: 2 }),
  };
}, 60_000);

afterAll(async () => {
  await endPools(mainPools);
  await endPools(foreignPools);
  await maintenance
    .query(`DROP DATABASE IF EXISTS ${FOREIGN_DB} WITH (FORCE)`)
    .catch(() => undefined);
  await maintenance.end();
});

describe('defensa live (attestation + handle) contra destinos ilegitimos', () => {
  it('TODOS los pools apuntando a la base principal `fluvia` => rechazo ANTES de mutar', async () => {
    const before = await showroomMarkers(mainPools.admin);
    expect(before).toEqual({ orgs: 0, users: 0 });

    const error = await expectLiveBlocked(mainPools);
    expect(error.message).toContain('"fluvia"');

    // Cero usuario/org/merchant/auditoria showroom en la principal (el filtro
    // de auditoria es por el MARCADOR showroom, no por tiempo: otras suites
    // escriben audits legitimos en la principal en paralelo).
    expect(await showroomMarkers(mainPools.admin)).toEqual({ orgs: 0, users: 0 });
    const audit = await mainPools.admin.query(
      `SELECT 1 FROM audit_events
       WHERE after_summary->>'slug' = 'showroom-fluvia'
          OR after_summary->>'name' = 'Showroom Fluvia'
       LIMIT 1`
    );
    expect(audit.rowCount).toBe(0);
  });

  it('UN pool apuntando a una base distinta del resto => rechazo (sin datos parciales)', async () => {
    const mixed: ShowroomPools = { ...foreignPools, app: mainPools.app };
    const error = await expectLiveBlocked(mixed);
    expect(error.message).toContain('DIFFERENT databases');
  });

  it('base ARBITRARIA (vacia, sin nombre showroom) => rechazo con cero objetos creados', async () => {
    const tablesBefore = await foreignPools.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace`
    );
    expect(Number(tablesBefore.rows[0]!.n)).toBe(0);

    const error = await expectLiveBlocked(foreignPools);
    expect(error.message).toContain(FOREIGN_DB);

    // La base ajena queda EXACTAMENTE como estaba: cero objetos.
    const tablesAfter = await foreignPools.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace`
    );
    expect(Number(tablesAfter.rows[0]!.n)).toBe(0);
  });
});
