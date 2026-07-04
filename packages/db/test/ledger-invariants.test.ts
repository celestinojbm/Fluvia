import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction, type PoolClient } from '../src/index.js';
import { createTestContext, type TestContext } from '../src/testing.js';

/**
 * F2-02 — Invariantes del ledger A NIVEL DE MOTOR (Gate Ledger, V4 §51).
 * Estas pruebas NO usan ningun servicio: SQL crudo, incluido el superusuario,
 * para demostrar que la base de datos por si sola rechaza asientos invalidos.
 */

let ctx: TestContext;
let org: string;
let usdDebit: string;
let usdCredit: string;
let copDebit: string;
let copCredit: string;

interface EntrySpec {
  account: string;
  direction: 'debit' | 'credit';
  amount: number;
  currency: string;
}

async function insertTx(client: PoolClient, tenantId: string, entries: EntrySpec[]) {
  const tx = await client.query<{ id: string }>(
    `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason, source_type, source_id)
     VALUES ($1, $2, 'adjustment', 'manual', $3) RETURNING id`,
    [tenantId, `inv-${randomUUID()}`, `test-${randomUUID().slice(0, 8)}`]
  );
  for (const e of entries) {
    await client.query(
      `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'adjustment')`,
      [tenantId, tx.rows[0]!.id, e.account, e.direction, e.amount, e.currency]
    );
  }
  return tx.rows[0]!.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  org = await ctx.createTenant('Ledger Invariants Org');
  const mk = (name: string, currency: string, side: 'debit' | 'credit') =>
    ctx.createLedgerAccount({ tenantId: org, name, currency, normalSide: side });
  usdDebit = await mk('usd-clearing', 'USD', 'debit');
  usdCredit = await mk('usd-merchant', 'USD', 'credit');
  copDebit = await mk('cop-clearing', 'COP', 'debit');
  copCredit = await mk('cop-merchant', 'COP', 'credit');
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('balanceo por (transaccion, moneda) al COMMIT', () => {
  it('a balanced single-currency transaction commits', async () => {
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        insertTx(c, org, [
          { account: usdDebit, direction: 'debit', amount: 1000, currency: 'USD' },
          { account: usdCredit, direction: 'credit', amount: 1000, currency: 'USD' },
        ])
      )
    ).resolves.toBeTruthy();
  });

  it('an unbalanced transaction is IMPOSSIBLE to commit', async () => {
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        insertTx(c, org, [
          { account: usdDebit, direction: 'debit', amount: 1000, currency: 'USD' },
          { account: usdCredit, direction: 'credit', amount: 999, currency: 'USD' },
        ])
      )
    ).rejects.toThrow(/FLUVIA_UNBALANCED/);
    // Rollback total: ni la cabecera ni los asientos sobreviven.
    const leftovers = await ctx.admin.query(
      `SELECT 1 FROM ledger_entries WHERE tenant_id = $1 AND amount = 999`,
      [org]
    );
    expect(leftovers.rowCount).toBe(0);
  });

  it('cross-currency "compensation" is rejected (USD hole cannot be hidden with COP)', async () => {
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        insertTx(c, org, [
          { account: usdDebit, direction: 'debit', amount: 1000, currency: 'USD' },
          { account: copCredit, direction: 'credit', amount: 1000, currency: 'COP' },
        ])
      )
    ).rejects.toThrow(/FLUVIA_UNBALANCED/);
  });

  it('a multi-currency transaction commits when EACH currency balances', async () => {
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        insertTx(c, org, [
          { account: usdDebit, direction: 'debit', amount: 500, currency: 'USD' },
          { account: usdCredit, direction: 'credit', amount: 500, currency: 'USD' },
          { account: copDebit, direction: 'debit', amount: 200000, currency: 'COP' },
          { account: copCredit, direction: 'credit', amount: 200000, currency: 'COP' },
        ])
      )
    ).resolves.toBeTruthy();
  });

  it('even the SUPERUSER cannot commit an unbalanced entry with raw SQL', async () => {
    const client = await ctx.admin.connect();
    try {
      await client.query('BEGIN');
      const tx = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason)
         VALUES ($1, $2, 'adjustment') RETURNING id`,
        [org, `su-${randomUUID()}`]
      );
      await client.query(
        `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
         VALUES ($1, $2, $3, 'debit', 12345, 'USD', 'adjustment')`,
        [org, tx.rows[0]!.id, usdDebit]
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/FLUVIA_UNBALANCED/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('rejects empty transaction headers (no dangling tx without entries)', async () => {
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(
          `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason)
           VALUES ($1, $2, 'adjustment')`,
          [org, `empty-${randomUUID()}`]
        )
      )
    ).rejects.toThrow(/FLUVIA_EMPTY_TRANSACTION/);
  });
});

describe('modelo F2-01: enlace causal, reversion y proyecciones', () => {
  it('reverses_tx_id links a reversal to its original transaction', async () => {
    const originalId = await withTenantTransaction(ctx.app, org, (c) =>
      insertTx(c, org, [
        { account: usdDebit, direction: 'debit', amount: 700, currency: 'USD' },
        { account: usdCredit, direction: 'credit', amount: 700, currency: 'USD' },
      ])
    );
    const reversalId = await withTenantTransaction(ctx.app, org, async (c) => {
      const tx = await c.query<{ id: string }>(
        `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason, reverses_tx_id)
         VALUES ($1, $2, 'reversal', $3) RETURNING id`,
        [org, `rev-${randomUUID()}`, originalId]
      );
      for (const e of [
        { account: usdCredit, direction: 'debit', amount: 700 },
        { account: usdDebit, direction: 'credit', amount: 700 },
      ] as const) {
        await c.query(
          `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
           VALUES ($1, $2, $3, $4, $5, 'USD', 'reversal')`,
          [org, tx.rows[0]!.id, e.account, e.direction, e.amount]
        );
      }
      return tx.rows[0]!.id;
    });
    const linked = await ctx.admin.query(
      'SELECT reverses_tx_id FROM ledger_transactions WHERE id = $1',
      [reversalId]
    );
    expect(linked.rows[0]!.reverses_tx_id).toBe(originalId);

    // FK: no se puede "revertir" una transaccion inexistente.
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(
          `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason, reverses_tx_id)
           VALUES ($1, $2, 'reversal', $3)`,
          [org, `rev-bad-${randomUUID()}`, randomUUID()]
        )
      )
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('ledger_accounts is pure definition: derived balance columns are gone', async () => {
    const cols = await ctx.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ledger_accounts'`
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).not.toContain('balance_available');
    expect(names).not.toContain('balance_pending');
    expect(names).not.toContain('sequence_version');
  });

  it("AUD-P1-001: an entry CANNOT reference another tenant's account (composite FK)", async () => {
    const intruder = await ctx.createTenant('Coherence Intruder Org');
    // Cuenta balanceadora legitima del tenant intruso.
    const ownAccount = await ctx.createLedgerAccount({
      tenantId: intruder,
      name: 'intruder-own',
      currency: 'USD',
      normalSide: 'credit',
    });
    // Incluso el SUPERUSER (sin RLS) choca contra la FK compuesta:
    // (account_id, tenant_id, currency) debe existir EN ledger_accounts.
    const client = await ctx.admin.connect();
    try {
      await client.query('BEGIN');
      const tx = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason)
         VALUES ($1, $2, 'adjustment') RETURNING id`,
        [intruder, `xten-${randomUUID()}`]
      );
      await expect(
        client.query(
          `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
           VALUES ($1, $2, $3, 'debit', 100, 'USD', 'adjustment')`,
          [intruder, tx.rows[0]!.id, usdDebit] // usdDebit pertenece a OTRO tenant
        )
      ).rejects.toThrow(/ledger_entries_account_coherence_fk/);
      await client.query('ROLLBACK');

      // La misma cuenta en su PROPIO tenant si funciona (sanidad del FK).
      await client.query('BEGIN');
      const ok = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (tenant_id, idempotency_key, reason)
         VALUES ($1, $2, 'adjustment') RETURNING id`,
        [intruder, `xten-ok-${randomUUID()}`]
      );
      await client.query(
        `INSERT INTO ledger_entries (tenant_id, tx_root_id, account_id, direction, amount, currency, reason)
         VALUES ($1, $2, $3, 'debit', 100, 'USD', 'adjustment'),
                ($1, $2, $4, 'credit', 100, 'USD', 'adjustment')`,
        [intruder, ok.rows[0]!.id, ownAccount, ownAccount]
      );
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('AUD-P1-001: an entry whose currency differs from its account is rejected', async () => {
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        insertTx(c, org, [
          // usdDebit es una cuenta USD: un asiento COP contra ella es incoherente.
          { account: usdDebit, direction: 'debit', amount: 5000, currency: 'COP' },
          { account: copCredit, direction: 'credit', amount: 5000, currency: 'COP' },
        ])
      )
    ).rejects.toThrow(/ledger_entries_account_coherence_fk/);
  });

  it('AUD-P1-009: idempotency keys are scoped per endpoint (same key, two endpoints)', async () => {
    const key = `idem-${randomUUID()}`;
    await withTenantTransaction(ctx.app, org, async (c) => {
      await c.query(
        `INSERT INTO idempotency_keys (tenant_id, endpoint, key, request_hash)
         VALUES ($1, 'POST /v1/payments', $2, 'fp-a')`,
        [org, key]
      );
      await c.query(
        `INSERT INTO idempotency_keys (tenant_id, endpoint, key, request_hash)
         VALUES ($1, 'POST /v1/refunds', $2, 'fp-b')`,
        [org, key]
      );
    });
    // Mismo (tenant, endpoint, key) por segunda vez -> conflicto de PK.
    await expect(
      withTenantTransaction(ctx.app, org, (c) =>
        c.query(
          `INSERT INTO idempotency_keys (tenant_id, endpoint, key, request_hash)
           VALUES ($1, 'POST /v1/payments', $2, 'fp-c')`,
          [org, key]
        )
      )
    ).rejects.toThrow(/duplicate key|idempotency_keys_pkey/);
  });

  it('balance_projections is tenant-isolated and append-protected', async () => {
    await withTenantTransaction(ctx.app, org, (c) =>
      c.query(
        `INSERT INTO balance_projections (account_id, tenant_id) VALUES ($1, $2)
         ON CONFLICT (account_id) DO NOTHING`,
        [usdDebit, org]
      )
    );
    const other = await ctx.createTenant('Projections Other Org');
    const visible = await withTenantTransaction(ctx.app, other, async (c) => {
      const res = await c.query('SELECT 1 FROM balance_projections WHERE account_id = $1', [
        usdDebit,
      ]);
      return res.rowCount;
    });
    expect(visible).toBe(0);
    await expect(ctx.admin.query('DELETE FROM balance_projections')).rejects.toThrow(
      /FLUVIA_IMMUTABLE/
    );
  });
});
