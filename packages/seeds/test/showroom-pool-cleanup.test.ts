import { describe, expect, it, vi } from 'vitest';
import type { Pool, createPool } from '@fluvia/db';
import { openShowroomPoolsSafely, openVerifiedShowroomTarget } from '../src/reset.js';
import { ShowroomDatabaseMismatchError } from '../src/showroom.js';
import { targetUrlsFor } from './showroom-helpers.js';

/**
 * RA-F65C3-EXT-003 — apertura SEGURA de los cinco pools: si el factory falla
 * en CUALQUIER posicion, todos los pools ya creados se cierran exactamente una
 * vez, ningun pool posterior se crea, un fallo del propio cleanup no oculta el
 * error original y no queda ningun handle vivo. La misma primitiva sirve al
 * seed y al reset (runShowroomReset abre sus pools target con ella).
 */

const URLS = targetUrlsFor('fluvia_showroom_test_cleanup1');
const ROLE_ORDER = ['admin', 'app', 'auth', 'relay', 'webhook'] as const;

interface FakePool {
  connectionString: string;
  endCalls: number;
  end: () => Promise<void>;
  query: (sql: string) => Promise<{ rows: unknown[] }>;
}

function fakePoolFactory(options: {
  failAt?: number; // posicion 1-based en la que el factory lanza
  endRejectsFor?: number[]; // posiciones cuyos end() ademas fallan
  identityRow?: () => Record<string, unknown>;
}) {
  const created: FakePool[] = [];
  const factory = vi.fn((opts: { connectionString: string; max?: number }): Pool => {
    if (options.failAt !== undefined && created.length + 1 === options.failAt) {
      throw new Error(`factory refused pool #${options.failAt}`);
    }
    const index = created.length + 1;
    const pool: FakePool = {
      connectionString: opts.connectionString,
      endCalls: 0,
      end: async () => {
        pool.endCalls += 1;
        if (options.endRejectsFor?.includes(index)) {
          throw new Error(`cleanup failure for pool #${index}`);
        }
      },
      query: async () => ({ rows: options.identityRow ? [options.identityRow()] : [] }),
    };
    created.push(pool);
    return pool as unknown as Pool;
  });
  return { factory: factory as unknown as typeof createPool, spy: factory, created };
}

describe('openShowroomPoolsSafely: fallo parcial del factory', () => {
  it.each([1, 2, 3, 4, 5])(
    'factory falla en el pool %i: los anteriores se cierran UNA vez y no se crea ninguno posterior',
    async (failAt) => {
      const { factory, spy, created } = fakePoolFactory({ failAt });
      await expect(openShowroomPoolsSafely(URLS, factory)).rejects.toThrow(
        `factory refused pool #${failAt}`
      );
      // El factory se intento EXACTAMENTE hasta la posicion fallida.
      expect(spy).toHaveBeenCalledTimes(failAt);
      // Todos los anteriores creados quedaron cerrados exactamente una vez.
      expect(created).toHaveLength(failAt - 1);
      for (const pool of created) expect(pool.endCalls).toBe(1);
      // El orden de apertura es el de los roles (ningun pool posterior).
      for (const [i, pool] of created.entries()) {
        expect(pool.connectionString).toBe(URLS[ROLE_ORDER[i]!]);
      }
    }
  );

  it('un cleanup que TAMBIEN falla no oculta el error original', async () => {
    const { factory, created } = fakePoolFactory({ failAt: 4, endRejectsFor: [1, 2] });
    await expect(openShowroomPoolsSafely(URLS, factory)).rejects.toThrow('factory refused pool #4');
    // Los end() se INTENTARON en todos los creados (allSettled), fallen o no.
    expect(created.map((p) => p.endCalls)).toEqual([1, 1, 1]);
  });

  it('exito: cinco pools en el orden de roles, cero cierres', async () => {
    const { factory, spy, created } = fakePoolFactory({});
    const pools = await openShowroomPoolsSafely(URLS, factory);
    expect(spy).toHaveBeenCalledTimes(5);
    expect(created.every((p) => p.endCalls === 0)).toBe(true);
    expect(new Set(Object.keys(pools))).toEqual(new Set(ROLE_ORDER));
  });
});

describe('openVerifiedShowroomTarget: la attestation fallida cierra los cinco pools', () => {
  it('pools abiertos pero identidad live invalida: cero handles vivos', async () => {
    // La query de identidad devuelve una fila invalida (sin server address):
    // la attestation rechaza y la apertura verificada debe cerrar TODO.
    const { factory, created } = fakePoolFactory({
      identityRow: () => ({
        database: 'fluvia_showroom_test_cleanup1',
        server_address: null,
        server_port: null,
        postmaster_started_at: null,
      }),
    });
    await expect(openVerifiedShowroomTarget('test', URLS, factory)).rejects.toBeInstanceOf(
      ShowroomDatabaseMismatchError
    );
    expect(created).toHaveLength(5);
    for (const pool of created) expect(pool.endCalls).toBe(1);
  });

  it('la query de identidad FALLA en cada posicion 1-5: rechazo y cleanup completo', async () => {
    for (let failRole = 1; failRole <= 5; failRole++) {
      const { factory, created } = fakePoolFactory({});
      let built = 0;
      // Sustituye la query del pool en la posicion failRole por un fallo duro.
      const wrapped = vi.fn((opts: { connectionString: string; max?: number }): Pool => {
        const pool = (factory as unknown as (o: typeof opts) => Pool)(opts) as unknown as FakePool;
        built += 1;
        if (built === failRole) {
          pool.query = async () => {
            throw new Error('identity query exploded');
          };
        } else {
          pool.query = async () => ({
            rows: [
              {
                database: 'fluvia_showroom_test_cleanup1',
                server_address: '127.0.0.1',
                server_port: '5432',
                postmaster_started_at: '2026-07-18 00:00:00.000000+00',
                cluster_identifier: '7000000000000000001',
              },
            ],
          });
        }
        return pool as unknown as Pool;
      });
      await expect(
        openVerifiedShowroomTarget('test', URLS, wrapped as unknown as typeof createPool)
      ).rejects.toBeInstanceOf(ShowroomDatabaseMismatchError);
      expect(created).toHaveLength(5);
      for (const pool of created) expect(pool.endCalls).toBe(1);
    }
  });
});
