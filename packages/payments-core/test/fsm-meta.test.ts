import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  ATTEMPT_STATUSES,
  ATTEMPT_TRANSITIONS,
  CHECKOUT_SESSION_STATUSES,
  CHECKOUT_SESSION_TRANSITIONS,
  INTENT_STATUSES,
  INTENT_TRANSITIONS,
  PAYOUT_STATUSES,
  PAYOUT_TRANSITIONS,
  REFUND_STATUSES,
  REFUND_TRANSITIONS,
  transitionPairs,
} from '../src/index.js';

/**
 * Meta-test FSM (AUD-P2-011): las TRES copias de la máquina de estados —
 * doc (mermaid), mapa TS y tablas DDL — deben ser IDÉNTICAS, y el MOTOR debe
 * rechazar la matriz completa de transiciones ilegales incluso con SQL de
 * superusuario. Si alguien toca una sin las otras, esta suite revienta.
 */

const DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'architecture',
  'payment-state-machines.md'
);

/** Extrae los pares "a --> b" del mermaid de UNA sección `## N. ...` del doc. */
function docPairs(sectionHeading: string): Array<[string, string]> {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const start = doc.indexOf(`## ${sectionHeading}`);
  if (start < 0) throw new Error(`section not found: ${sectionHeading}`);
  const rest = doc.slice(start);
  const end = rest.indexOf('\n## ', 3);
  const section = end > 0 ? rest.slice(0, end) : rest;
  const pairs: Array<[string, string]> = [];
  for (const m of section.matchAll(/^\s+(\w+) --> (\w+)/gm)) {
    pairs.push([m[1]!, m[2]!]);
  }
  return pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

let ctx: TestContext;
let org: string;
let merchantId: string;
let intentId: string;
let attemptId: string;
let refundId: string;
let checkoutId: string;
let payoutId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  org = await ctx.createTenant(`FSM ${randomUUID().slice(0, 8)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `fsm-shop-${randomUUID().slice(0, 8)}`]
  );
  merchantId = m.rows[0]!.id;
  const i = await ctx.admin.query<{ id: string }>(
    `INSERT INTO payment_intents (tenant_id, merchant_id, amount, currency)
     VALUES ($1, $2, 100000, 'COP') RETURNING id`,
    [org, merchantId]
  );
  intentId = i.rows[0]!.id;
  const a = await ctx.admin.query<{ id: string }>(
    `INSERT INTO payment_attempts (tenant_id, intent_id, attempt_number, provider, amount, currency)
     VALUES ($1, $2, 1, 'mock', 100000, 'COP') RETURNING id`,
    [org, intentId]
  );
  attemptId = a.rows[0]!.id;
  const r = await ctx.admin.query<{ id: string }>(
    `INSERT INTO refunds (tenant_id, payment_intent_id, amount, currency, provider)
     VALUES ($1, $2, 100000, 'COP', 'mock') RETURNING id`,
    [org, intentId]
  );
  refundId = r.rows[0]!.id;
  const cs = await ctx.admin.query<{ id: string }>(
    `INSERT INTO checkout_sessions (tenant_id, payment_intent_id, client_secret_hash, expires_at)
     VALUES ($1, $2, 'deadbeef', now() + interval '1 hour') RETURNING id`,
    [org, intentId]
  );
  checkoutId = cs.rows[0]!.id;
  const po = await ctx.admin.query<{ id: string }>(
    `INSERT INTO payouts (tenant_id, merchant_id, amount, currency, provider)
     VALUES ($1, $2, 100000, 'COP', 'mock') RETURNING id`,
    [org, merchantId]
  );
  payoutId = po.rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('doc (mermaid) == mapa TS', () => {
  it('payment intent FSM matches payment-state-machines.md §1 exactly', () => {
    expect(transitionPairs(INTENT_TRANSITIONS)).toEqual(docPairs('1. Payment Intent'));
  });

  it('payment attempt FSM matches §2 exactly', () => {
    expect(transitionPairs(ATTEMPT_TRANSITIONS)).toEqual(docPairs('2. Payment Attempt'));
  });

  it('refund FSM matches §3 exactly', () => {
    expect(transitionPairs(REFUND_TRANSITIONS)).toEqual(docPairs('3. Refund'));
  });

  it('checkout session FSM matches §5 exactly (F3-05b)', () => {
    expect(transitionPairs(CHECKOUT_SESSION_TRANSITIONS)).toEqual(docPairs('5. Checkout Session'));
  });

  it('payout FSM matches §6 exactly (F4-07)', () => {
    expect(transitionPairs(PAYOUT_TRANSITIONS)).toEqual(docPairs('6. Payout'));
  });
});

describe('mapa TS == tablas DDL (seed generado)', () => {
  it('payment_intent_transitions equals the TS map', async () => {
    const res = await ctx.admin.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM payment_intent_transitions
       ORDER BY from_status, to_status`
    );
    expect(res.rows.map((r) => [r.from_status, r.to_status])).toEqual(
      transitionPairs(INTENT_TRANSITIONS)
    );
  });

  it('payment_attempt_transitions equals the TS map', async () => {
    const res = await ctx.admin.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM payment_attempt_transitions
       ORDER BY from_status, to_status`
    );
    expect(res.rows.map((r) => [r.from_status, r.to_status])).toEqual(
      transitionPairs(ATTEMPT_TRANSITIONS)
    );
  });

  it('refund_transitions equals the TS map (F3-08)', async () => {
    const res = await ctx.admin.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM refund_transitions
       ORDER BY from_status, to_status`
    );
    expect(res.rows.map((r) => [r.from_status, r.to_status])).toEqual(
      transitionPairs(REFUND_TRANSITIONS)
    );
  });

  it('checkout_session_transitions equals the TS map (F3-05b)', async () => {
    const res = await ctx.admin.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM checkout_session_transitions
       ORDER BY from_status, to_status`
    );
    expect(res.rows.map((r) => [r.from_status, r.to_status])).toEqual(
      transitionPairs(CHECKOUT_SESSION_TRANSITIONS)
    );
  });

  it('payout_transitions equals the TS map (F4-07)', async () => {
    const res = await ctx.admin.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM payout_transitions
       ORDER BY from_status, to_status`
    );
    expect(res.rows.map((r) => [r.from_status, r.to_status])).toEqual(
      transitionPairs(PAYOUT_TRANSITIONS)
    );
  });

  it('the transition tables are immutable even for the superuser', async () => {
    await expect(
      ctx.admin.query(`DELETE FROM payment_intent_transitions WHERE from_status = 'created'`)
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    await expect(
      ctx.admin.query(
        `UPDATE payment_attempt_transitions SET to_status = 'succeeded' WHERE from_status = 'created'`
      )
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    await expect(
      ctx.admin.query(`DELETE FROM refund_transitions WHERE from_status = 'created'`)
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    await expect(
      ctx.admin.query(`DELETE FROM checkout_session_transitions WHERE from_status = 'open'`)
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    await expect(
      ctx.admin.query(`DELETE FROM payout_transitions WHERE from_status = 'requested'`)
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
  });
});

/**
 * Matriz COMPLETA a nivel de motor: para cada par (from, to) de estados, el
 * UPDATE crudo como superusuario debe comportarse exactamente como dicta el
 * mapa. El estado base se siembra con session_replication_role=replica
 * (triggers apagados SOLO para preparar el escenario); la transición bajo
 * prueba corre con triggers activos y SIEMPRE en rollback.
 */
async function assertEngineMatrix(
  table: string,
  rowId: string,
  statuses: readonly string[],
  map: Record<string, readonly string[]>
): Promise<void> {
  const client = await ctx.admin.connect();
  try {
    for (const from of statuses) {
      for (const to of statuses) {
        await client.query('BEGIN');
        await client.query(`SET LOCAL session_replication_role = replica`);
        await client.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [rowId, from]);
        await client.query(`SET LOCAL session_replication_role = DEFAULT`);
        const legal = map[from]!.includes(to);
        if (legal) {
          await client.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [rowId, to]);
        } else {
          await expect(
            client.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [rowId, to]),
            `${table}: ${from} -> ${to} should be illegal`
          ).rejects.toThrow(/FLUVIA_INVALID_TRANSITION/);
        }
        await client.query('ROLLBACK');
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('el MOTOR hace cumplir la matriz completa (superusuario incluido)', () => {
  it('payment_intents: all 144 (from, to) pairs behave exactly as the map dictates', async () => {
    await assertEngineMatrix('payment_intents', intentId, INTENT_STATUSES, INTENT_TRANSITIONS);
  }, 60_000);

  it('payment_attempts: all 64 pairs behave exactly as the map dictates', async () => {
    await assertEngineMatrix('payment_attempts', attemptId, ATTEMPT_STATUSES, ATTEMPT_TRANSITIONS);
  }, 60_000);

  it('refunds: all 36 pairs behave exactly as the map dictates (F3-08)', async () => {
    await assertEngineMatrix('refunds', refundId, REFUND_STATUSES, REFUND_TRANSITIONS);
  }, 60_000);

  it('checkout_sessions: all 9 pairs behave exactly as the map dictates (F3-05b)', async () => {
    await assertEngineMatrix(
      'checkout_sessions',
      checkoutId,
      CHECKOUT_SESSION_STATUSES,
      CHECKOUT_SESSION_TRANSITIONS
    );
  }, 60_000);

  it('payouts: all 25 pairs behave exactly as the map dictates (F4-07)', async () => {
    await assertEngineMatrix('payouts', payoutId, PAYOUT_STATUSES, PAYOUT_TRANSITIONS);
  }, 60_000);
});
