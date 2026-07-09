import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@fluvia/money';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  ACCOUNT_CODES,
  CHART_OF_ACCOUNTS,
  LedgerService,
  PostingService,
  type AccountCode,
  type LedgerEntryInput,
  type PostTransactionInput,
  type PostedTransaction,
} from '../src/index.js';

/**
 * TM-01 (threat-model §5) — defensa en profundidad de la NO-NEGATIVIDAD.
 *
 * Invariante de seguridad del dinero: ninguna operación de posting puede DEBITAR
 * (= sacar de la custodia) una cuenta de PASIVO con `scope: merchant` sin
 * incluirla en `nonNegativeAccounts` — el guard race-safe del MOTOR (AUD-P1-010),
 * verificado bajo lock. De lo contrario se podría pagar/refundar/forfeitar más de
 * lo que el comercio tiene en custodia (double-spend contable).
 *
 * Hoy toda salida de custodia pasa por `twoLegged`, que DERIVA el guard desde el
 * chart, así que no hay bug vigente (relevado en la revisión). Este meta-test
 * CONVIERTE ESE INVARIANTE EN GATE: si una operación FUTURA (o multi-pata) debita
 * custodia del comercio y olvida el guard, el build falla aquí — sin depender de
 * que quien la escriba recuerde marcarla. Complementa (no reemplaza) un posible
 * backstop a nivel de BD, que queda como opción registrada en el threat model.
 */

// Cuentas de custodia del comercio: PASIVO scope=merchant (crédito-normal ⇒
// decrecen al DEBITARSE). Derivadas del catálogo, no hardcodeadas.
const CUSTODY_CODES = new Set<AccountCode>(
  (Object.entries(CHART_OF_ACCOUNTS) as [AccountCode, (typeof CHART_OF_ACCOUNTS)[AccountCode]][])
    .filter(([, meta]) => meta.scope === 'merchant' && meta.type === 'liability')
    .map(([code]) => code)
);

// Métodos del prototipo que NO son operaciones de posting (helpers de resolución).
const NON_POSTING = new Set([
  'constructor',
  'ensureChart',
  'ensurePlatformAccounts',
  'resolveAccounts',
  'twoLegged',
]);

/** Entradas que DEBITAN una cuenta de custodia del comercio SIN estar guardadas. */
function unguardedCustodyDebits(input: PostTransactionInput, custodyIds: Set<string>): string[] {
  const guarded = new Set(input.nonNegativeAccounts ?? []);
  return input.entries
    .filter(
      (e: LedgerEntryInput) =>
        e.direction === 'debit' && custodyIds.has(e.accountId) && !guarded.has(e.accountId)
    )
    .map((e) => e.accountId);
}

let ctx: TestContext;
let org: string;
let merchantId: string;
let custodyIds: Set<string>;
let posting: PostingService;
let captured: PostTransactionInput | null;

// Ledger espía: captura el input de postTransaction y NO ejecuta nada (así se
// inspecciona la INTENCIÓN de cada operación sin necesitar saldos ni tocar el
// guard real, que vive dentro de postTransaction).
const spyLedger = {
  postTransaction: async (input: PostTransactionInput): Promise<PostedTransaction> => {
    captured = input;
    return { id: randomUUID(), reused: false, entries: [] } as unknown as PostedTransaction;
  },
} as unknown as LedgerService;

const AMOUNT = Money.of(1000n, 'COP');
const simple = () => ({
  tenantId: org,
  merchantId,
  idempotencyKey: `tm01-${randomUUID()}`,
  sourceType: 'test',
  sourceId: randomUUID(),
  amount: AMOUNT,
});

