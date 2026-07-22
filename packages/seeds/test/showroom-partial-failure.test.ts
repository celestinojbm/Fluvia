import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, type Pool } from '@fluvia/db';

/**
 * F6.5C3 — fallo PARCIAL inyectado en un punto posterior a varias creaciones
 * (la creacion de la API key, tras identidad/pagos/dinero/conciliacion):
 *
 *  - el seed FALLA sin declarar exito y sin producir credenciales;
 *  - NO intenta reanudar automaticamente;
 *  - una segunda llamada directa a seedShowroom falla CLOSED (base no vacia)
 *    con CERO mutaciones adicionales;
 *  - demo:reset reconstruye correctamente desde cero.
 *
 * Patron de inyeccion ACEPTADO en el repo (onboarding-audit-rollback.test.ts /
 * register-sandbox-audit-rollback): `vi.mock` por-modulo-de-test que envuelve
 * el simbolo real y lanza SOLO cuando el test lo pide — sin hooks mutables de
 * produccion. Archivo separado para no contaminar las demas suites.
 */

const failure = vi.hoisted(() => ({ enabled: false }));

vi.mock('@fluvia/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluvia/identity')>();
  class FailingApiKeyService extends actual.ApiKeyService {
    override create(
      ...args: Parameters<InstanceType<typeof actual.ApiKeyService>['create']>
    ): ReturnType<InstanceType<typeof actual.ApiKeyService>['create']> {
      if (failure.enabled) {
        throw new Error('injected api-key failure (showroom partial run)');
      }
      return super.create(...args);
    }
  }
  return { ...actual, ApiKeyService: FailingApiKeyService };
});

// Import DESPUES del mock: seedShowroom debe resolver la clase interceptada.
const { seedShowroom, ShowroomAlreadySeededError } = await import('../src/showroom.js');
const { verifyShowroomTarget } = await import('../src/live-identity.js');
const { prepareShowroomDatabase, runShowroomReset } = await import('../src/reset.js');
const { MAINTENANCE_URL, ephemeralDbName, resetRequestFor, snapshotCounts } =
  await import('./showroom-helpers.js');
type ShowroomPools = import('../src/showroom.js').ShowroomPools;
type VerifiedShowroomTarget = import('../src/live-identity.js').VerifiedShowroomTarget;

const DB = ephemeralDbName();
const REQ = resetRequestFor(DB);

let pools: ShowroomPools;
let target: VerifiedShowroomTarget;

beforeAll(async () => {
  await prepareShowroomDatabase(REQ);
  pools = {
    admin: createPool({ connectionString: REQ.targetUrls.admin, max: 4 }),
    app: createPool({ connectionString: REQ.targetUrls.app, max: 8 }),
    auth: createPool({ connectionString: REQ.targetUrls.auth, max: 2 }),
    relay: createPool({ connectionString: REQ.targetUrls.relay, max: 2 }),
    webhook: createPool({ connectionString: REQ.targetUrls.webhook, max: 2 }),
  };
  target = await verifyShowroomTarget('test', pools);
}, 120_000);

afterAll(async () => {
  await Promise.all(Object.values(pools).map((p: Pool) => p.end()));
  const maintenance = createPool({ connectionString: MAINTENANCE_URL, max: 1 });
  await maintenance.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await maintenance.end();
});

describe('fallo parcial del seed y reconstruccion por demo:reset', () => {
  it('un fallo tras varias creaciones deja el seed FALLIDO, sin credenciales y sin reanudacion', async () => {
    failure.enabled = true;
    const phases: string[] = [];
    let result: unknown;
    let error: unknown;
    try {
      result = await seedShowroom('test', target, { onPhase: (p) => phases.push(p) });
    } catch (err) {
      error = err;
    } finally {
      failure.enabled = false;
    }

    // Fallo real, sin exito declarado y sin material sandbox producido.
    expect(result).toBeUndefined();
    expect(String(error)).toMatch(/injected api-key failure/);
    expect(String(error)).not.toMatch(/fluvia_sk_|showroom-owner-sandbox|showroom-revisor-sandbox/);

    // El fallo ocurrio DESPUES de varias creaciones (corrida parcial real)…
    expect(phases).toContain('reconciliation');
    expect(phases).toContain('api-key');
    // …y ANTES de completar: ni API key ni webhooks llegaron a existir.
    const keys = await pools.admin.query(`SELECT 1 FROM api_keys`);
    expect(keys.rowCount).toBe(0);
    const endpoints = await pools.admin.query(`SELECT 1 FROM webhook_endpoints`);
    expect(endpoints.rowCount).toBe(0);
    // La corrida parcial dejo rastro (org creada): no hubo rollback magico
    // cross-service NI compensaciones inventadas.
    const org = await pools.admin.query(
      `SELECT 1 FROM organizations WHERE name = 'Showroom Fluvia'`
    );
    expect(org.rowCount).toBe(1);
  }, 480_000);

  it('una segunda llamada directa a seedShowroom falla CLOSED con cero mutaciones', async () => {
    const before = await snapshotCounts(pools.admin);
    await expect(seedShowroom('test', target)).rejects.toBeInstanceOf(ShowroomAlreadySeededError);
    const after = await snapshotCounts(pools.admin);
    expect(after).toEqual(before);
  });

  it('demo:reset reconstruye desde cero: la base dedicada termina COMPLETA y verificada', async () => {
    const result = await runShowroomReset(REQ);
    expect(result.invariants).toBe('passed');
    expect(result.manifest.webhooks.events).toEqual({ delivered: 1, dead: 1, pending: 0 });
    expect(result.manifest.apiKeys).toEqual([
      { label: 'showroom-integration', environment: 'test', scopes: ['read'], revoked: false },
    ]);
    // La reconstruccion NO conserva rastros de la corrida parcial: la
    // auditoria y las entidades son exactamente las de una corrida limpia.
    expect(result.manifest.audit['user.registered']).toBe(2);
    expect(result.manifest.reconciliation.cases).toEqual({
      open: 1,
      acknowledged: 1,
      resolved: 1,
    });
  }, 900_000);
});
