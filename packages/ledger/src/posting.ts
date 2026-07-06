import { withTenantTransaction, type Pool } from '@fluvia/db';
import { Money } from '@fluvia/money';
import {
  ACCOUNT_CODES,
  CHART_OF_ACCOUNTS,
  accountName,
  isAccountCode,
  type AccountCode,
} from './chart-of-accounts.js';
import { FeesExceedAmountError, InvalidEntriesError, UnknownAccountCodeError } from './errors.js';
import type { LedgerService } from './service.js';
import type { LedgerEntryInput, PostTransactionInput, PostedTransaction } from './types.js';

export interface PostingContext {
  tenantId: string;
  merchantId: string;
  idempotencyKey: string;
  sourceType: string;
  sourceId: string;
}

export interface CapturePaymentInput extends PostingContext {
  /** Monto bruto cobrado al pagador. */
  amount: Money;
  /** Fee del proveedor/adquirente (costo de plataforma en el modelo sandbox v1). */
  providerFee?: Money;
  /** Fee de Fluvia cobrado al comercio. */
  platformFee?: Money;
  /** Composicion atomica (F3-03): corre DENTRO de la tx del posting. */
  onPosted?: PostTransactionInput['onPosted'];
}

export interface SimpleAmountInput extends PostingContext {
  amount: Money;
  /** Composicion atomica (F3-03/F3-08): corre DENTRO de la tx del posting. */
  onPosted?: PostTransactionInput['onPosted'];
}

export interface ReconAdjustmentInput {
  tenantId: string;
  amount: Money;
  idempotencyKey: string;
  sourceType: string;
  sourceId: string;
  reason: string;
  /**
   * `true`  => debit recon.differences / credit suspense (RECONOCE la diferencia).
   * `false` => credit recon.differences / debit suspense (la REVIERTE).
   */
  debitDifferences: boolean;
  /** Composicion atomica (F4-03b): corre DENTRO de la tx del posting. */
  onPosted?: PostTransactionInput['onPosted'];
}

/**
 * Reglas de posting del MVP (F2-04) — catalogo cerrado sobre el Chart of
 * Accounts. Fuera de estas operaciones tipadas no existe forma de combinar
 * cuentas: lo que no esta en el catalogo es irrepresentable.
 *
 * Modelo contable sandbox v1 (bruto; el pricing definitivo depende de
 * PEND-002 y del flujo de fondos que se cierre en Fase 4):
 *
 *   payment.capture (bruto M, fee proveedor Fp, fee plataforma Ff):
 *     debit  provider.clearing      M          (bruto por cobrar al proveedor)
 *     debit  provider.fees          Fp         (costo de procesamiento)
 *     credit provider.payable       Fp         (se lo debemos al proveedor)
 *     credit merchant.pending       M - Ff     (pasivo con el comercio)
 *     credit platform.fees          Ff         (ingreso de Fluvia)
 *     => debitos M+Fp == creditos Fp+(M-Ff)+Ff. Margen de Fluvia = Ff - Fp.
 *
 *   settlement.release X:  debit merchant.pending X  / credit merchant.available X
 *   refund.request R:      debit merchant.available R / credit refund.liability R
 *   refund.settle R:       debit refund.liability R   / credit provider.clearing R
 *   refund.cancel R:       debit refund.liability R   / credit merchant.available R
 *                          (el proveedor RECHAZO el refund: la reserva vuelve
 *                          integra al comercio — F3-08)
 *   reserve.hold X:        debit merchant.available X / credit merchant.reserve X   (F4-05a)
 *   reserve.release X:     debit merchant.reserve X   / credit merchant.available X (F4-05a)
 *                          (reclasificacion entre pasivos del comercio: la
 *                          obligacion total no cambia; no depende de pricing)
 *
 *   Flujo de fondos hacia afuera (F4-05b, no depende de pricing):
 *   provider.settle X:     debit platform.cash X      / credit provider.clearing X   (el proveedor liquida a caja)
 *   payout.emit X:         debit merchant.available X / credit payout.in_transit X   (a "en transito")
 *   payout.settle X:       debit payout.in_transit X  / credit platform.cash X       (el banco confirma; sale caja)
 *   payout.fail X:         debit payout.in_transit X  / credit merchant.available X  (rebotado: vuelve al comercio)
 *
 *   Disputa / chargeback (F4-08, mismo esqueleto que refunds; sin double-spend):
 *   dispute.open X:        debit merchant.available X / credit dispute.reserve X     (el banco abre: se aparta)
 *   dispute.win X:         debit dispute.reserve X    / credit merchant.available X  (ganada: vuelve integra)
 *   dispute.lose X:        debit dispute.reserve X    / credit provider.clearing X   (perdida: se va vía proveedor)
 */