// Tabla de invocación: una entrada por operación de posting pública.
const OPS: Array<[string, (s: PostingService) => Promise<unknown>]> = [
  ['capturePayment', (s) => s.capturePayment(simple())],
  ['releaseSettlement', (s) => s.releaseSettlement(simple())],
  ['requestRefund', (s) => s.requestRefund(simple())],
  ['settleRefund', (s) => s.settleRefund(simple())],
  ['cancelRefundReservation', (s) => s.cancelRefundReservation(simple())],
  ['holdReserve', (s) => s.holdReserve(simple())],
  ['releaseReserve', (s) => s.releaseReserve(simple())],
  ['receiveProviderSettlement', (s) => s.receiveProviderSettlement(simple())],
  ['emitPayout', (s) => s.emitPayout(simple())],
  ['settlePayout', (s) => s.settlePayout(simple())],
  ['failPayout', (s) => s.failPayout(simple())],
  ['openDispute', (s) => s.openDispute(simple())],
  ['winDispute', (s) => s.winDispute(simple())],
  ['loseDispute', (s) => s.loseDispute(simple())],
  [
    'postReconAdjustment',
    (s) =>
      s.postReconAdjustment({
        tenantId: org,
        idempotencyKey: `tm01-${randomUUID()}`,
        sourceType: 'test',
        sourceId: randomUUID(),
        amount: AMOUNT,
        reason: 'tm01-coverage',
        debitDifferences: true,
      }),
  ],
];

beforeAll(async () => {
  ctx = await createTestContext();
  org = await ctx.createTenant('Non-negativity Guard Org');
  merchantId = randomUUID();
  posting = new PostingService(spyLedger, ctx.app);
  // Resuelve el chart real y arma el set de IDs de cuentas de custodia del comercio.
  const chart = await posting.resolveAccounts(org, merchantId, 'COP', [...ACCOUNT_CODES]);
  custodyIds = new Set([...CUSTODY_CODES].map((code) => chart[code]));
  expect(custodyIds.size).toBe(5); // merchant.pending/available/reserve + refund.liability + dispute.reserve
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('TM-01 · guard de no-negatividad como invariante de cobertura', () => {
  it('el meta-test cubre EXACTAMENTE las operaciones de posting públicas (gate de futuras)', () => {
    const proto = PostingService.prototype;
    const methods = Object.getOwnPropertyNames(proto).filter((name) => {
      if (NON_POSTING.has(name)) return false;
      const d = Object.getOwnPropertyDescriptor(proto, name);
      return typeof d?.value === 'function';
    });
    // Si alguien añade una operación de posting y NO la agrega a OPS (o un helper
    // sin registrarlo en NON_POSTING), este assert falla: nadie escapa al guard.
    expect(new Set(methods)).toEqual(new Set(OPS.map(([n]) => n)));
  });

  it('el detector TIENE dientes: una operación que debita custodia sin guard es señalada', () => {
    const custodyId = [...custodyIds][0]!;
    const bad: PostTransactionInput = {
      tenantId: org,
      idempotencyKey: 'x',
      reason: 'payout',
      source: { type: 'test', id: 'x' },
      entries: [
        { accountId: custodyId, direction: 'debit', amount: AMOUNT },
        { accountId: 'other', direction: 'credit', amount: AMOUNT },
      ],
      // nonNegativeAccounts OMITIDO a propósito
    } as unknown as PostTransactionInput;
    expect(unguardedCustodyDebits(bad, custodyIds)).toContain(custodyId);
  });

  for (const [name, run] of OPS) {
    it(`${name}: toda cuenta de custodia (pasivo merchant) que debita está guardada`, async () => {
      captured = null;
      await run(posting);
      expect(captured, `${name} no llamó a postTransaction`).not.toBeNull();
      const violations = unguardedCustodyDebits(captured!, custodyIds);
      expect(
        violations,
        `${name} saca custodia del comercio SIN guard de no-negatividad: ${violations.join(', ')}`
      ).toEqual([]);
    });
  }

  it('cobertura efectiva: al menos una operación EJERCE el camino de custodia debitada', async () => {
    let touched = 0;
    for (const [, run] of OPS) {
      captured = null;
      await run(posting);
      if (captured!.entries.some((e) => e.direction === 'debit' && custodyIds.has(e.accountId)))
        touched += 1;
    }
    // Si nadie debita custodia, el invariante sería vacuo — probamos que no lo es.
    expect(touched).toBeGreaterThanOrEqual(10);
  });
});
