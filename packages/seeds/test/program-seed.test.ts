import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, dbUrlsFromEnv, migrate, type Pool } from '@fluvia/db';
import { DEMO, seedDemo } from '../src/seed.js';
import { PROGRAM_DEMO, seedProgramDemo } from '../src/program-seed.js';

let admin: Pool;
let app: Pool;
let auth: Pool;

beforeAll(async () => {
  const urls = dbUrlsFromEnv();
  admin = createPool({ connectionString: urls.admin, max: 2 });
  await migrate(admin);
  app = createPool({ connectionString: urls.app, max: 4 });
  auth = createPool({ connectionString: urls.auth, max: 2 });
  await seedDemo('test', { admin, app });
}, 30_000);

afterAll(async () => {
  await Promise.all([admin.end(), app.end(), auth.end()]);
});

describe('seed del programa de demo (Fluvia Personal)', () => {
  it('es re-ejecutable: no duplica cliente, ingreso, garantía, solicitud ni tarjeta', async () => {
    const a = await seedProgramDemo('test', { admin, app, auth });
    const b = await seedProgramDemo('test', { admin, app, auth });
    expect(b.consumerId).toBe(a.consumerId);
    expect(a.programId).toBe(PROGRAM_DEMO.organizationId);
    const count = async (sql: string) =>
      Number((await admin.query<{ n: string }>(sql, [PROGRAM_DEMO.organizationId])).rows[0]!.n);
    expect(await count(`SELECT count(*)::text AS n FROM consumers WHERE tenant_id = $1`)).toBe(1);
    expect(
      await count(`SELECT count(*)::text AS n FROM wallet_fundings WHERE tenant_id = $1`)
    ).toBe(1);
    expect(
      await count(`SELECT count(*)::text AS n FROM collateral_movements WHERE tenant_id = $1`)
    ).toBe(1);
    expect(
      await count(`SELECT count(*)::text AS n FROM credit_applications WHERE tenant_id = $1`)
    ).toBe(1);
    expect(await count(`SELECT count(*)::text AS n FROM cards WHERE tenant_id = $1`)).toBe(1);
    const owner = DEMO.users.find((u) => u.role === 'owner')!;
    const m = await admin.query(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [
      PROGRAM_DEMO.organizationId,
      owner.id,
    ]);
    expect(m.rowCount).toBe(1);
  });

  it('se niega fuera de local/test', async () => {
    await expect(seedProgramDemo('production', { admin, app, auth })).rejects.toThrow(/forbidden/);
  });
});
