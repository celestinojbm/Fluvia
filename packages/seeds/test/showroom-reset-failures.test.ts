import { describe, expect, it, vi } from 'vitest';
import { createPool, type Pool } from '@fluvia/db';
import {
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
