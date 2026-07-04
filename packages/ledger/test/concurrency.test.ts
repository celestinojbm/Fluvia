import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@fluvia/money';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService } from '../src/index.js';

/**
 * F2-08 — Suite FORMAL de concurrencia del ledger (Gate Ledger, V4 §17.7).
 *
 * Reproducibilidad: PRNG determinista (mulberry32) con seed fija; para
 * reproducir una corrida basta la seed (se loggea al inicio). La baseline
 * de duracion se documenta en STATE.md; aqui NO se afirma performance
 * (CI es variable), solo CORRECCION bajo contencion.
 */

const SEED = Number(process.env.LEDGER_CONCURRENCY_SEED ?? 20260704);
const TRANSFERS = Number(process.env.LEDGER_CONCURRENCY_TRANSFERS ?? 120);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let ctx: TestContext;
let ledger: LedgerService;
let org: string;
let accounts: string[] = [];

const usd = (minor: number | bigint) => Money.of(minor, 'USD');

beforeAll(async () => {
  ctx = await createTestContext();
  ledger = new LedgerService(ctx.app);
  org = await ctx.createTenant('Concurrency Org');
  accounts = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      ledger
        .createAccount({
          tenantId: org,
          name: `conc.${i}`,
          currency: 'USD',
          normalSide: i % 2 === 0 ? 'debit' : 'credit',
        })
        .then((a) => a.id)
    )
  );
  // eslint-disable-next-line no-console
  console.log(`[F2-08] seed=${SEED} transfers=${TRANSFERS}`);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

/** Conservacion + consistencia total del tenant (se usa al final de cada test). */
async function assertLedgerConsistent() {
  // 1. Toda (tx, moneda) del tenant balancea (redundante con el trigger; barato).
  const unbalanced = await ctx.admin.query(
    `SELECT tx_root_id FROM ledger_entries WHERE tenant_id = $1
     GROUP BY tx_root_id, currency
     HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0`,
    [org]
  );
  expect(unbalanced.rows).toEqual([]);
  // 2. Proyeccion == recomputo para TODAS las cuentas del tenant.
  for (const accountId of accounts) {
    const check = await ledger.verifyProjection(org, accountId);
    expect(check.matches, `drift en ${accountId}: ${JSON.stringify(check)}`).toBe(true);
  }
}

