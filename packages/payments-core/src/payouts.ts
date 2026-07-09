import { withTenantTransaction, type Pool } from '@fluvia/db';
import { buildEnvelope } from '@fluvia/events';
import { InsufficientBalanceError, accountName, type PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { InsufficientPayoutBalanceError, PayoutNotFoundError } from './errors.js';
import type { PaymentProvider } from './provider.js';
import { CircuitOpenError } from './resilience.js';
import type { TxClient } from './service.js';

/**
 * Payouts como RECURSO gestionado (F4-07a) sobre las primitivas contables de
 * F4-05b (emitPayout/settlePayout/failPayout, flujo available -> in_transit ->
 * cash). Mismo esqueleto de dos fases que refunds (F3-08):
 *
 *   Fase 1 (beginIn, DENTRO de la tx de la idempotency key en el plano HTTP;
 *   `create` la envuelve para uso directo): valida que el monto quepa en el
 *   disponible del comercio (menos payouts ya `requested`) y nace la fila
 *   `requested`. La respuesta ES este estado: el payout es asincrono por
 *   contrato. El pre-chequeo es best-effort; el guard AUD-P1-010 del motor es la
 *   protección atómica final (jamás sobre-paga).
 *
 *   Fase 2 (execute, FUERA de toda tx), en dos pasos contables:
 *     2a. emitPayout — merchant.available -> payout.in_transit con guard de
 *         no-negatividad EN el motor. Sin disponible NO hay payout, y como el
 *         banco jamás fue contactado el desenlace es CONOCIDO: `failed`
 *         (`insufficient_merchant_balance`). La transición requested->in_transit
 *         viaja en el onPosted del asiento (o entra todo o no entra nada).
 *     2b. submitPayout al banco:
 *         aprobado  -> settlePayout (in_transit -> platform.cash) con onPosted:
 *                      in_transit->paid. UNA transacción.
 *         rechazado -> failPayout (in_transit -> available: los fondos vuelven
 *                      íntegros) con onPosted: in_transit->failed + failure_code.
 *         circuito abierto -> jamás se envió: mismo camino que rechazado, con
 *                      `provider_unavailable` (semántica F3-04).
 *         throw / pending -> desenlace DESCONOCIDO (la petición pudo salir o el
 *                      banco la aceptó asíncrono): el payout pasa a
 *                      `indeterminate` con los fondos RETENIDOS en tránsito.
 *                      Nada lo resuelve por asunción NI por re-envío (V4 §23);
 *                      SOLO `resolveFromProvider` (fuente verificada) lo cierra.
 *
 * Cada cambio de estado de cara al comercio emite `payout.<estado>` al outbox EN
 * la misma transacción. `indeterminate` es interno (no emite): el comercio ve
 * `in_transit` hasta la resolución verificada.
 */

export interface PayoutDto {
  id: string;
  tenantId: string;
  merchantId: string;
  amount: string;
  currency: string;
  status: string;
  reason: string | null;
  failureCode: string | null;
  providerRef: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

interface PayoutRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  amount: string;
  currency: string;
  status: string;
  reason: string | null;
  failure_code: string | null;
  provider_ref: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

const PAYOUT_COLUMNS = `id, tenant_id, merchant_id, amount::text, currency, status,
  reason, failure_code, provider_ref, created_at, updated_at, resolved_at`;

function toDto(r: PayoutRow): PayoutDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    merchantId: r.merchant_id,
    amount: r.amount,
    currency: r.currency.trim(),
    status: r.status,
    reason: r.reason,
    failureCode: r.failure_code,
    providerRef: r.provider_ref,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    resolvedAt: r.resolved_at?.toISOString() ?? null,
  };
}

export interface CreatePayoutInput {
  merchantId: string;
  /** Unidades menores (estrictamente positivo). */
  amount: bigint;
  currency: string;
  reason?: string;
}