export class PostingService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly appPool: Pool
  ) {}

  /**
   * Aprovisiona (idempotente) el Chart of Accounts completo para un
   * merchant+moneda: cuentas platform-scope del tenant + merchant-scope.
   * Devuelve el mapa code -> accountId.
   */
  async ensureChart(
    tenantId: string,
    merchantId: string,
    currency: string
  ): Promise<Record<AccountCode, string>> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const names = ACCOUNT_CODES.map((code) => accountName(code, merchantId));
      const sides = ACCOUNT_CODES.map((code) => CHART_OF_ACCOUNTS[code].normalSide);
      await c.query(
        `INSERT INTO ledger_accounts (tenant_id, name, currency, normal_side)
         SELECT $1, n, $2, s FROM unnest($3::text[], $4::text[]) AS t(n, s)
         ON CONFLICT (tenant_id, name, currency) DO NOTHING`,
        [tenantId, currency, names, sides]
      );
      await c.query(
        `INSERT INTO balance_projections (account_id, tenant_id)
         SELECT id, tenant_id FROM ledger_accounts
         WHERE tenant_id = $1 AND currency = $2 AND name = ANY($3::text[])
         ON CONFLICT (account_id) DO NOTHING`,
        [tenantId, currency, names]
      );
      const res = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM ledger_accounts
         WHERE tenant_id = $1 AND currency = $2 AND name = ANY($3::text[]) AND deleted_at IS NULL`,
        [tenantId, currency, names]
      );
      const byName = new Map(res.rows.map((r) => [r.name, r.id]));
      const chart = {} as Record<AccountCode, string>;
      for (const code of ACCOUNT_CODES) {
        const id = byName.get(accountName(code, merchantId));
        if (!id) throw new UnknownAccountCodeError(code);
        chart[code] = id;
      }
      return chart;
    });
  }

  /**
   * Aprovisiona (idempotente) SOLO cuentas platform-scope (name = code) para un
   * tenant+moneda, sin necesidad de merchant. Devuelve el mapa code -> id.
   */
  private async ensurePlatformAccounts(
    tenantId: string,
    currency: string,
    codes: AccountCode[]
  ): Promise<Record<string, string>> {
    for (const code of codes) {
      if (CHART_OF_ACCOUNTS[code].scope !== 'platform') {
        throw new InvalidEntriesError(`${code} is not a platform-scope account`);
      }
    }
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const names = codes.map((code) => code); // platform: name = code
      const sides = codes.map((code) => CHART_OF_ACCOUNTS[code].normalSide);
      await c.query(
        `INSERT INTO ledger_accounts (tenant_id, name, currency, normal_side)
         SELECT $1, n, $2, s FROM unnest($3::text[], $4::text[]) AS t(n, s)
         ON CONFLICT (tenant_id, name, currency) DO NOTHING`,
        [tenantId, currency, names, sides]
      );
      await c.query(
        `INSERT INTO balance_projections (account_id, tenant_id)
         SELECT id, tenant_id FROM ledger_accounts
         WHERE tenant_id = $1 AND currency = $2 AND name = ANY($3::text[])
         ON CONFLICT (account_id) DO NOTHING`,
        [tenantId, currency, names]
      );
      const res = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM ledger_accounts
         WHERE tenant_id = $1 AND currency = $2 AND name = ANY($3::text[]) AND deleted_at IS NULL`,
        [tenantId, currency, names]
      );
      const byName = new Map(res.rows.map((r) => [r.name, r.id]));
      const out: Record<string, string> = {};
      for (const code of codes) {
        const id = byName.get(code);
        if (!id) throw new UnknownAccountCodeError(code);
        out[code] = id;
      }
      return out;
    });
  }

  /**
   * Asiento compensatorio de conciliación (F4-03b): reconoce/revierte una
   * diferencia entre `recon.differences` y `suspense` (ambas platform,
   * transitorias), enlazado por `source` al ajuste/caso. NO toca saldos de
   * comercios (el true-up de payout/settlement es F4-05, contable, bloqueado).
   */
  async postReconAdjustment(input: ReconAdjustmentInput): Promise<PostedTransaction> {
    if (!input.amount.isPositive()) {
      throw new InvalidEntriesError('Amount must be strictly positive');
    }
    const ids = await this.ensurePlatformAccounts(input.tenantId, input.amount.currency, [
      'recon.differences',
      'suspense',
    ]);
    const differencesId = ids['recon.differences']!;
    const suspenseId = ids['suspense']!;
    const [debitId, creditId] = input.debitDifferences
      ? [differencesId, suspenseId]
      : [suspenseId, differencesId];
    return this.ledger.postTransaction({
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      reason: 'reconciliation',
      source: { type: input.sourceType, id: input.sourceId },
      entries: [
        { accountId: debitId, direction: 'debit', amount: input.amount },
        { accountId: creditId, direction: 'credit', amount: input.amount },
      ],
      onPosted: input.onPosted,
    });
  }

  /** Resolucion acotada al catalogo: un code desconocido es irrepresentable. */
  async resolveAccounts(
    tenantId: string,
    merchantId: string,
    currency: string,
    codes: string[]
  ): Promise<Record<AccountCode, string>> {
    for (const code of codes) {
      if (!isAccountCode(code)) throw new UnknownAccountCodeError(code);
    }
    return this.ensureChart(tenantId, merchantId, currency);
  }

  async capturePayment(input: CapturePaymentInput): Promise<PostedTransaction> {
    const currency = input.amount.currency;
    const providerFee = input.providerFee ?? Money.zero(currency);
    const platformFee = input.platformFee ?? Money.zero(currency);
    if (providerFee.isNegative() || platformFee.isNegative()) {
      throw new InvalidEntriesError('Fees must not be negative');
    }
    // Money.add lanza CurrencyMismatchError si las monedas difieren.
    const totalFees = providerFee.add(platformFee);
    if (!input.amount.subtract(totalFees).isPositive()) {
      throw new FeesExceedAmountError();
    }

    const chart = await this.ensureChart(input.tenantId, input.merchantId, currency);
    const entries: LedgerEntryInput[] = [
      { accountId: chart['provider.clearing'], direction: 'debit', amount: input.amount },
      ...(providerFee.isPositive()
        ? ([
            { accountId: chart['provider.fees'], direction: 'debit', amount: providerFee },
            { accountId: chart['provider.payable'], direction: 'credit', amount: providerFee },
          ] as LedgerEntryInput[])
        : []),
      {
        accountId: chart['merchant.pending'],
        direction: 'credit',
        amount: input.amount.subtract(platformFee),
      },
      ...(platformFee.isPositive()
        ? ([
            { accountId: chart['platform.fees'], direction: 'credit', amount: platformFee },
          ] as LedgerEntryInput[])
        : []),
    ];

    return this.ledger.postTransaction({
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      reason: 'payment',
      source: { type: input.sourceType, id: input.sourceId },
      entries,
      onPosted: input.onPosted,
    });
  }

  /** Libera fondos pendientes del comercio a disponibles (liquidacion simulada). */
  async releaseSettlement(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'settlement', 'merchant.pending', 'merchant.available');
  }

  /** Registra la intencion de refund: reserva desde el disponible del comercio. */
  async requestRefund(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'refund', 'merchant.available', 'refund.liability');
  }

  /** El proveedor confirma el refund: se descarga la reserva contra el clearing. */
  async settleRefund(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'refund', 'refund.liability', 'provider.clearing');
  }

  /** El proveedor RECHAZO el refund: la reserva vuelve integra al comercio. */
  async cancelRefundReservation(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'refund', 'refund.liability', 'merchant.available');
  }

  /**
   * F4-05a — APARTA fondos del disponible del comercio a su reserva
   * (riesgo/disputas). Reclasificacion entre dos pasivos del comercio: la
   * obligacion total NO cambia, solo deja de estar disponible para payout. El
   * guard de no-negatividad impide reservar mas de lo disponible. No depende de
   * pricing (el monto es una entrada; la politica de cuanto/cuanto tiempo es un
   * parametro del que llama).
   */
  async holdReserve(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'reserve', 'merchant.available', 'merchant.reserve');
  }

  /** F4-05a — LIBERA fondos de la reserva al disponible del comercio (reverso
   * de holdReserve). El guard impide liberar mas de lo reservado. */
  async releaseReserve(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'reserve', 'merchant.reserve', 'merchant.available');
  }

  /**
   * F4-05b — el proveedor LIQUIDA a la caja/banco de Fluvia los fondos que tenia
   * en clearing (el lado de CAJA de la liquidacion; el lado de pasivo del
   * comercio es releaseSettlement). Convierte "el proveedor tiene nuestro dinero"
   * en "tenemos caja". Guard: no liquidar mas de lo que el proveedor tiene en
   * clearing.
   */
  async receiveProviderSettlement(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'settlement', 'platform.cash', 'provider.clearing');
  }

  /**
   * F4-05b — EMITE un payout: el disponible del comercio pasa a "en transito"
   * (obligacion en vuelo). Guard AUD-P1-010: no emitir mas de lo disponible ⇒
   * los fondos en vuelo no se pueden re-pagar ni refundar (no double-spend).
   */
  async emitPayout(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'payout', 'merchant.available', 'payout.in_transit');
  }

  /** F4-05b — el banco CONFIRMA el payout: la obligacion en transito se descarga
   * contra la caja (el dinero sale de verdad). Guard: no pagar mas caja de la que
   * hay. */
  async settlePayout(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'payout', 'payout.in_transit', 'platform.cash');
  }

  /** F4-05b — el payout FALLO (rebotado por el banco): la obligacion en transito
   * vuelve integra al disponible del comercio (reverso de emitPayout). */
  async failPayout(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'payout', 'payout.in_transit', 'merchant.available');
  }

  /**
   * F4-08 — el banco ABRE una disputa: se APARTA el monto disputado del
   * disponible del comercio a `dispute.reserve`. Guard AUD-P1-010: no se puede
   * apartar mas de lo disponible ⇒ el dinero disputado no se puede pagar ni
   * disputar dos veces (no double-spend). Mismo esqueleto que requestRefund.
   */
  async openDispute(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'dispute', 'merchant.available', 'dispute.reserve');
  }

  /** F4-08 — el comercio GANA la disputa: lo apartado vuelve integro al
   * disponible (reverso de openDispute). Guard: no liberar mas de lo apartado. */
  async winDispute(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'dispute', 'dispute.reserve', 'merchant.available');
  }

  /** F4-08 — el comercio PIERDE la disputa: lo apartado se forfeita al proveedor
   * (el dinero se va de vuelta, como un refund forzado — mismo destino que
   * settleRefund). Guard: dispute.reserve y provider.clearing no quedan negativos. */
  async loseDispute(input: SimpleAmountInput): Promise<PostedTransaction> {
    return this.twoLegged(input, 'dispute', 'dispute.reserve', 'provider.clearing');
  }

  private async twoLegged(
    input: SimpleAmountInput,
    reason: 'settlement' | 'refund' | 'reserve' | 'payout' | 'dispute',
    debitCode: AccountCode,
    creditCode: AccountCode
  ): Promise<PostedTransaction> {
    if (!input.amount.isPositive()) {
      throw new InvalidEntriesError('Amount must be strictly positive');
    }
    const chart = await this.ensureChart(input.tenantId, input.merchantId, input.amount.currency);
    // AUD-P1-010: ninguna cuenta que DECRECE con este asiento puede quedar en
    // negativo (no se mueve hacia afuera mas de lo que hay). Una cuenta decrece
    // si se debita su lado credit-normal (pasivo/ingreso) o se acredita su lado
    // debit-normal (activo/gasto/transitoria). Se calcula desde el chart para que
    // valga con cualquier par de cuentas (p. ej. provider.settle acredita un
    // activo, payout.settle acredita la caja). Verificado bajo lock en el motor.
    const guarded: string[] = [];
    if (CHART_OF_ACCOUNTS[debitCode].normalSide === 'credit') guarded.push(chart[debitCode]);
    if (CHART_OF_ACCOUNTS[creditCode].normalSide === 'debit') guarded.push(chart[creditCode]);
    return this.ledger.postTransaction({
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      reason,
      source: { type: input.sourceType, id: input.sourceId },
      entries: [
        { accountId: chart[debitCode], direction: 'debit', amount: input.amount },
        { accountId: chart[creditCode], direction: 'credit', amount: input.amount },
      ],
      nonNegativeAccounts: guarded,
      onPosted: input.onPosted,
    });
  }
}
