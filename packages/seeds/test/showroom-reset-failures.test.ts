import { describe, expect, it, vi } from 'vitest';
import { createPool, type Pool } from '@fluvia/db';
import {
  ShowroomResetSequenceError,
  ShowroomTargetRemovedError,
  TUPLE_CONCURRENTLY_UPDATED_MESSAGE,
  TUPLE_CONCURRENTLY_UPDATED_SQLSTATE,
  isRetryableTupleConcurrentlyUpdated,
  prepareShowroomDatabase,
} from '../src/reset.js';
import { MAINTENANCE_URL, ephemeralDbName, resetRequestFor } from './showroom-helpers.js';

/**
 * RA-F65C3-EXT-004 — «DROP exitoso + CREATE fallido» es un estado DISTINTO de
 * cualquier otro fallo: el target quedo ELIMINADO y hay que reconstruirlo. Se
 * comunica con un error tipado estable (target_removed_rebuild_required), sin
 * SQL crudo/URLs/credenciales en el mensaje, con la causa SOLO interna, el
 * advisory lock liberado, la sesion soltada y la maintenance cerrada; migrate
 * y seed jamas arrancan. RA-F65C3-EXT-005 — el retry de migracion solo actua
 * ante el error ESTRUCTURADO exacto (SQLSTATE XX000 + mensaje exacto), jamas
 * por texto.
 */

interface SessionScript {
  dropFails?: boolean;
  createFails?: boolean;
}

function fakeMaintenanceFactory(script: SessionScript) {
  const calls: string[] = [];
  const state = {
    released: false,
    ended: false,
    lockTaken: 0,
    lockReleased: 0,
    dropExecuted: 0,
    createExecuted: 0,
  };
  const session = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      if (sql.includes('current_database')) return { rows: [{ db: 'postgres' }] };
      if (sql.includes('pg_advisory_lock(')) {
        state.lockTaken += 1;
        void params;
        return { rows: [] };
      }
      if (sql.includes('pg_advisory_unlock(')) {
        state.lockReleased += 1;
        return { rows: [] };
      }
      if (sql.includes('quote_ident')) {
        return { rows: [{ q: `"${(params as string[])[0]}"` }] };
      }
      if (sql.startsWith('DROP DATABASE')) {
        if (script.dropFails) throw new Error('injected drop failure');
        state.dropExecuted += 1;
        return { rows: [] };
      }
      if (sql.startsWith('CREATE DATABASE')) {
        if (script.createFails) throw new Error('injected create failure: disk full');
        state.createExecuted += 1;
        return { rows: [] };
      }
      throw new Error(`unexpected maintenance sql: ${sql}`);
    },
    release: () => {
      state.released = true;
    },
  };
  const maintenance = {
    connect: async () => session,
    end: async () => {
      state.ended = true;
    },
  };
  const factory = vi.fn((_opts: { connectionString: string; max?: number }): Pool => {
    if (factory.mock.calls.length > 1) {
      throw new Error('only the maintenance pool may be opened in these scenarios');
    }
    return maintenance as unknown as Pool;
  });
  return { factory: factory as unknown as typeof createPool, spy: factory, calls, state };
}

