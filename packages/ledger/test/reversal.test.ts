import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@fluvia/money';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  CannotReverseReversalError,
  InsufficientBalanceError,
  LedgerService,
  ReversalNoteRequiredError,
  TransactionAlreadyReversedError,
  TransactionNotFoundError,
} from '../src/index.js';

let ctx: TestContext;
let ledger: LedgerService;
let org: string;
let clearing: string;
let merchant: string;
let fees: string;

const usd = (minor: number) => Money.of(minor, 'USD');
const key = () => `rev-${randomUUID()}`;

async function capture(amount: number, fee: number) {
  return ledger.postTransaction({
    tenantId: org,
    idempotencyKey: key(),
    reason: 'payment',
    source: { type: 'payment_attempt', id: randomUUID() },
    entries: [
      { accountId: clearing, direction: 'debit' as const, amount: usd(amount) },
      { accountId: merchant, direction: 'credit' as const, amount: usd(amount - fee) },
      // Montos cero son irrepresentables en el ledger: sin fee, sin linea.
      ...(fee > 0 ? [{ accountId: fees, direction: 'credit' as const, amount: usd(fee) }] : []),
    ],
  });
}

async function balances() {
  const [c, m, f] = await Promise.all([
    ledger.getBalance(org, clearing),
    ledger.getBalance(org, merchant),
    ledger.getBalance(org, fees),
  ]);
  return { clearing: c.available, merchant: m.available, fees: f.available };
}