describe('F2-08: concurrencia formal (Gate Ledger)', () => {
  it(`${TRANSFERS} concurrent seeded-random transfers: no losses, no drift, exact conservation`, async () => {
    const rnd = mulberry32(SEED);
    const started = Date.now();
    const jobs = Array.from({ length: TRANSFERS }, (_, i) => {
      const from = accounts[Math.floor(rnd() * accounts.length)]!;
      let to = accounts[Math.floor(rnd() * accounts.length)]!;
      if (to === from) to = accounts[(accounts.indexOf(from) + 1) % accounts.length]!;
      const amount = 1 + Math.floor(rnd() * 100_000);
      const bucket = rnd() < 0.2 ? ('pending' as const) : ('available' as const);
      return ledger.postTransaction({
        tenantId: org,
        idempotencyKey: `conc-${SEED}-${i}-${randomUUID()}`,
        reason: 'transfer',
        source: { type: 'load', id: `seeded-${i}` },
        entries: [
          { accountId: from, direction: 'debit', amount: usd(amount), bucket },
          { accountId: to, direction: 'credit', amount: usd(amount), bucket },
        ],
      });
    });
    const results = await Promise.all(jobs);
    const elapsed = Date.now() - started;
    expect(results).toHaveLength(TRANSFERS);
    expect(results.every((r) => !r.replayed)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(
      `[F2-08] ${TRANSFERS} postings in ${elapsed}ms (${Math.round((TRANSFERS / elapsed) * 1000)} tx/s)`
    );
    await assertLedgerConsistent();
  }, 60_000);

  it('deadlock pressure: opposing pair transfers (A<->B) all complete exactly once', async () => {
    const [a, b] = [accounts[0]!, accounts[1]!];
    const before = await ledger.getBalance(org, a);
    const N = 40; // 20 A->B y 20 B->A intercalados, mismo par de cuentas
    const jobs = Array.from({ length: N }, (_, i) =>
      ledger.postTransaction({
        tenantId: org,
        idempotencyKey: `dl-${SEED}-${i}-${randomUUID()}`,
        reason: 'transfer',
        source: { type: 'load', id: `deadlock-${i}` },
        entries:
          i % 2 === 0
            ? [
                { accountId: a, direction: 'debit' as const, amount: usd(11) },
                { accountId: b, direction: 'credit' as const, amount: usd(11) },
              ]
            : [
                { accountId: b, direction: 'debit' as const, amount: usd(7) },
                { accountId: a, direction: 'credit' as const, amount: usd(7) },
              ],
      })
    );
    const results = await Promise.all(jobs);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(N);

    // a es debit-normal: +11 por cada par (i par), -7 por cada credito (i impar).
    const after = await ledger.getBalance(org, a);
    expect(BigInt(after.available) - BigInt(before.available)).toBe(
      BigInt((N / 2) * 11 - (N / 2) * 7)
    );
    await assertLedgerConsistent();
  }, 60_000);

  it('mass idempotency race: M keys x K concurrent posts each => exactly M applied', async () => {
    const M = 10;
    const K = 5;
    const [a, b] = [accounts[2]!, accounts[3]!];
    const before = await ledger.getBalance(org, b);
    const jobs: Promise<{ transactionId: string; replayed: boolean }>[] = [];
    for (let m = 0; m < M; m += 1) {
      const idem = `mass-${SEED}-${m}-${randomUUID()}`;
      for (let k = 0; k < K; k += 1) {
        jobs.push(
          ledger.postTransaction({
            tenantId: org,
            idempotencyKey: idem,
            reason: 'transfer',
            source: { type: 'load', id: `mass-${m}` },
            entries: [
              { accountId: a, direction: 'debit', amount: usd(100) },
              { accountId: b, direction: 'credit', amount: usd(100) },
            ],
          })
        );
      }
    }
    const results = await Promise.all(jobs);
    expect(results.filter((r) => !r.replayed)).toHaveLength(M);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(M);
    const after = await ledger.getBalance(org, b);
    expect(BigInt(after.available) - BigInt(before.available)).toBe(BigInt(M * 100));
    await assertLedgerConsistent();
  }, 60_000);

  it('mixed pressure: postings + rebuilds + a reversal racing => final state consistent', async () => {
    const [a, b] = [accounts[4]!, accounts[5]!];
    const target = await ledger.postTransaction({
      tenantId: org,
      idempotencyKey: `mix-target-${SEED}-${randomUUID()}`,
      reason: 'payment',
      source: { type: 'load', id: 'mix-target' },
      entries: [
        { accountId: a, direction: 'debit', amount: usd(5_000) },
        { accountId: b, direction: 'credit', amount: usd(5_000) },
      ],
    });

    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i += 1) {
      jobs.push(
        ledger.postTransaction({
          tenantId: org,
          idempotencyKey: `mix-${SEED}-${i}-${randomUUID()}`,
          reason: 'transfer',
          source: { type: 'load', id: `mix-${i}` },
          entries: [
            { accountId: a, direction: 'debit', amount: usd(10 + i) },
            { accountId: b, direction: 'credit', amount: usd(10 + i) },
          ],
        })
      );
      if (i % 4 === 0) jobs.push(ledger.rebuildProjection(org, i % 8 === 0 ? a : b));
    }
    jobs.push(
      ledger.reverseTransaction({
        tenantId: org,
        transactionId: target.transactionId,
        idempotencyKey: `mix-rev-${SEED}-${randomUUID()}`,
        source: { type: 'incident', id: 'mix-reversal' },
        note: 'concurrency suite reversal',
      })
    );
    await Promise.all(jobs);
    await assertLedgerConsistent();
  }, 60_000);
});
