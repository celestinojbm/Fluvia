import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, CurrencyMismatchError } from '@fluvia/money';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  ACCOUNT_CODES,
  CHART_OF_ACCOUNTS,
  FeesExceedAmountError,
  InsufficientBalanceError,
  LedgerService,
  PostingService,
  UnknownAccountCodeError,
  type AccountCode,
} from '../src/index.js';

let ctx: TestContext;
let ledger: LedgerService;
let posting: PostingService;
let org: string;
let merchantId: string;

const cop = (minor: number) => Money.of(minor, 'COP');
const key = () => `post-${randomUUID()}`;

async function balances(tenantId: string, chart: Record<AccountCode, string>) {
  const out = {} as Record<AccountCode, string>;
  for (const code of ACCOUNT_CODES) {
    out[code] = (await ledger.getBalance(tenantId, chart[code])).available;
  }
  return out;
}

function postingCtx() {
  return {
    tenantId: org,
    merchantId,
    idempotencyKey: key(),
    sourceType: 'test',
    sourceId: randomUUID(),
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
  ledger = new LedgerService(ctx.app);
  posting = new PostingService(ledger, ctx.app);
  org = await ctx.createTenant('Posting Rules Org');
  merchantId = randomUUID(); // id logico del comercio para el naming de cuentas
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('Chart of Accounts (catalogo == doc)', () => {
  it('GOLDEN: the catalog has exactly the 13 documented accounts', () => {
    expect([...ACCOUNT_CODES].sort()).toEqual(
      [
        'provider.clearing',
        'provider.receivable',
        'provider.payable',
        'provider.fees',
        'platform.fees',
        'payout.in_transit',
        'suspense',
        'recon.differences',
        'merchant.pending',
        'merchant.available',
        'merchant.reserve',
        'refund.liability',
        'dispute.reserve',
      ].sort()
    );
    // Semantica contable: activos/gastos debit-normal; pasivos/ingresos credit-normal.
    for (const code of ACCOUNT_CODES) {
      const def = CHART_OF_ACCOUNTS[code];
      if (def.type === 'asset' || def.type === 'expense' || def.type === 'transitory') {
        expect(def.normalSide, code).toBe('debit');
      } else {
        expect(def.normalSide, code).toBe('credit');
      }
    }
  });

  it('ensureChart provisions all 13 accounts idempotently', async () => {
    const first = await posting.ensureChart(org, merchantId, 'COP');
    const second = await posting.ensureChart(org, merchantId, 'COP');
    expect(Object.keys(first)).toHaveLength(13);
    expect(second).toEqual(first);
    const count = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM ledger_accounts WHERE tenant_id = $1 AND currency = 'COP'`,
      [org]
    );
    expect(count.rows[0]!.n).toBe(13);
  });

  it('rejects codes outside the catalog (fuera de catalogo = irrepresentable)', async () => {
    await expect(
      posting.resolveAccounts(org, merchantId, 'COP', ['merchant.available', 'evil.account'])
    ).rejects.toThrow(UnknownAccountCodeError);
  });
});

describe('GOLDEN: payment.capture (modelo bruto sandbox v1)', () => {
  it('M=100000, Fp=2900, Ff=5000 produces the exact 5-entry posting', async () => {
    // Tenant fresco: las cuentas platform-scope son compartidas por tenant y
    // los balances de este golden se afirman en absoluto.
    const goldenOrg = await ctx.createTenant('Golden Capture Org');
    const freshMerchant = randomUUID();
    const chart = await posting.ensureChart(goldenOrg, freshMerchant, 'COP');
    const result = await posting.capturePayment({
      tenantId: goldenOrg,
      merchantId: freshMerchant,
      idempotencyKey: key(),
      sourceType: 'payment_attempt',
      sourceId: randomUUID(),
      amount: cop(100_000),
      providerFee: cop(2_900),
      platformFee: cop(5_000),
    });
    expect(result.entries).toHaveLength(5);

    const sorted = result.entries
      .map((e) => `${e.direction}:${e.amount}`)
      .sort()
      .join(',');
    expect(sorted).toBe('credit:2900,credit:5000,credit:95000,debit:100000,debit:2900');

    const b = await balances(goldenOrg, chart as Record<AccountCode, string>);
    expect(b['provider.clearing']).toBe('100000'); // bruto por cobrar
    expect(b['provider.fees']).toBe('2900'); // costo de procesamiento
    expect(b['provider.payable']).toBe('2900'); // deuda con el proveedor
    expect(b['merchant.pending']).toBe('95000'); // M - Ff
    expect(b['platform.fees']).toBe('5000'); // ingreso Fluvia (margen = 5000-2900)
    expect(b['merchant.available']).toBe('0');
    expect(b['refund.liability']).toBe('0');
  });

  it('zero-fee capture is a clean 2-entry posting', async () => {
    const freshMerchant = randomUUID();
    const result = await posting.capturePayment({
      tenantId: org,
      merchantId: freshMerchant,
      idempotencyKey: key(),
      sourceType: 'payment_attempt',
      sourceId: randomUUID(),
      amount: cop(50_000),
    });
    expect(result.entries).toHaveLength(2);
  });

  it('rejects fees that consume the whole amount and mixed currencies', async () => {
    await expect(
      posting.capturePayment({
        ...postingCtx(),
        amount: cop(1_000),
        providerFee: cop(600),
        platformFee: cop(400),
      })
    ).rejects.toThrow(FeesExceedAmountError);

    await expect(
      posting.capturePayment({
        ...postingCtx(),
        amount: cop(1_000),
        platformFee: Money.of(10, 'USD'),
      })
    ).rejects.toThrow(CurrencyMismatchError);
  });
});

describe('GOLDEN: ciclo completo captura -> liquidacion -> refund', () => {
  it('capture(100000,2900,5000) + release(95000) + refund(30000) end-to-end exact balances', async () => {
    const cycleOrg = await ctx.createTenant('Golden Cycle Org');
    const m = randomUUID();
    const chart = await posting.ensureChart(cycleOrg, m, 'COP');
    const base = { tenantId: cycleOrg, merchantId: m, sourceType: 'test' };

    await posting.capturePayment({
      ...base,
      idempotencyKey: key(),
      sourceId: 'pay-1',
      amount: cop(100_000),
      providerFee: cop(2_900),
      platformFee: cop(5_000),
    });
    await posting.releaseSettlement({
      ...base,
      idempotencyKey: key(),
      sourceId: 'settle-1',
      amount: cop(95_000),
    });
    await posting.requestRefund({
      ...base,
      idempotencyKey: key(),
      sourceId: 'ref-1',
      amount: cop(30_000),
    });
    await posting.settleRefund({
      ...base,
      idempotencyKey: key(),
      sourceId: 'ref-1',
      amount: cop(30_000),
    });

    const b = await balances(cycleOrg, chart as Record<AccountCode, string>);
    expect(b['provider.clearing']).toBe('70000'); // 100000 - 30000 devueltos
    expect(b['provider.fees']).toBe('2900');
    expect(b['provider.payable']).toBe('2900');
    expect(b['merchant.pending']).toBe('0'); // 95000 liberados
    expect(b['merchant.available']).toBe('65000'); // 95000 - 30000
    expect(b['refund.liability']).toBe('0'); // reservado y descargado
    expect(b['platform.fees']).toBe('5000');

    // Cero drift en todas las cuentas tocadas.
    for (const code of [
      'provider.clearing',
      'merchant.pending',
      'merchant.available',
      'refund.liability',
    ] as AccountCode[]) {
      const check = await ledger.verifyProjection(cycleOrg, chart[code]);
      expect(check.matches, `${code}: ${JSON.stringify(check)}`).toBe(true);
    }
  });

  // AUD-P1-010: sobre-liberacion y sobre-refund son irrepresentables — la
  // cuenta debitada de cada operacion two-legged esta protegida bajo lock.
  it('GOLDEN: cannot release more than merchant.pending nor refund more than merchant.available', async () => {
    const guardOrg = await ctx.createTenant('Golden Guard Org');
    const m = randomUUID();
    const chart = await posting.ensureChart(guardOrg, m, 'COP');
    const base = { tenantId: guardOrg, merchantId: m, sourceType: 'test' };

    await posting.capturePayment({
      ...base,
      idempotencyKey: key(),
      sourceId: 'pay-guard',
      amount: cop(100_000),
      providerFee: cop(2_900),
      platformFee: cop(5_000),
    });
    // pending = 95000: liberar 95001 debe fallar sin efectos.
    await expect(
      posting.releaseSettlement({
        ...base,
        idempotencyKey: key(),
        sourceId: 'settle-over',
        amount: cop(95_001),
      })
    ).rejects.toThrow(InsufficientBalanceError);

    await posting.releaseSettlement({
      ...base,
      idempotencyKey: key(),
      sourceId: 'settle-guard',
      amount: cop(40_000),
    });
    // available = 40000: refund de 40001 debe fallar sin efectos.
    await expect(
      posting.requestRefund({
        ...base,
        idempotencyKey: key(),
        sourceId: 'ref-over',
        amount: cop(40_001),
      })
    ).rejects.toThrow(InsufficientBalanceError);

    // settleRefund sin reserva previa: refund.liability en 0, descargar 1 falla.
    await expect(
      posting.settleRefund({
        ...base,
        idempotencyKey: key(),
        sourceId: 'ref-phantom',
        amount: cop(1),
      })
    ).rejects.toThrow(InsufficientBalanceError);

    const b = await balances(guardOrg, chart as Record<AccountCode, string>);
    expect(b['merchant.pending']).toBe('55000'); // 95000 - 40000; el intento fallido no toco nada
    expect(b['merchant.available']).toBe('40000');
    expect(b['refund.liability']).toBe('0');
  });

  it('posting operations are idempotent end-to-end (replay does not double-post)', async () => {
    const m = randomUUID();
    const chart = await posting.ensureChart(org, m, 'COP');
    const input = {
      tenantId: org,
      merchantId: m,
      idempotencyKey: key(),
      sourceType: 'test',
      sourceId: 'idem-1',
      amount: cop(10_000),
    };
    await posting.capturePayment(input);
    const replay = await posting.capturePayment(input);
    expect(replay.replayed).toBe(true);
    const bal = await ledger.getBalance(org, chart['merchant.pending']);
    expect(bal.available).toBe('10000');
  });
});
