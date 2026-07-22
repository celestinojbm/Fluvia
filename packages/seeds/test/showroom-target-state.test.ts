import { describe, expect, it } from 'vitest';
import { createPool, type Pool } from '@fluvia/db';
import { openVerifiedShowroomTarget } from '../src/reset.js';
import {
  ShowroomUnverifiedTargetError,
  observeShowroomLiveIdentity,
  reattestVerifiedShowroomTarget,
  verifyShowroomTarget,
} from '../src/live-identity.js';
import {
  ShowroomAlreadySeededError,
  ShowroomDatabaseMismatchError,
  seedShowroom,
  type ShowroomPools,
} from '../src/showroom.js';

/**
 * Delta RA-F65C3-EXT-001 — estado verificado PRIVADO e INMUTABLE:
 *
 *  - `verifyShowroomTarget` copia el mapping de pools en un SNAPSHOT nuevo y
 *    congelado; mutar el objeto ORIGINAL despues de crear el handle (incluso
 *    en una microtask) NO cambia el target: la re-attestation y todos los
 *    servicios usan exclusivamente el snapshot privado.
 *  - El handle publico es OPACO (sin pools/identidad/plan/Symbol/accessor).
 *  - El accessor interno no se reexporta en el index del paquete.
 *  - La evidencia del system_identifier es DISCRIMINADA (`complete`/`partial`/
 *    `none`) y las transiciones entre attestation y re-attestation son
 *    fail-closed (X->Y, X->none, none->X y perdida de roles observadores
 *    rechazan; partial->complete con el mismo X acepta).
 *
 * Pools FALSOS deterministas (el escenario multi-cluster REAL vive en
 * showroom-cluster-identity.test.ts).
 */

const DB = 'fluvia_showroom_test_state1';
const ROLES = ['admin', 'app', 'auth', 'relay', 'webhook'] as const;
type Role = (typeof ROLES)[number];

interface FakePoolBehavior {
  /** valor observado de system_identifier; '42501' simula permiso denegado;
   *  una instancia de Error se lanza tal cual. */
  cluster: string | Error;
  db?: string;
  addr?: string;
  port?: string;
  pm?: string;
}

interface FakePool {
  behavior: FakePoolBehavior;
  queries: string[];
  endCalls: number;
  query: (sql: string) => Promise<{ rows: unknown[]; rowCount?: number }>;
  end: () => Promise<void>;
}

function denied(): Error {
  return Object.assign(new Error('permission denied for function pg_control_system'), {
    code: '42501',
  });
}

