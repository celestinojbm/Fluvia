import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@fluvia/money';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  AccountCurrencyMismatchError,
  AccountNotFoundError,
  IdempotencyConflictError,
  InvalidEntriesError,
  LedgerAccountExistsError,
  LedgerService,
  UnbalancedLedgerError,
} from '../src/index.js';

let ctx: TestContext;
let ledger: LedgerService;
let org: string;
let clearing: string; // USD, debit-normal (activo)
let merchant: string; // USD, credit-normal (pasivo)
let fees: string; // USD, credit-normal (ingreso)

const key = () => `ltx-${randomUUID()}`;
const usd = (minor: number | bigint) => Money.of(minor, 'USD');

function transfer(amount: number, from: string, to: string) {
  return [
    { accountId: from, direction: 'debit' as const, amount: usd(amount) },
    { accountId: to, direction: 'credit' as const, amount: usd(amount) },
  ];
}

beforeAll(async () => {
  ctx = await createTestContext();
  ledger = new LedgerService(ctx.app);
  org = await ctx.createTenant('Ledger Service Org');
  clearing = (
    await ledger.createAccount({
      tenantId: org,
      name: 'provider.clearing',
      currency: 'USD',
      normalSide: 'debit',
    })
  ).id;
  merchant = (
    await ledger.createAccount({
      tenantId: org,
      name: 'merchant.available',
      currency: 'USD',
      normalSide: 'credit',
    })
  ).id;
  fees = (
    await ledger.createAccount({
      tenantId: org,
      name: 'platform.fees',
      currency: 'USD',
      normalSide: 'credit',
    })
  ).id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('createAccount', () => {
  it('creates account + projection atomically and rejects duplicates', async () => {
    const acc = await ledger.createAccount({
      tenantId: org,
      name: 'merchant.pending',
      currency: 'USD',
      normalSide: 'credit',
    });
    const balance = await ledger.getBalance(org, acc.id);
    expect(balance).toMatchObject({ available: '0', pending: '0' });
    await expect(
      ledger.createAccount({
        tenantId: org,
        name: 'merchant.pending',
        currency: 'USD',
        normalSide: 'credit',
      })
    ).rejects.toThrow(LedgerAccountExistsError);
  });
});

describe('postTransaction — camino feliz', () => {
  it('posts a capture with fees split and updates projections per normal side', async () => {
    const result = await ledger.postTransaction({
      tenantId: org,
      idempotencyKey: key(),
      reason: 'payment',
      source: { type: 'payment_attempt', id: randomUUID() },
      entries: [
        { accountId: clearing, direction: 'debit', amount: usd(10_000) },
        { accountId: merchant, direction: 'credit', amount: usd(9_700) },
        { accountId: fees, direction: 'credit', amount: usd(300) },
      ],
    });
    expect(result.replayed).toBe(false);
    expect(result.entries).toHaveLength(3);

    const [cBal, mBal, fBal] = await Promise.all([
      ledger.getBalance(org, clearing),
      ledger.getBalance(org, merchant),
      ledger.getBalance(org, fees),
    ]);
    // debit-normal: un debito incrementa; credit-normal: un credito incrementa.
    expect(BigInt(cBal.available)).toBeGreaterThanOrEqual(10_000n);
    expect(BigInt(mBal.available)).toBeGreaterThanOrEqual(9_700n);
    expect(BigInt(fBal.available)).toBeGreaterThanOrEqual(300n);

    // Outbox en la misma transaccion.
    const outbox = await ctx.admin.query(
      `SELECT payload FROM outbox_events
       WHERE tenant_id = $1 AND topic = 'ledger.transaction.posted'
         AND payload->>'transaction_id' = $2`,
      [org, result.transactionId]
    );
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0]!.payload.entries).toHaveLength(3);
  });

  it('pending bucket entries update the pending projection column', async () => {
    const pendingAcc = await ledger.createAccount({
      tenantId: org,
      name: `merchant.pending-${randomUUID().slice(0, 6)}`,
      currency: 'USD',
      normalSide: 'credit',
    });
    await ledger.postTransaction({
      tenantId: org,
      idempotencyKey: key(),
      reason: 'payment',
      source: { type: 'payment_attempt', id: randomUUID() },
      entries: [
        { accountId: clearing, direction: 'debit', amount: usd(500), bucket: 'pending' },
        { accountId: pendingAcc.id, direction: 'credit', amount: usd(500), bucket: 'pending' },
      ],
    });
    const bal = await ledger.getBalance(org, pendingAcc.id);
    expect(bal.pending).toBe('500');
    expect(bal.available).toBe('0');
  });
});