beforeAll(async () => {
  ctx = await createTestContext();
  ledger = new LedgerService(ctx.app);
  org = await ctx.createTenant('Reversal Org');
  const mk = (name: string, side: 'debit' | 'credit') =>
    ledger
      .createAccount({ tenantId: org, name, currency: 'USD', normalSide: side })
      .then((a) => a.id);
  clearing = await mk('rev.clearing', 'debit');
  merchant = await mk('rev.merchant', 'credit');
  fees = await mk('rev.fees', 'credit');
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('F2-07: reverseTransaction (Gate Ledger — compensaciones)', () => {
  it('GOLDEN: reversal mirrors every entry, nets balances to the prior state and links reverses_tx_id', async () => {
    const before = await balances();
    const original = await capture(10_000, 300);
    const requestId = `revreq-${randomUUID()}`;

    const reversal = await ledger.reverseTransaction({
      tenantId: org,
      transactionId: original.transactionId,
      idempotencyKey: key(),
      source: { type: 'incident', id: 'inc-42' },
      note: 'operator error: duplicate manual capture',
      audit: { actorType: 'user', actorId: randomUUID(), requestId },
    });

    // Suma neta exacta: los balances vuelven al estado previo.
    expect(await balances()).toEqual(before);
    expect(reversal.replayed).toBe(false);
    expect(reversal.entries).toHaveLength(3);

    // Asiento espejo: misma magnitud/moneda, direccion opuesta, y enlace causal.
    const link = await ctx.admin.query<{ reverses_tx_id: string; reason: string }>(
      `SELECT reverses_tx_id, reason FROM ledger_transactions WHERE id = $1`,
      [reversal.transactionId]
    );
    expect(link.rows[0]!.reverses_tx_id).toBe(original.transactionId);
    expect(link.rows[0]!.reason).toBe('reversal');
    const mirrored = reversal.entries.find((e) => e.accountId === clearing);
    expect(mirrored).toMatchObject({ direction: 'credit', amount: '10000' });

    // Auditoria EN la misma transaccion, con la razon humana.
    const audit = await ctx.admin.query<{ reason: string; risk_level: string }>(
      `SELECT reason, risk_level FROM audit_events
       WHERE action = 'ledger.transaction_reversed' AND resource_id = $1 AND request_id = $2`,
      [original.transactionId, requestId]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.reason).toMatch(/duplicate manual capture/);
    expect(audit.rows[0]!.risk_level).toBe('high');

    // Outbox: el evento del reversal viaja con reverses_tx_id en data.
    const outbox = await ctx.admin.query<{ payload: { data: { reverses_tx_id: string } } }>(
      `SELECT payload FROM outbox_events WHERE payload->'data'->>'transaction_id' = $1`,
      [reversal.transactionId]
    );
    expect(outbox.rows[0]!.payload.data.reverses_tx_id).toBe(original.transactionId);
  });

  it('is idempotent: same reversal key replays without double effect or duplicate audit', async () => {
    const original = await capture(2_000, 0);
    const idem = key();
    const input = {
      tenantId: org,
      transactionId: original.transactionId,
      idempotencyKey: idem,
      source: { type: 'incident', id: 'inc-idem' },
      note: 'idempotency check',
    };
    const first = await ledger.reverseTransaction(input);
    const after = await balances();
    const second = await ledger.reverseTransaction(input);
    expect(second.replayed).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await balances()).toEqual(after);

    const audits = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE action = 'ledger.transaction_reversed' AND resource_id = $1`,
      [original.transactionId]
    );
    expect(audits.rows[0]!.n).toBe(1);
  });

  it('ENGINE: a transaction can be reversed at most once — concurrent race decided by the unique index', async () => {
    const original = await capture(5_000, 100);
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        ledger.reverseTransaction({
          tenantId: org,
          transactionId: original.transactionId,
          idempotencyKey: key(), // claves DISTINTAS: 4 reversiones "legitimas" compitiendo
          source: { type: 'incident', id: `race-${i}` },
          note: 'race attempt',
        })
      )
    );
    const ok = attempts.filter((r) => r.status === 'fulfilled');
    const failed = attempts.filter(
      (r) => r.status === 'rejected' && r.reason instanceof TransactionAlreadyReversedError
    );
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(3);

    // Y despues de la carrera, un intento secuencial tambien es rechazado.
    await expect(
      ledger.reverseTransaction({
        tenantId: org,
        transactionId: original.transactionId,
        idempotencyKey: key(),
        source: { type: 'incident', id: 'post-race' },
        note: 'too late',
      })
    ).rejects.toThrow(TransactionAlreadyReversedError);
  });

  it('refuses to reverse a reversal, an unknown tx, a cross-tenant tx, and an empty note', async () => {
    const original = await capture(1_000, 0);
    const reversal = await ledger.reverseTransaction({
      tenantId: org,
      transactionId: original.transactionId,
      idempotencyKey: key(),
      source: { type: 'incident', id: 'chain' },
      note: 'first reversal',
    });
    await expect(
      ledger.reverseTransaction({
        tenantId: org,
        transactionId: reversal.transactionId,
        idempotencyKey: key(),
        source: { type: 'incident', id: 'chain-2' },
        note: 'reversal of reversal',
      })
    ).rejects.toThrow(CannotReverseReversalError);

    await expect(
      ledger.reverseTransaction({
        tenantId: org,
        transactionId: randomUUID(),
        idempotencyKey: key(),
        source: { type: 'incident', id: 'ghost' },
        note: 'ghost',
      })
    ).rejects.toThrow(TransactionNotFoundError);

    // Cross-tenant: invisible via RLS => indistinguible de inexistente.
    const otherOrg = await ctx.createTenant('Reversal Other Org');
    await expect(
      ledger.reverseTransaction({
        tenantId: otherOrg,
        transactionId: original.transactionId,
        idempotencyKey: key(),
        source: { type: 'incident', id: 'cross' },
        note: 'cross-tenant probe',
      })
    ).rejects.toThrow(TransactionNotFoundError);

    await expect(
      ledger.reverseTransaction({
        tenantId: org,
        transactionId: original.transactionId,
        idempotencyKey: key(),
        source: { type: 'incident', id: 'no-note' },
        note: '   ',
      })
    ).rejects.toThrow(ReversalNoteRequiredError);
  });

  it('reverses pending-bucket entries in the pending bucket', async () => {
    const pendingAcc = (
      await ledger.createAccount({
        tenantId: org,
        name: 'rev.pending',
        currency: 'USD',
        normalSide: 'credit',
      })
    ).id;
    const tx = await ledger.postTransaction({
      tenantId: org,
      idempotencyKey: key(),
      reason: 'payment',
      source: { type: 'payment_attempt', id: randomUUID() },
      entries: [
        { accountId: clearing, direction: 'debit', amount: usd(400), bucket: 'pending' },
        { accountId: pendingAcc, direction: 'credit', amount: usd(400), bucket: 'pending' },
      ],
    });
    expect((await ledger.getBalance(org, pendingAcc)).pending).toBe('400');
    await ledger.reverseTransaction({
      tenantId: org,
      transactionId: tx.transactionId,
      idempotencyKey: key(),
      source: { type: 'incident', id: 'pending-rev' },
      note: 'reverse pending capture',
    });
    const bal = await ledger.getBalance(org, pendingAcc);
    expect(bal.pending).toBe('0');
    expect(bal.available).toBe('0');
  });

  it('SECURITY (F6): a reversal cannot drive a PROTECTED account negative (nonNegativeAccounts guard)', async () => {
    // Cuentas con nombres DEL CHART (protegidas) — el guard solo cubre esas, no
    // las `rev.*` fuera de chart de los otros tests.
    const merchantId = randomUUID();
    const pending = (
      await ledger.createAccount({
        tenantId: org,
        name: `merchant.pending:${merchantId}`,
        currency: 'USD',
        normalSide: 'credit',
      })
    ).id;
    const clearingAcc = (
      await ledger.createAccount({
        tenantId: org,
        name: `provider.clearing:${randomUUID()}`,
        currency: 'USD',
        normalSide: 'debit',
      })
    ).id;

    // Captura: acredita merchant.pending (pending sube a 5000).
    const original = await ledger.postTransaction({
      tenantId: org,
      idempotencyKey: key(),
      reason: 'payment',
      source: { type: 'payment_attempt', id: randomUUID() },
      entries: [
        { accountId: clearingAcc, direction: 'debit', amount: usd(5_000) },
        { accountId: pending, direction: 'credit', amount: usd(5_000) },
      ],
    });
    expect((await ledger.getBalance(org, pending)).available).toBe('5000');

    // El pending se drena (settlement → available/payout): vuelve a 0.
    await ledger.postTransaction({
      tenantId: org,
      idempotencyKey: key(),
      reason: 'settlement',
      source: { type: 'incident', id: 'drain' },
      entries: [
        { accountId: pending, direction: 'debit', amount: usd(5_000) },
        { accountId: clearingAcc, direction: 'credit', amount: usd(5_000) },
      ],
    });
    expect((await ledger.getBalance(org, pending)).available).toBe('0');

    // Revertir la captura debitaría merchant.pending por 5000 sobre saldo 0 →
    // NEGATIVO. El guard derivado del espejo lo BLOQUEA (antes commiteaba negativo).
    await expect(
      ledger.reverseTransaction({
        tenantId: org,
        transactionId: original.transactionId,
        idempotencyKey: key(),
        source: { type: 'incident', id: 'unsafe-reversal' },
        note: 'reversal after pending drained',
      })
    ).rejects.toThrow(InsufficientBalanceError);

    // La reversión abortó: el pending sigue en 0, sin rastro negativo.
    expect((await ledger.getBalance(org, pending)).available).toBe('0');
  });
});