function fakePool(behavior: FakePoolBehavior): FakePool {
  const pool: FakePool = {
    behavior,
    queries: [],
    endCalls: 0,
    query: async (sql: string) => {
      pool.queries.push(sql);
      if (sql.includes('pg_control_system')) {
        const c = pool.behavior.cluster;
        if (c instanceof Error) throw c;
        if (c === '42501') throw denied();
        return { rows: [{ cluster_identifier: c }] };
      }
      if (sql.includes('current_database')) {
        return {
          rows: [
            {
              database: pool.behavior.db ?? DB,
              server_address: pool.behavior.addr ?? '127.0.0.1',
              server_port: pool.behavior.port ?? '5432',
              postmaster_started_at: pool.behavior.pm ?? '2026-07-19 00:00:00.000000+00',
            },
          ],
        };
      }
      // Cualquier otra query (p. ej. assertShowroomEmpty) la decide el test.
      if (sql.includes('FROM organizations')) {
        return { rows: [{ ok: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    end: async () => {
      pool.endCalls += 1;
    },
  };
  return pool;
}

const X = '7100000000000000001';
const Y = '7100000000000000999';

function poolSet(clusters: readonly (string | Error)[]): {
  mapping: ShowroomPools;
  fakes: Record<Role, FakePool>;
} {
  const fakes = {
    admin: fakePool({ cluster: clusters[0]! }),
    app: fakePool({ cluster: clusters[1]! }),
    auth: fakePool({ cluster: clusters[2]! }),
    relay: fakePool({ cluster: clusters[3]! }),
    webhook: fakePool({ cluster: clusters[4]! }),
  };
  const mapping = { ...fakes } as unknown as ShowroomPools;
  return { mapping, fakes };
}

function evilPool(): FakePool {
  const pool = fakePool({ cluster: X });
  pool.query = async (sql: string) => {
    pool.queries.push(sql);
    throw new Error('EVIL pool must never be used by the verified target');
  };
  return pool;
}

describe('snapshot privado e inmutable del mapping de pools', () => {
  it.each(ROLES)(
    'reemplazar "%s" en el mapping ORIGINAL despues del handle no cambia el target',
    async (role) => {
      const { mapping, fakes } = poolSet([X, X, X, X, X]);
      const target = await verifyShowroomTarget('test', mapping);

      const evil = evilPool();
      (mapping as unknown as Record<Role, unknown>)[role] = evil;

      // La re-attestation usa el snapshot: los pools ORIGINALES responden y el
      // pool malicioso jamas recibe una query.
      await expect(reattestVerifiedShowroomTarget(target)).resolves.toBeUndefined();
      expect(evil.queries).toHaveLength(0);
      expect(fakes[role].queries.length).toBeGreaterThan(0);
    }
  );

  it('mutacion programada en MICROTASK tras crear el handle: ningun servicio usa el mapping mutado', async () => {
    const { mapping, fakes } = poolSet([X, X, X, X, X]);
    const target = await verifyShowroomTarget('test', mapping);

    const evils = ROLES.map(() => evilPool());
    queueMicrotask(() => {
      for (const [i, role] of ROLES.entries()) {
        (mapping as unknown as Record<Role, unknown>)[role] = evils[i]!;
      }
    });
    await Promise.resolve(); // la microtask ya corrio: el mapping esta mutado

    // seedShowroom entra por el accessor privado: re-atestigua sobre el
    // snapshot y su primera lectura de preflight (assertShowroomEmpty) va al
    // admin del SNAPSHOT (aqui scriptado como "ya sembrado" para abortar de
    // forma controlada tras demostrar el punto).
    await expect(seedShowroom('test', target)).rejects.toBeInstanceOf(ShowroomAlreadySeededError);
    for (const evil of evils) expect(evil.queries).toHaveLength(0);
    expect(fakes.admin.queries.some((sql) => sql.includes('FROM organizations'))).toBe(true);
  });

  it('el handle publico es OPACO: sin pools, sin identidad, sin plan, congelado', async () => {
    const { mapping } = poolSet([X, X, X, X, X]);
    const target = await verifyShowroomTarget('test', mapping);
    expect(target).toEqual({ kind: 'verified-showroom-target' });
    expect(Object.keys(target)).toEqual(['kind']);
    expect(Object.getOwnPropertySymbols(target)).toEqual([]); // ni Symbol expuesto
    const record = target as unknown as Record<string, unknown>;
    expect(record.pools).toBeUndefined();
    expect(record.identity).toBeUndefined();
    expect(record.plan).toBeUndefined();
    expect(Object.isFrozen(target)).toBe(true);
  });

  it('el accessor interno NO se reexporta en el index del paquete', async () => {
    const index = (await import('../src/index.js')) as Record<string, unknown>;
    expect('getVerifiedShowroomTargetState' in index).toBe(false);
    expect(Object.keys(index).filter((k) => /VerifiedShowroomTargetState/.test(k))).toEqual([]);
  });

  it('copias, fakes y Object.create siguen rechazandose', async () => {
    const { mapping } = poolSet([X, X, X, X, X]);
    const genuine = await verifyShowroomTarget('test', mapping);
    const forged: unknown[] = [
      { ...genuine },
      Object.create(genuine as object),
      { kind: 'verified-showroom-target' },
      { pools: mapping },
      null,
      'handle',
    ];
    for (const attempt of forged) {
      await expect(seedShowroom('test', attempt as never)).rejects.toBeInstanceOf(
        ShowroomUnverifiedTargetError
      );
    }
  });
});

describe('evidencia DISCRIMINADA del cluster identifier', () => {
  it('attestation parcial X/X/42501/42501/42501 => partial con roles observadores exactos', async () => {
    const { mapping } = poolSet([X, X, '42501', '42501', '42501']);
    const identity = await observeShowroomLiveIdentity(mapping);
    expect(identity.clusterEvidence).toEqual({
      mode: 'partial',
      value: X,
      observingRoles: ['admin', 'app'],
    });
  });

  it('none SOLO si los cinco reciben exactamente 42501; complete si los cinco observan', async () => {
    const none = await observeShowroomLiveIdentity(
      poolSet(['42501', '42501', '42501', '42501', '42501']).mapping
    );
    expect(none.clusterEvidence).toEqual({ mode: 'none', observingRoles: [] });

    const complete = await observeShowroomLiveIdentity(poolSet([X, X, X, X, X]).mapping);
    expect(complete.clusterEvidence.mode).toBe('complete');
  });

  it('identifiers observados DISTINTOS abortan; formato invalido aborta; error != 42501 aborta', async () => {
    await expect(
      observeShowroomLiveIdentity(poolSet([X, Y, '42501', '42501', '42501']).mapping)
    ).rejects.toBeInstanceOf(ShowroomDatabaseMismatchError);

    await expect(
      observeShowroomLiveIdentity(poolSet(['not-a-number', X, X, X, X]).mapping)
    ).rejects.toBeInstanceOf(ShowroomDatabaseMismatchError);

    const auth = Object.assign(new Error('connection reset'), { code: '08006' });
    await expect(
      observeShowroomLiveIdentity(poolSet([X, X, auth, X, X]).mapping)
    ).rejects.toBeInstanceOf(ShowroomDatabaseMismatchError);
  });

  it('re-attestation parcial con el MISMO X: aceptada (mismos roles observadores)', async () => {
    const { mapping } = poolSet([X, X, '42501', '42501', '42501']);
    const target = await verifyShowroomTarget('test', mapping);
    await expect(reattestVerifiedShowroomTarget(target)).resolves.toBeUndefined();
  });

  it('re-attestation con Y: rechazada', async () => {
    const { mapping, fakes } = poolSet([X, X, '42501', '42501', '42501']);
    const target = await verifyShowroomTarget('test', mapping);
    fakes.admin.behavior.cluster = Y;
    fakes.app.behavior.cluster = Y;
    await expect(reattestVerifiedShowroomTarget(target)).rejects.toThrow(/clusterIdentifier/);
  });

  it('inicial parcial X y posterior none: rechazada (observabilidad perdida)', async () => {
    const { mapping, fakes } = poolSet([X, X, '42501', '42501', '42501']);
    const target = await verifyShowroomTarget('test', mapping);
    fakes.admin.behavior.cluster = '42501';
    fakes.app.behavior.cluster = '42501';
    await expect(reattestVerifiedShowroomTarget(target)).rejects.toThrow(/observability lost/);
  });

  it('inicial none y posterior parcial X: rechazada fail-closed (sin transicion autenticada)', async () => {
    const { mapping, fakes } = poolSet(['42501', '42501', '42501', '42501', '42501']);
    const target = await verifyShowroomTarget('test', mapping);
    fakes.admin.behavior.cluster = X;
    await expect(reattestVerifiedShowroomTarget(target)).rejects.toThrow(/none->observed/);
  });

  it('cambio del conjunto de roles observadores: perder un rol rechaza; ganar (partial->complete) acepta', async () => {
    // Perdida: admin+app observaban; app deja de observar.
    const lost = poolSet([X, X, '42501', '42501', '42501']);
    const lostTarget = await verifyShowroomTarget('test', lost.mapping);
    lost.fakes.app.behavior.cluster = '42501';
    await expect(reattestVerifiedShowroomTarget(lostTarget)).rejects.toThrow(
      /observing roles lost: app/
    );

    // Ganancia con el MISMO X: partial -> complete es valido.
    const gain = poolSet([X, X, '42501', '42501', '42501']);
    const gainTarget = await verifyShowroomTarget('test', gain.mapping);
    gain.fakes.auth.behavior.cluster = X;
    gain.fakes.relay.behavior.cluster = X;
    gain.fakes.webhook.behavior.cluster = X;
    await expect(reattestVerifiedShowroomTarget(gainTarget)).resolves.toBeUndefined();
  });

  it('none -> none: aceptada (el modo se conserva)', async () => {
    const { mapping } = poolSet(['42501', '42501', '42501', '42501', '42501']);
    const target = await verifyShowroomTarget('test', mapping);
    await expect(reattestVerifiedShowroomTarget(target)).resolves.toBeUndefined();
  });

  it('ante rechazo TOCTOU: cero fases posteriores, cero receptor, cero secretos', async () => {
    const { mapping, fakes } = poolSet([X, X, X, X, X]);
    const target = await verifyShowroomTarget('test', mapping);
    fakes.admin.behavior.cluster = Y;
    fakes.app.behavior.cluster = Y;
    fakes.auth.behavior.cluster = Y;
    fakes.relay.behavior.cluster = Y;
    fakes.webhook.behavior.cluster = Y;

    const phases: string[] = [];
    let error: unknown;
    try {
      await seedShowroom('test', target, { onPhase: (p) => phases.push(p) });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ShowroomDatabaseMismatchError);
    // Solo 'preflight': el receptor HTTP (fase webhooks) y la espera del TTL
    // (fase await-expiry) jamas llegan a existir.
    expect(phases).toEqual(['preflight']);
    expect(String(error)).not.toMatch(/showroom-owner-sandbox|fluvia_sk_|postgres:\/\//);
    // Ninguna lectura de contenido llego a ocurrir (solo identidad).
    expect(fakes.admin.queries.some((sql) => sql.includes('FROM organizations'))).toBe(false);
  });
});

/**
 * Delta 3 (EXT-001) — TODOS los usos posteriores a la attestation proceden
 * del estado privado; el mapping original se lee UNA sola vez por rol y puede
 * descartarse. `openVerifiedShowroomTarget` cierra desde el snapshot.
 */
describe('delta 3: lectura unica del mapping y cierre desde el snapshot', () => {
  it('getter del mapping: EXACTAMENTE una lectura por rol y ningun uso posterior', async () => {
    const { fakes } = poolSet([X, X, X, X, X]);
    const reads: Record<string, number> = {};
    const mapping = {} as ShowroomPools;
    for (const role of ROLES) {
      reads[role] = 0;
      Object.defineProperty(mapping, role, {
        get() {
          reads[role]! += 1;
          return fakes[role];
        },
        enumerable: true,
        configurable: true,
      });
    }
    const target = await verifyShowroomTarget('test', mapping);
    expect(reads).toEqual({ admin: 1, app: 1, auth: 1, relay: 1, webhook: 1 });

    // Re-attestation y seed (aborta en AlreadySeeded consultando el snapshot):
    // CERO lecturas adicionales del mapping original.
    await reattestVerifiedShowroomTarget(target);
    await expect(seedShowroom('test', target, {})).rejects.toBeInstanceOf(
      ShowroomAlreadySeededError
    );
    expect(reads).toEqual({ admin: 1, app: 1, auth: 1, relay: 1, webhook: 1 });
  });

  it('getter que devuelve valores DISTINTOS en lecturas sucesivas: solo la primera cuenta', async () => {
    const { fakes } = poolSet([X, X, X, X, X]);
    const hostile = evilPool();
    let adminReads = 0;
    const mapping = {
      app: fakes.app,
      auth: fakes.auth,
      relay: fakes.relay,
      webhook: fakes.webhook,
    } as unknown as ShowroomPools;
    Object.defineProperty(mapping, 'admin', {
      get() {
        adminReads += 1;
        // La SEGUNDA lectura devolveria un pool hostil: no debe ocurrir jamas.
        return adminReads === 1 ? fakes.admin : hostile;
      },
      enumerable: true,
      configurable: true,
    });
    const target = await verifyShowroomTarget('test', mapping);
    await reattestVerifiedShowroomTarget(target);
    await expect(seedShowroom('test', target, {})).rejects.toBeInstanceOf(
      ShowroomAlreadySeededError
    );
    expect(adminReads).toBe(1);
    expect(hostile.queries).toHaveLength(0);
    // El admin del snapshot recibio identidad (x2 attestations extra) y preflight.
    expect(fakes.admin.queries.some((sql) => sql.includes('FROM organizations'))).toBe(true);
  });

  it('openVerifiedShowroomTarget: close() cierra los CINCO pools del SNAPSHOT exactamente una vez', async () => {
    const { fakes } = poolSet([X, X, X, X, X]);
    const byUser: Record<string, FakePool> = {
      postgres: fakes.admin,
      fluvia_app: fakes.app,
      fluvia_auth: fakes.auth,
      fluvia_relay: fakes.relay,
      fluvia_webhook: fakes.webhook,
    };
    const db = 'fluvia_showroom_test_snapclose';
    for (const role of ROLES) fakes[role].behavior.db = db;
    const factory = ((opts: { connectionString: string }) => {
      const user = new URL(opts.connectionString).username;
      return byUser[user] as unknown as Pool;
    }) as unknown as typeof createPool;
    const url = (user: string, pw: string) => `postgres://${user}:${pw}@127.0.0.1:5432/${db}`;
    const opened = await openVerifiedShowroomTarget(
      'test',
      {
        admin: url('postgres', 'postgres'),
        app: url('fluvia_app', 'x'),
        auth: url('fluvia_auth', 'x'),
        relay: url('fluvia_relay', 'x'),
        webhook: url('fluvia_webhook', 'x'),
      },
      factory
    );
    expect(opened.targetDbName).toBe(db);
    await opened.close();
    for (const role of ROLES) {
      expect(fakes[role].endCalls).toBe(1);
    }
  });
});