describe('DROP/CREATE: maquina de fases y error tipado (EXT-004)', () => {
  const REQ = resetRequestFor('fluvia_showroom_test_dropfail1');

  it('DROP falla: error normal (NO target-removed), CREATE jamas se ejecuta, cleanup completo', async () => {
    const { factory, spy, calls, state } = fakeMaintenanceFactory({ dropFails: true });
    const phases: string[] = [];
    let error: unknown;
    try {
      await prepareShowroomDatabase(REQ, { createPool: factory, onPhase: (p) => phases.push(p) });
    } catch (err) {
      error = err;
    }
    expect(String(error)).toContain('injected drop failure');
    expect(error).not.toBeInstanceOf(ShowroomTargetRemovedError);
    expect(calls.some((sql) => sql.startsWith('CREATE DATABASE'))).toBe(false);
    // Lock liberado, sesion soltada, maintenance cerrada; migrate jamas
    // arranco (el UNICO pool abierto fue el de mantenimiento).
    expect(state.lockTaken).toBe(1);
    expect(state.lockReleased).toBe(1);
    expect(state.released).toBe(true);
    expect(state.ended).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['guard', 'drop-create']);
  });

  it('DROP exito + CREATE falla: ShowroomTargetRemovedError estable, migrate/seed jamas, mensaje seguro', async () => {
    const { factory, spy, state } = fakeMaintenanceFactory({ createFails: true });
    const phases: string[] = [];
    let error: unknown;
    try {
      await prepareShowroomDatabase(REQ, { createPool: factory, onPhase: (p) => phases.push(p) });
    } catch (err) {
      error = err;
    }
    // Error TIPADO con codigo estable que comunica el contrato completo:
    // target eliminado, CREATE sin terminar, migrate/seed/invariants jamas
    // arrancaron, reconstruir con demo:reset.
    expect(error).toBeInstanceOf(ShowroomTargetRemovedError);
    const removed = error as ShowroomTargetRemovedError;
    expect(removed.code).toBe('target_removed_rebuild_required');
    expect(removed.message).toContain('DROP succeeded');
    expect(removed.message).toContain('CREATE DATABASE did not complete');
    expect(removed.message).toContain('migrate/seed/invariants never started');
    expect(removed.message).toContain('run demo:reset again');
    // Mensaje SEGURO: sin SQL crudo del fallo, sin URL, sin credenciales.
    expect(removed.message).not.toContain('disk full');
    expect(removed.message).not.toContain('postgres://');
    expect(removed.message).not.toContain('postgres:postgres');
    // La causa queda SOLO para uso interno (cause), jamas en el mensaje.
    expect(String((removed.cause as Error).message)).toContain('injected create failure');
    // DROP ejecutado, lock liberado, sesion y maintenance cerradas.
    expect(state.dropExecuted).toBe(1);
    expect(state.createExecuted).toBe(0);
    expect(state.lockTaken).toBe(1);
    expect(state.lockReleased).toBe(1);
    expect(state.released).toBe(true);
    expect(state.ended).toBe(true);
    // migrate jamas: el unico pool abierto fue la maintenance; la fase
    // 'migrate' nunca se anuncio (y 'seed' pertenece a runShowroomReset).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['guard', 'drop-create']);
  });

  it('el estado «target eliminado» se RECONSTRUYE con el siguiente reset (real)', async () => {
    // Simula el estado que deja EXT-004 (la base dedicada NO existe) y
    // demuestra que prepareShowroomDatabase real la reconstruye y migra.
    const db = ephemeralDbName();
    const req = resetRequestFor(db);
    const maintenance = createPool({ connectionString: MAINTENANCE_URL, max: 1 });
    try {
      await maintenance.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
      const plan = await prepareShowroomDatabase(req);
      expect(plan.targetDbName).toBe(db);
      const admin = createPool({ connectionString: req.targetUrls.admin, max: 1 });
      try {
        const migrations = await admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM schema_migrations`
        );
        expect(Number(migrations.rows[0]!.n)).toBeGreaterThan(0);
      } finally {
        await admin.end();
      }
    } finally {
      await maintenance.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
      await maintenance.end();
    }
  }, 180_000);
});

describe('retry ESTRUCTURADO de migracion (EXT-005): tabla exhaustiva', () => {
  // Forma REAL observada empiricamente en PostgreSQL 16.13 (node-postgres
  // DatabaseError) al chocar dos ALTER ROLE sobre pg_authid:
  //   { code: 'XX000', message: 'tuple concurrently updated',
  //     routine: 'simple_heap_update' }
  // y el runner de migraciones la envuelve en Error { cause } por archivo.
  const realShape = () =>
    Object.assign(new Error(TUPLE_CONCURRENTLY_UPDATED_MESSAGE), {
      code: TUPLE_CONCURRENTLY_UPDATED_SQLSTATE,
      severity: 'ERROR',
      routine: 'simple_heap_update',
    });

  it.each<[string, () => unknown, boolean]>([
    ['error estructurado exacto (XX000 + mensaje exacto)', realShape, true],
    [
      'envuelto por el runner de migraciones en Error{cause} (forma real)',
      () =>
        new Error('Migration 0009_x.sql failed: tuple concurrently updated', {
          cause: realShape(),
        }),
      true,
    ],
    [
      'cadena de causas profunda pero acotada',
      () => new Error('outer', { cause: new Error('mid', { cause: realShape() }) }),
      true,
    ],
    [
      'mismo texto con OTRO SQLSTATE (40001 serialization_failure)',
      () => Object.assign(new Error(TUPLE_CONCURRENTLY_UPDATED_MESSAGE), { code: '40001' }),
      false,
    ],
    [
      'SQLSTATE correcto (XX000) con OTRO mensaje',
      () => Object.assign(new Error('right sqlstate, wrong message'), { code: 'XX000' }),
      false,
    ],
    [
      'mismo texto SIN estructura (sin code) — el caso del match de texto',
      () => new Error(TUPLE_CONCURRENTLY_UPDATED_MESSAGE),
      false,
    ],
    [
      'permiso insuficiente (42501): jamas retry',
      () => Object.assign(new Error('permission denied for table x'), { code: '42501' }),
      false,
    ],
    [
      'error de sintaxis SQL (42601): jamas retry',
      () => Object.assign(new Error('syntax error at or near "FROM"'), { code: '42601' }),
      false,
    ],
    [
      'violacion de integridad (23505): jamas retry',
      () =>
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        }),
      false,
    ],
    [
      'error de red (ECONNREFUSED): jamas retry',
      () =>
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
          code: 'ECONNREFUSED',
        }),
      false,
    ],
    [
      'fallo de autenticacion (28P01): jamas retry',
      () => Object.assign(new Error('password authentication failed'), { code: '28P01' }),
      false,
    ],
    ['string suelto: jamas retry', () => 'tuple concurrently updated', false],
    ['null: jamas retry', () => null, false],
    ['undefined: jamas retry', () => undefined, false],
  ])('%s', (_label, make, expected) => {
    expect(isRetryableTupleConcurrentlyUpdated(make())).toBe(expected);
  });

  it('una cadena de causas ciclica no cuelga (recorrido acotado)', () => {
    const a = new Error('a');
    const b = new Error('b');
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });
    expect(isRetryableTupleConcurrentlyUpdated(a)).toBe(false);
  });
});

/**
 * Delta RA-F65C3-EXT-004 — PRESERVACION DEL ERROR PRIMARIO: un fallo del
 * cleanup (unlock/release/end) JAMAS sustituye al error operativo (en
 * particular ShowroomTargetRemovedError); cada recurso recibe SU intento de
 * cleanup; los fallos secundarios se registran solo como codigos de paso
 * fijos NO enumerables; sin primario, el cleanup fallido lanza tipado.
 */
interface CleanupScript {
  createFails?: boolean;
  unlockFails?: boolean;
  releaseFails?: boolean;
  endFails?: boolean;
}

function fakeMaintenanceWithCleanup(script: CleanupScript, injectedCreateError?: Error) {
  const state = {
    unlockAttempted: false,
    releaseAttempted: false,
    endAttempted: false,
    dropExecuted: 0,
  };
  const session = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('current_database')) return { rows: [{ db: 'postgres' }] };
      if (sql.includes('pg_advisory_lock(')) return { rows: [] };
      if (sql.includes('pg_advisory_unlock(')) {
        state.unlockAttempted = true;
        if (script.unlockFails) {
          throw new Error('unlock failed: postgres://secret:pw@10.0.0.1/postgres');
        }
        return { rows: [] };
      }
      if (sql.includes('quote_ident')) return { rows: [{ q: `"${(params as string[])[0]}"` }] };
      if (sql.startsWith('DROP DATABASE')) {
        state.dropExecuted += 1;
        return { rows: [] };
      }
      if (sql.startsWith('CREATE DATABASE')) {
        if (script.createFails) {
          throw injectedCreateError ?? new Error('injected create failure');
        }
        return { rows: [] };
      }
      throw new Error(`unexpected maintenance sql: ${sql}`);
    },
    release: () => {
      state.releaseAttempted = true;
      if (script.releaseFails) throw new Error('release failed with secret sup3r-s3cret-pw');
    },
  };
  const maintenance = {
    connect: async () => session,
    end: async () => {
      state.endAttempted = true;
      if (script.endFails) throw new Error('end failed: whsec-like secret material');
    },
  };
  const factory = vi.fn((_opts: { connectionString: string; max?: number }): Pool => {
    if (factory.mock.calls.length > 1) {
      throw new Error('only the maintenance pool may be opened in these scenarios');
    }
    return maintenance as unknown as Pool;
  });
  return { factory: factory as unknown as typeof createPool, spy: factory, state };
}

describe('preservacion del error primario en el cleanup de mantenimiento (delta EXT-004)', () => {
  const REQ2 = resetRequestFor('fluvia_showroom_test_cleanup2');

  it.each([
    ['unlock', { unlockFails: true }, ['advisory_unlock']],
    ['release', { releaseFails: true }, ['session_release']],
    ['maintenance.end', { endFails: true }, ['maintenance_end']],
    [
      'los tres',
      { unlockFails: true, releaseFails: true, endFails: true },
      ['advisory_unlock', 'session_release', 'maintenance_end'],
    ],
  ] as Array<[string, CleanupScript, string[]]>)(
    'primario (TargetRemoved) + fallo de cleanup en %s: el primario se preserva por identidad',
    async (_label, script, expectedSteps) => {
      const injected = new Error('CREATE failed: disk full at postgres://u:pw@127.0.0.1/x');
      const { factory, spy, state } = fakeMaintenanceWithCleanup(
        { createFails: true, ...script },
        injected
      );
      let error: unknown;
      try {
        await prepareShowroomDatabase(REQ2, { createPool: factory });
      } catch (err) {
        error = err;
      }
      // El error operativo CRITICO se preserva (identidad de la causa
      // inyectada incluida), jamas sustituido por el fallo del cleanup.
      expect(error).toBeInstanceOf(ShowroomTargetRemovedError);
      expect((error as ShowroomTargetRemovedError).cause).toBe(injected);
      expect((error as ShowroomTargetRemovedError).code).toBe('target_removed_rebuild_required');
      // Cada recurso recibio SU intento de cleanup (un fallo no bloquea el resto).
      expect(state.unlockAttempted).toBe(true);
      expect(state.releaseAttempted).toBe(true);
      expect(state.endAttempted).toBe(true);
      // Los fallos secundarios quedan SOLO como codigos fijos NO enumerables.
      const steps = Object.getOwnPropertyDescriptor(error as object, 'cleanupFailureSteps');
      expect(steps?.enumerable).toBe(false);
      expect([...(steps?.value as string[])]).toEqual(expectedSteps);
      expect(Object.keys(error as object)).not.toContain('cleanupFailureSteps');
      // El mensaje del primario sigue siendo el estable y SIN secretos del
      // cleanup ni de la causa (la causa vive solo en `cause`).
      const message = (error as Error).message;
      expect(message).not.toMatch(/disk full|postgres:\/\/|sup3r-s3cret|whsec/);
      expect(message).toContain('run demo:reset again');
      expect(spy).toHaveBeenCalledTimes(1); // migrate/seed jamas arrancaron
    }
  );

  it('cleanup fallido SIN error primario: error tipado y sanitizado (migrate jamas arranca)', async () => {
    const { factory, spy, state } = fakeMaintenanceWithCleanup({ endFails: true });
    let error: unknown;
    try {
      await prepareShowroomDatabase(REQ2, { createPool: factory });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ShowroomResetSequenceError);
    expect((error as Error).message).toContain('maintenance cleanup failed (maintenance_end)');
    expect((error as Error).message).not.toMatch(/whsec|postgres:\/\//);
    expect(state.dropExecuted).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Delta RA-F65C3-EXT-005 — pruebas CONDUCTUALES del loop real de retry con
 * migrateFn/sleepFn INYECTADOS (seams de deps del reset, no hooks publicos):
 * conteo exacto de intentos y sleeps, delays exactos y acotados, corte
 * inmediato ante errores no reintenables, sin intento 11.
 */
const realShapeError = () =>
  Object.assign(new Error(TUPLE_CONCURRENTLY_UPDATED_MESSAGE), {
    code: TUPLE_CONCURRENTLY_UPDATED_SQLSTATE,
    severity: 'ERROR',
    routine: 'simple_heap_update',
  });

function successfulMaintenanceFactory() {
  // Llamada 1: pool de maintenance fake (DROP/CREATE OK). Llamadas
  // siguientes: pool admin fake para el bloque de migrate inyectado.
  const { factory } = fakeMaintenanceWithCleanup({});
  let calls = 0;
  const wrapped = (opts: { connectionString: string; max?: number }): Pool => {
    calls += 1;
    if (calls === 1) return (factory as typeof createPool)(opts);
    return { query: async () => ({ rows: [] }), end: async () => undefined } as unknown as Pool;
  };
  return wrapped as unknown as typeof createPool;
}

function behavioralDeps(outcomes: Array<Error | 'ok'>) {
  const migrateCalls: number[] = [];
  const sleeps: number[] = [];
  const migrateFn = (async () => {
    const attempt = migrateCalls.length + 1;
    migrateCalls.push(attempt);
    const outcome = outcomes[attempt - 1];
    if (outcome === undefined) throw new Error(`unscripted migrate attempt ${attempt}`);
    if (outcome !== 'ok') throw outcome;
  }) as unknown as NonNullable<import('../src/reset.js').ShowroomResetDeps['migrateFn']>;
  const sleepFn = async (ms: number) => {
    sleeps.push(ms);
  };
  return { migrateCalls, sleeps, migrateFn, sleepFn };
}

describe('retry conductual de migracion (delta EXT-005)', () => {
  const REQ3 = resetRequestFor('fluvia_showroom_test_retry1');

  it('9 fallos reintenables + exito en el intento 10: 10 migrates, 9 sleeps, delays exactos', async () => {
    const outcomes: Array<Error | 'ok'> = [...Array.from({ length: 9 }, realShapeError), 'ok'];
    const { migrateCalls, sleeps, migrateFn, sleepFn } = behavioralDeps(outcomes);
    await prepareShowroomDatabase(REQ3, {
      createPool: successfulMaintenanceFactory(),
      migrateFn,
      sleepFn,
    });
    expect(migrateCalls).toHaveLength(10);
    expect(sleeps).toEqual([250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250]);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(2500); // acotado
  }, 20_000);

  it('10 fallos reintenables: 10 migrates, 9 sleeps, se propaga el error del intento 10, sin intento 11', async () => {
    const last = realShapeError();
    const outcomes: Array<Error | 'ok'> = [...Array.from({ length: 9 }, realShapeError), last];
    const { migrateCalls, sleeps, migrateFn, sleepFn } = behavioralDeps(outcomes);
    let error: unknown;
    try {
      await prepareShowroomDatabase(REQ3, {
        createPool: successfulMaintenanceFactory(),
        migrateFn,
        sleepFn,
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBe(last);
    expect(migrateCalls).toHaveLength(10);
    expect(sleeps).toHaveLength(9);
  }, 20_000);

  it.each([
    ['permisos (42501)', Object.assign(new Error('permission denied'), { code: '42501' })],
    ['red (ECONNREFUSED)', Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })],
  ])(
    'intento 1 reintenable + intento 2 %s: dos llamadas, propaga de inmediato, un solo sleep',
    async (_label, second) => {
      const { migrateCalls, sleeps, migrateFn, sleepFn } = behavioralDeps([
        realShapeError(),
        second,
      ]);
      let error: unknown;
      try {
        await prepareShowroomDatabase(REQ3, {
          createPool: successfulMaintenanceFactory(),
          migrateFn,
          sleepFn,
        });
      } catch (err) {
        error = err;
      }
      expect(error).toBe(second);
      expect(migrateCalls).toHaveLength(2);
      expect(sleeps).toEqual([250]);
    },
    20_000
  );

  it('intento 1 NO reintenable: una llamada, cero sleeps', async () => {
    const first = Object.assign(new Error('syntax error'), { code: '42601' });
    const { migrateCalls, sleeps, migrateFn, sleepFn } = behavioralDeps([first]);
    await expect(
      prepareShowroomDatabase(REQ3, {
        createPool: successfulMaintenanceFactory(),
        migrateFn,
        sleepFn,
      })
    ).rejects.toBe(first);
    expect(migrateCalls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  }, 20_000);

  it('cause chain CICLICA: sin cuelgue y sin retry accidental (una llamada)', async () => {
    const a = new Error('a');
    const b = new Error('b');
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });
    const { migrateCalls, sleeps, migrateFn, sleepFn } = behavioralDeps([a]);
    await expect(
      prepareShowroomDatabase(REQ3, {
        createPool: successfulMaintenanceFactory(),
        migrateFn,
        sleepFn,
      })
    ).rejects.toBe(a);
    expect(migrateCalls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  }, 20_000);

  it('integracion PG16 REAL: un retry real (fallo inyectado con forma exacta) y exito del intento 2', async () => {
    const db = ephemeralDbName();
    const req = resetRequestFor(db);
    const maintenance = createPool({ connectionString: MAINTENANCE_URL, max: 1 });
    const sleeps: number[] = [];
    let calls = 0;
    try {
      const plan = await prepareShowroomDatabase(req, {
        migrateFn: (async (pool, dir, opts) => {
          calls += 1;
          if (calls === 1) throw realShapeError();
          const { migrate } = await import('@fluvia/db');
          return migrate(pool, dir, opts);
        }) as NonNullable<import('../src/reset.js').ShowroomResetDeps['migrateFn']>,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(plan.targetDbName).toBe(db);
      expect(calls).toBe(2);
      expect(sleeps).toEqual([250]);
      const admin = createPool({ connectionString: req.targetUrls.admin, max: 1 });
      try {
        const migrations = await admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM schema_migrations`
        );
        // La migracion por archivo conservo su transaccionalidad: tras el
        // retry, el runner REAL aplico todo el esquema completo.
        expect(Number(migrations.rows[0]!.n)).toBeGreaterThan(0);
      } finally {
        await admin.end();
      }
    } finally {
      await maintenance.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
      await maintenance.end();
    }
  }, 180_000);
});