export class PayoutService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool,
    private readonly posting: PostingService,
    private readonly provider: PaymentProvider
  ) {
    if (!provider.submitPayout) {
      throw new Error(`Provider ${provider.name} does not support payouts (submitPayout missing)`);
    }
  }

  /** Fase 1 — client-bound: compone con la capa de idempotencia (F2-09). */
  async beginIn(c: TxClient, tenantId: string, input: CreatePayoutInput): Promise<PayoutDto> {
    // Disponible del comercio en ESTA moneda (proyección de merchant.available),
    // menos payouts ya `requested` (comprometidos pero aún no emitidos;
    // in_transit/indeterminate ya salieron de `available`).
    const bal = await c.query<{ available: string }>(
      `SELECT COALESCE(bp.available, 0)::text AS available
       FROM ledger_accounts la
       JOIN balance_projections bp ON bp.account_id = la.id
       WHERE la.tenant_id = $1 AND la.name = $2 AND la.currency = $3 AND la.deleted_at IS NULL`,
      [tenantId, accountName('merchant.available', input.merchantId), input.currency]
    );
    const available = BigInt(bal.rows[0]?.available ?? '0');
    const committed = await c.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM payouts
       WHERE merchant_id = $1 AND currency = $2 AND status = 'requested'`,
      [input.merchantId, input.currency]
    );
    const fundable = available - BigInt(committed.rows[0]!.total);
    if (input.amount <= 0n || input.amount > fundable) {
      throw new InsufficientPayoutBalanceError(input.amount.toString(), fundable.toString());
    }

    const res = await c.query<PayoutRow>(
      `INSERT INTO payouts (tenant_id, merchant_id, amount, currency, reason, provider)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${PAYOUT_COLUMNS}`,
      [
        tenantId,
        input.merchantId,
        input.amount.toString(),
        input.currency,
        input.reason ?? null,
        this.provider.name,
      ]
    );
    const dto = toDto(res.rows[0]!);
    await this.emit(c, dto, 'requested');
    return dto;
  }

  /** Envoltura directa de fase 1 (sin capa de idempotencia HTTP). */
  async create(tenantId: string, input: CreatePayoutInput): Promise<PayoutDto> {
    return withTenantTransaction(this.appPool, tenantId, (c) => this.beginIn(c, tenantId, input));
  }

  async get(tenantId: string, payoutId: string): Promise<PayoutDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<PayoutRow>(`SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE id = $1`, [
        payoutId,
      ]);
      if (!res.rows[0]) throw new PayoutNotFoundError();
      return toDto(res.rows[0]);
    });
  }

  async list(tenantId: string, merchantId?: string, limit = 20): Promise<PayoutDto[]> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = merchantId
        ? await c.query<PayoutRow>(
            `SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE merchant_id = $2
             ORDER BY created_at DESC, id LIMIT $1`,
            [capped, merchantId]
          )
        : await c.query<PayoutRow>(
            `SELECT ${PAYOUT_COLUMNS} FROM payouts ORDER BY created_at DESC, id LIMIT $1`,
            [capped]
          );
      return res.rows.map(toDto);
    });
  }

  /** Fase 2 — banco fuera de tx; cada paso contable es atómico (onPosted). */
  async execute(tenantId: string, payoutId: string): Promise<void> {
    const cur = await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query<{ status: string; amount: string; currency: string; merchant_id: string }>(
        `SELECT status, amount::text, currency, merchant_id FROM payouts
         WHERE id = $1 AND status IN ('requested', 'in_transit')`,
        [payoutId]
      )
    );
    const row = cur.rows[0];
    // Terminal o inexistente (reintento tras crash): no hay nada que hacer.
    if (!row) return;
    const amount = Money.of(row.amount, row.currency.trim());

    if (row.status === 'requested') {
      // 2a. EMITE: available -> in_transit. El guard de no-negatividad corre EN
      // el motor bajo lock (AUD-P1-010): sin disponible NO hay payout — y como
      // el banco jamás fue contactado el desenlace es CONOCIDO: failed.
      try {
        await this.posting.emitPayout({
          tenantId,
          merchantId: row.merchant_id,
          idempotencyKey: `payout:${payoutId}:emit`,
          sourceType: 'payout',
          sourceId: payoutId,
          amount,
          onPosted: async (client) => {
            await this.transition(client, payoutId, 'in_transit', {});
          },
        });
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          await withTenantTransaction(this.appPool, tenantId, (c) =>
            this.transition(c, payoutId, 'failed', {
              failureCode: 'insufficient_merchant_balance',
            })
          );
          return;
        }
        // Fallo de infraestructura: el payout queda en `requested` (re-ejecutable).
        throw err;
      }
    }

    // 2b. Banco FUERA de toda tx (Nivel A).
    let outcome;
    try {
      outcome = await this.provider.submitPayout!({
        payoutId,
        amount: row.amount,
        currency: row.currency.trim(),
      });
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // Circuito abierto (F3-04): la petición JAMÁS se envió — fallo limpio y
        // los fondos vuelven íntegros al disponible del comercio.
        await this.recordFailed(
          tenantId,
          payoutId,
          row.merchant_id,
          amount,
          null,
          'provider_unavailable'
        );
        return;
      }
      // Desenlace DESCONOCIDO (throw/timeout): la petición PUDO haber salido. El
      // payout pasa a `indeterminate` con los fondos RETENIDOS en tránsito —
      // SOLO una fuente verificada lo resuelve (V4 §23), jamás por asunción.
      await this.recordIndeterminate(tenantId, payoutId);
      return;
    }

    if (outcome.outcome === 'approved') {
      await this.recordPaid(tenantId, payoutId, row.merchant_id, amount, outcome.providerRef);
      return;
    }
    if (outcome.outcome === 'declined') {
      await this.recordFailed(
        tenantId,
        payoutId,
        row.merchant_id,
        amount,
        outcome.providerRef,
        outcome.failureCode ?? 'payout_declined'
      );
      return;
    }
    // `pending` (aceptado asíncrono): el desenlace AÚN es desconocido. Marcar
    // failed y devolver los fondos sería resolver por asunción (V4 §23). Fondos
    // RETENIDOS en `indeterminate` hasta la confirmación verificada.
    await this.recordIndeterminate(tenantId, payoutId);
  }

  /**
   * Resolución por FUENTE VERIFICADA (V4 §23): la única vía legítima para cerrar
   * un payout `in_transit`/`indeterminate` (webhook del banco, consulta o
   * conciliación). Espeja `resolveFromProvider` de refunds/attempts.
   *  - applied: el payout se liquidó (settle) o rebotó (fail).
   *  - ignored_out_of_order: el payout ya es terminal (evento tardío).
   *  - ignored: payout inexistente para este tenant/proveedor.
   */
  async resolveFromProvider(
    tenantId: string,
    input: {
      payoutId: string;
      result: 'paid' | 'failed';
      providerRef?: string;
      failureCode?: string;
    }
  ): Promise<'applied' | 'ignored_out_of_order' | 'ignored'> {
    const cur = await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query<{ status: string; amount: string; currency: string; merchant_id: string }>(
        `SELECT status, amount::text, currency, merchant_id FROM payouts
         WHERE id = $1 AND provider = $2`,
        [input.payoutId, this.provider.name]
      )
    );
    const row = cur.rows[0];
    if (!row) return 'ignored';
    if (row.status === 'paid' || row.status === 'failed') return 'ignored_out_of_order';
    if (row.status !== 'in_transit' && row.status !== 'indeterminate') {
      // `requested`: el asiento de emisión aún no existe; la fase 2 debe correr
      // primero. El re-intento del inbox lo reintenta (backoff) sin perderlo.
      throw new Error(`payout ${input.payoutId} still ${row.status}; retry later`);
    }
    const amount = Money.of(row.amount, row.currency.trim());
    if (input.result === 'paid') {
      await this.recordPaid(
        tenantId,
        input.payoutId,
        row.merchant_id,
        amount,
        input.providerRef ?? ''
      );
    } else {
      await this.recordFailed(
        tenantId,
        input.payoutId,
        row.merchant_id,
        amount,
        input.providerRef ?? null,
        input.failureCode ?? 'payout_declined'
      );
    }
    return 'applied';
  }

  /** settlePayout (in_transit -> platform.cash) + payout paid: UNA tx. */
  private async recordPaid(
    tenantId: string,
    payoutId: string,
    merchantId: string,
    amount: Money,
    providerRef: string
  ): Promise<void> {
    await this.posting.settlePayout({
      tenantId,
      merchantId,
      idempotencyKey: `payout:${payoutId}:settle`,
      sourceType: 'payout',
      sourceId: payoutId,
      amount,
      onPosted: async (client) => {
        await this.transition(client, payoutId, 'paid', { providerRef });
      },
    });
  }

  /** failPayout (in_transit -> available: fondos de vuelta) + payout failed: UNA tx. */
  private async recordFailed(
    tenantId: string,
    payoutId: string,
    merchantId: string,
    amount: Money,
    providerRef: string | null,
    failureCode: string
  ): Promise<void> {
    await this.posting.failPayout({
      tenantId,
      merchantId,
      idempotencyKey: `payout:${payoutId}:fail`,
      sourceType: 'payout',
      sourceId: payoutId,
      amount,
      onPosted: async (client) => {
        await this.transition(client, payoutId, 'failed', { failureCode, providerRef });
      },
    });
  }

  /**
   * `indeterminate` es un estado OPERATIVO interno (fondos en desenlace
   * desconocido, retenidos en tránsito), no un evento del comercio: no emite
   * webhook. El comercio ve `in_transit` hasta que una fuente verificada lo
   * cierre en paid/failed.
   */
  private async recordIndeterminate(tenantId: string, payoutId: string): Promise<void> {
    await withTenantTransaction(this.appPool, tenantId, (c) =>
      this.transition(c, payoutId, 'indeterminate', { silent: true })
    );
  }

  private async transition(
    c: TxClient,
    payoutId: string,
    to: string,
    opts: { failureCode?: string; providerRef?: string | null; silent?: boolean }
  ): Promise<void> {
    // El trigger de 0033 re-valida contra payout_transitions al UPDATE.
    const res = await c.query<PayoutRow>(
      `UPDATE payouts
       SET status = $2,
           updated_at = now(),
           resolved_at = CASE WHEN $2 IN ('paid', 'failed') THEN now() ELSE resolved_at END,
           failure_code = COALESCE($3, failure_code),
           provider_ref = COALESCE($4, provider_ref)
       WHERE id = $1
       RETURNING ${PAYOUT_COLUMNS}`,
      [payoutId, to, opts.failureCode ?? null, opts.providerRef ?? null]
    );
    if (!res.rows[0]) throw new PayoutNotFoundError();
    if (!opts.silent) await this.emit(c, toDto(res.rows[0]), to);
  }

  private async emit(c: TxClient, payout: PayoutDto, status: string): Promise<void> {
    const envelope = buildEnvelope({
      producer: 'fluvia.payments',
      resource: { type: 'payout', id: payout.id },
      data: {
        payout_id: payout.id,
        merchant_id: payout.merchantId,
        status,
        amount: payout.amount,
        currency: payout.currency,
        failure_code: payout.failureCode,
      },
    });
    await c.query(`INSERT INTO outbox_events (tenant_id, topic, payload) VALUES ($1, $2, $3)`, [
      payout.tenantId,
      `payout.${status}`,
      JSON.stringify(envelope),
    ]);
  }
}
