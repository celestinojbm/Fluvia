import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '@fluvia/auth';
import { createPool, dbUrlsFromEnv, migrate, type Pool } from '@fluvia/db';
import { seedUuid } from '../src/deterministic.js';
import { DEMO, SeedEnvironmentError, seedDemo, type SeedReport } from '../src/seed.js';

let admin: Pool;
let app: Pool;

beforeAll(async () => {
  const urls = dbUrlsFromEnv();
  admin = createPool({ connectionString: urls.admin, max: 2 });
  await migrate(admin);
  app = createPool({ connectionString: urls.app, max: 4 });
}, 30_000);

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

async function demoRowCounts(): Promise<Record<string, number>> {
  const q = async (sql: string, params: unknown[]) =>
    Number((await admin.query<{ n: string }>(sql, params)).rows[0]!.n);
  return {
    orgs: await q(`SELECT count(*)::text AS n FROM organizations WHERE id = $1`, [
      DEMO.organizationId,
    ]),
    users: await q(`SELECT count(*)::text AS n FROM users WHERE id = ANY($1::uuid[])`, [
      DEMO.users.map((u) => u.id),
    ]),
    memberships: await q(`SELECT count(*)::text AS n FROM memberships WHERE tenant_id = $1`, [
      DEMO.organizationId,
    ]),
    merchants: await q(`SELECT count(*)::text AS n FROM merchants WHERE id = $1`, [
      DEMO.merchantId,
    ]),
    ledgerTx: await q(`SELECT count(*)::text AS n FROM ledger_transactions WHERE tenant_id = $1`, [
      DEMO.organizationId,
    ]),
    entries: await q(`SELECT count(*)::text AS n FROM ledger_entries WHERE tenant_id = $1`, [
      DEMO.organizationId,
    ]),
  };
}

describe('seedUuid (determinismo)', () => {
  it('same key -> same RFC 4122 v5 UUID; different keys diverge', () => {
    expect(seedUuid('x')).toBe(seedUuid('x'));
    expect(seedUuid('x')).not.toBe(seedUuid('y'));
    expect(seedUuid('x')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

describe('seedDemo (F1-10)', () => {
  it('refuses to run outside local/test BEFORE touching the database', async () => {
    for (const env of ['sandbox', 'staging', 'production']) {
      await expect(
        // Pools rotos a proposito: si el guard fallara, esto reventaria por
        // conexion — el orden importa y se prueba.
        seedDemo(env, { admin: null as unknown as Pool, app: null as unknown as Pool })
      ).rejects.toThrow(SeedEnvironmentError);
    }
  });

  it('is reproducible AND idempotent: second run adds ZERO rows and returns identical ids', async () => {
    const first: SeedReport = await seedDemo('test', { admin, app });
    const afterFirst = await demoRowCounts();

    const second: SeedReport = await seedDemo('test', { admin, app });
    const afterSecond = await demoRowCounts();

    // Mismos IDs deterministas en ambas corridas (incluidas las tx del ledger:
    // el replay de idempotencia devuelve el asiento ORIGINAL, no uno nuevo).
    expect(second).toEqual(first);
    expect(first.organizationId).toBe(DEMO.organizationId);
    expect(first.transactionIds).toHaveLength(2);

    // Ni una fila nueva en la segunda corrida.
    expect(afterSecond).toEqual(afterFirst);
    expect(afterFirst.orgs).toBe(1);
    expect(afterFirst.users).toBe(2);
    expect(afterFirst.memberships).toBe(2);
    expect(afterFirst.merchants).toBe(1);
    // capture (5 asientos) + release (2 asientos) = 2 tx, 7 asientos.
    expect(afterFirst.ledgerTx).toBe(2);
    expect(afterFirst.entries).toBe(7);
  });

  it('demo balances tell the seeded story: 500k captured, 19.5k platform fee, 300k released', async () => {
    const report = await seedDemo('test', { admin, app });
    // merchant.pending: (500000 - 19500) - 300000 = 180500; available: 300000.
    expect(report.balances.pending).toBe('180500');
    expect(report.balances.available).toBe('300000');
  });

  it('demo users can actually authenticate with the documented demo passwords', async () => {
    await seedDemo('test', { admin, app });
    for (const user of DEMO.users) {
      const res = await admin.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [user.id]
      );
      expect(res.rowCount).toBe(1);
      await expect(verifyPassword(user.password, res.rows[0]!.password_hash)).resolves.toBe(true);
    }
  });
});
