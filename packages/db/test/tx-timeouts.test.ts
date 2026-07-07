import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '../src/index.js';
import { createTestContext, type TestContext } from '../src/testing.js';

/**
 * V2-R1 (re-auditoría v2) — `withTenantTransaction` fija cotas de tiempo por
 * transacción como SET LOCAL: una query patológica, un lock no resuelto o una tx
 * dejada abierta no puede acaparar una conexión del pool indefinidamente. Se
 * prueba: (1) los defaults se aplican, (2) el caller puede sobreescribirlos,
 * (3) el `statement_timeout` REALMENTE aborta una sentencia lenta.
 */

let ctx: TestContext;
let tenant: string;

beforeAll(async () => {
  ctx = await createTestContext();
  tenant = await ctx.createTenant();
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

// `SHOW x` devuelve una única columna nombrada como el setting; leemos su valor
// de forma genérica (primer valor de la fila).
async function show(setting: string, timeouts?: Parameters<typeof withTenantTransaction>[3]) {
  return withTenantTransaction(
    ctx.app,
    tenant,
    async (c) => Object.values((await c.query(`SHOW ${setting}`)).rows[0]!)[0] as string,
    timeouts
  );
}

describe('withTenantTransaction — cotas de tiempo (V2-R1)', () => {
  it('applies conservative default timeouts as SET LOCAL', async () => {
    expect(await show('statement_timeout')).toBe('30s');
    expect(await show('lock_timeout')).toBe('15s');
    expect(await show('idle_in_transaction_session_timeout')).toBe('1min');
  });

  it('lets a caller override the timeouts per transaction', async () => {
    const opts = { statementTimeoutMs: 5_000, lockTimeoutMs: 2_000, idleInTxTimeoutMs: 10_000 };
    expect(await show('statement_timeout', opts)).toBe('5s');
    expect(await show('lock_timeout', opts)).toBe('2s');
    expect(await show('idle_in_transaction_session_timeout', opts)).toBe('10s');
  });

  it('the context still dies with the transaction (tenant + timeouts are LOCAL)', async () => {
    await show('statement_timeout', { statementTimeoutMs: 5_000 });
    // Fuera de una tx del helper, la conexión del pool no arrastra el override.
    const client = await ctx.app.connect();
    try {
      const row = (await client.query('SHOW statement_timeout')).rows[0]!;
      expect(Object.values(row)[0]).not.toBe('5s');
    } finally {
      client.release();
    }
  });

  it('statement_timeout actually aborts a slow statement', async () => {
    await expect(
      withTenantTransaction(ctx.app, tenant, async (c) => c.query('SELECT pg_sleep(1)'), {
        statementTimeoutMs: 100,
      })
    ).rejects.toMatchObject({ code: '57014' }); // canceling statement due to statement timeout
  });
});
