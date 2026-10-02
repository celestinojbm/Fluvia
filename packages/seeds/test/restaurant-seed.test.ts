import { describe, expect, it } from 'vitest';
import type { Pool } from '@fluvia/db';
import { SeedEnvironmentError } from '../src/seed.js';
import { RESTAURANT_DEMO, seedRestaurantDemo } from '../src/restaurant-seed.js';

describe('seed de restaurantes', () => {
  it('fuera de local/test aborta ANTES de tocar la BD o la API', async () => {
    const touched: string[] = [];
    const admin = {
      query: async (q: string) => {
        touched.push(q);
        return { rows: [] };
      },
    } as unknown as Pool;
    for (const env of ['sandbox', 'staging', 'production']) {
      await expect(
        seedRestaurantDemo(env, { admin, apiUrl: 'http://127.0.0.1:9' })
      ).rejects.toThrow(SeedEnvironmentError);
    }
    expect(touched).toEqual([]);
  });

  it('personas sintéticas en dominios .test y contraseñas de demo', () => {
    const people = [
      RESTAURANT_DEMO.owner,
      RESTAURANT_DEMO.waiter,
      RESTAURANT_DEMO.kitchen,
      RESTAURANT_DEMO.cashier,
      RESTAURANT_DEMO.solo,
    ];
    for (const p of people) {
      expect(p.email).toMatch(/@([a-z]+\.)?demo\.fluvia\.test$/);
      expect(p.password).toMatch(/^demo-/);
    }
    expect(new Set(people.map((p) => p.id)).size).toBe(people.length);
  });
});
