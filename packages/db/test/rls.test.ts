import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '../src/index.js';
import { createTestContext, type TestContext } from '../src/testing.js';

let ctx: TestContext;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  ctx = await createTestContext();
  tenantA = await ctx.createTenant();
  tenantB = await ctx.createTenant();
  await ctx.createLedgerAccount({
    tenantId: tenantA,
    name: 'merchant_available',
    currency: 'USD',
    normalSide: 'credit',
  });
  await ctx.createLedgerAccount({
    tenantId: tenantB,
    name: 'merchant_available',
    currency: 'USD',
    normalSide: 'credit',
  });
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('Row Level Security (P0-02)', () => {
  it('a tenant only sees its own ledger accounts', async () => {
    const rows = await withTenantTransaction(ctx.app, tenantA, async (c) => {
      const res = await c.query<{ tenant_id: string }>('SELECT tenant_id FROM ledger_accounts');
      return res.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);
  });

  it('without tenant context the app role sees NOTHING', async () => {
    const client = await ctx.app.connect();
    try {
      const res = await client.query('SELECT count(*)::int AS n FROM ledger_accounts');
      expect(res.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  it('WITH CHECK blocks inserting rows for another tenant (tenant escape)', async () => {
    await expect(
      withTenantTransaction(ctx.app, tenantA, (c) =>
        c.query(
          `INSERT INTO ledger_accounts (tenant_id, name, currency, normal_side)
           VALUES ($1, 'evil', 'USD', 'credit')`,
          [tenantB]
        )
      )
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('a tenant cannot read another tenant row even by primary key', async () => {
    const accB = await withTenantTransaction(ctx.app, tenantB, async (c) => {
      const res = await c.query<{ id: string }>('SELECT id FROM ledger_accounts LIMIT 1');
      return res.rows[0]!.id;
    });
    const visible = await withTenantTransaction(ctx.app, tenantA, async (c) => {
      const res = await c.query('SELECT id FROM ledger_accounts WHERE id = $1', [accB]);
      return res.rowCount;
    });
    expect(visible).toBe(0);
  });
});

describe('database-level immutability (Directiva A.4)', () => {
  it('DELETE is forbidden even for the admin/superuser role', async () => {
    await expect(ctx.admin.query('DELETE FROM ledger_accounts')).rejects.toThrow(
      /FLUVIA_IMMUTABLE/
    );
    await expect(ctx.admin.query('DELETE FROM tenants')).rejects.toThrow(/FLUVIA_IMMUTABLE/);
  });

  it('TRUNCATE is forbidden', async () => {
    await expect(ctx.admin.query('TRUNCATE ledger_entries')).rejects.toThrow(/FLUVIA_IMMUTABLE/);
  });

  it('UPDATE on ledger_entries is forbidden (append-only ledger)', async () => {
    // No necesitamos filas: un UPDATE masivo debe fallar en cuanto toque una.
    // Creamos una entrada minima via transaccion contable manual del admin.
    const t = await ctx.createTenant();
    const acc1 = await ctx.createLedgerAccount({
      tenantId: t, name: 'a1', currency: 'USD', normalSide: 'debit',
    });
    const acc2 = await ctx.createLedgerAccount({
      tenantId: t, name: 'a2', currency: 'USD', normalSide: 'credit',
    });
    await withTenantTransaction(ctx.app, t, async (c) => {
      const tx = await c.query<{ id: string }>(
        `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason)
         VALUES ($1, 'immutability-probe', 'adjustment') RETURNING id`,
        [t]
      );
      await c.query(
        `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
         VALUES ($1, $2, $3, 'debit', 100, 'USD', 'adjustment'),
                ($1, $2, $4, 'credit', 100, 'USD', 'adjustment')`,
        [t, tx.rows[0]!.id, acc1, acc2]
      );
    });
    await expect(
      withTenantTransaction(ctx.app, t, (c) => c.query('UPDATE ledger_entries SET amount = 1'))
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
  });
});

describe('authenticate_api_key', () => {
  it('resolves tenant from key hash without tenant context', async () => {
    const key = await ctx.createApiKey(tenantA);
    const { hashApiKey } = await import('../src/testing.js');
    const client = await ctx.app.connect();
    try {
      const res = await client.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM authenticate_api_key($1)',
        [hashApiKey(key)]
      );
      expect(res.rows[0]?.tenant_id).toBe(tenantA);
    } finally {
      client.release();
    }
  });

  it('rejects unknown keys', async () => {
    const client = await ctx.app.connect();
    try {
      const res = await client.query('SELECT * FROM authenticate_api_key($1)', ['nope']);
      expect(res.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