describe('validacion previa', () => {
  it('rejects unbalanced, tiny, empty and sourceless inputs before touching the DB', async () => {
    await expect(
      ledger.postTransaction({
        tenantId: org,
        idempotencyKey: key(),
        reason: 'payment',
        source: { type: 'x', id: 'y' },
        entries: [
          { accountId: clearing, direction: 'debit', amount: usd(100) },
          { accountId: merchant, direction: 'credit', amount: usd(99) },
        ],
      })
    ).rejects.toThrow(UnbalancedLedgerError);

    await expect(
      ledger.postTransaction({
        tenantId: org,
        idempotencyKey: key(),
        reason: 'payment',
        source: { type: 'x', id: 'y' },
        entries: [{ accountId: clearing, direction: 'debit', amount: usd(100) }],
      })
    ).rejects.toThrow(InvalidEntriesError);

    await expect(
      ledger.postTransaction({
        tenantId: org,
        idempotencyKey: key(),
        reason: 'payment',
        source: { type: '', id: '' },
        entries: transfer(100, clearing, merchant),
      })
    ).rejects.toThrow(InvalidEntriesError);
  });

  it('rejects currency mismatch against the account and unknown accounts', async () => {
    const cop = await ledger.createAccount({
      tenantId: org,
      name: `cop-acc-${randomUUID().slice(0, 6)}`,
      currency: 'COP',
      normalSide: 'credit',
    });
    await expect(
      ledger.postTransaction({
        tenantId: org,
        idempotencyKey: key(),
        reason: 'payment',
        source: { type: 'x', id: 'y' },
        entries: [
          { accountId: clearing, direction: 'debit', amount: usd(100) },
          { accountId: cop.id, direction: 'credit', amount: usd(100) },
        ],
      })
    ).rejects.toThrow(AccountCurrencyMismatchError);

    await expect(
      ledger.postTransaction({
        tenantId: org,
        idempotencyKey: key(),
        reason: 'payment',
        source: { type: 'x', id: 'y' },
        entries: transfer(100, clearing, randomUUID()),
      })
    ).rejects.toThrow(AccountNotFoundError);
  });

  it('cross-tenant accounts are invisible (RLS) and read as not-found', async () => {
    const otherOrg = await ctx.createTenant('Ledger Other Org');
    await expect(
      ledger.postTransaction({
        tenantId: otherOrg,
        idempotencyKey: key(),
        reason: 'payment',
        source: { type: 'x', id: 'y' },
        entries: transfer(100, clearing, merchant),
      })
    ).rejects.toThrow(AccountNotFoundError);
  });
});

describe('idempotencia del asiento', () => {
  it('replays the exact same request without double-applying balances', async () => {
    const idem = key();
    const input = {
      tenantId: org,
      idempotencyKey: idem,
      reason: 'transfer' as const,
      source: { type: 'manual', id: 'replay-test' },
      entries: transfer(1_111, clearing, merchant),
    };
    const before = await ledger.getBalance(org, merchant);
    const first = await ledger.postTransaction(input);
    const second = await ledger.postTransaction(input);
    expect(second.replayed).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    const after = await ledger.getBalance(org, merchant);
    expect(BigInt(after.available) - BigInt(before.available)).toBe(1_111n);

    const outbox = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM outbox_events
       WHERE payload->>'transaction_id' = $1`,
      [first.transactionId]
    );
    expect(outbox.rows[0]!.n).toBe(1);
  });

  it('rejects key reuse with a DIFFERENT payload', async () => {
    const idem = key();
    await ledger.postTransaction({
      tenantId: org,
      idempotencyKey: idem,
      reason: 'transfer',
      source: { type: 'manual', id: 'conflict-test' },
      entries: transfer(200, clearing, merchant),
    });
    await expect(
      ledger.postTransaction({
        tenantId: org,
        idempotencyKey: idem,
        reason: 'transfer',
        source: { type: 'manual', id: 'conflict-test' },
        entries: transfer(999, clearing, merchant),
      })
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('N concurrent posts with the same key apply exactly once', async () => {
    const idem = key();
    const input = () => ({
      tenantId: org,
      idempotencyKey: idem,
      reason: 'transfer' as const,
      source: { type: 'manual', id: 'race-test' },
      entries: transfer(777, clearing, merchant),
    });
    const before = await ledger.getBalance(org, merchant);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ledger.postTransaction(input()))
    );
    const after = await ledger.getBalance(org, merchant);
    expect(BigInt(after.available) - BigInt(before.available)).toBe(777n);
    const ids = new Set(results.map((r) => r.transactionId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });
});

describe('concurrencia (smoke; la suite de carga formal es F2-08)', () => {
  it('25 concurrent transfers with randomized account order keep projections exact', async () => {
    const accounts = [clearing, merchant, fees];
    const jobs = Array.from({ length: 25 }, (_, i) => {
      const from = accounts[i % 3]!;
      const to = accounts[(i + 1) % 3]!;
      return ledger.postTransaction({
        tenantId: org,
        idempotencyKey: key(),
        reason: 'transfer',
        source: { type: 'manual', id: `smoke-${i}` },
        entries:
          i % 2 === 0
            ? transfer(10 + i, from, to)
            : [
                { accountId: to, direction: 'credit' as const, amount: usd(10 + i) },
                { accountId: from, direction: 'debit' as const, amount: usd(10 + i) },
              ],
      });
    });
    const results = await Promise.all(jobs);
    expect(results).toHaveLength(25);

    // Audit-replay: proyeccion == recomputo desde entries para cada cuenta.
    for (const accountId of accounts) {
      const check = await ledger.verifyProjection(org, accountId);
      expect(check.matches, `drift en ${accountId}: ${JSON.stringify(check)}`).toBe(true);
    }
  });
});
