import { withTenantTransaction, type Pool } from '@fluvia/db';
import { buildEnvelope } from '@fluvia/events';
import { InsufficientBalanceError, type PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  InvalidStateTransitionError,
  PaymentIntentNotFoundError,
  RefundAmountExceedsRemainingError,
  RefundNotFoundError,
} from './errors.js';
import type { PaymentProvider } from './provider.js';
import { CircuitOpenError } from './resilience.js';
import type { PaymentIntentService, TxClient } from './service.js';

/**
 * Refunds end-to-end (F3-08, dos fases — mismo esqueleto que confirm F3-03):
 *
 *   Fase 1 (beginIn, DENTRO de la tx de la idempotency key): bajo lock del
 *   intent se valida el estado (succeeded|partially_refunded) y el monto
 *   contra lo REMANENTE (capturado − aplicado − refunds en vuelo) y nace la
 *   fila `refund` en `created`. La respuesta del endpoint ES este estado:
 *   el refund es asincrono por contrato (replay exacto).
 *
 *   Fase 2 (execute, FUERA de toda tx), en dos pasos contables de la via
 *   normativa (ledger-chart-of-accounts.md):
 *     2a. refund.request — reserva merchant.available -> refund.liability con
 *         guard de no-negatividad EN el motor (AUD-P1-010). Sin saldo
 *         disponible el refund se CANCELA limpio (jamas se hablo con el
 *         proveedor: desenlace conocido) con `insufficient_merchant_balance`.
 *         La transicion created->processing viaja en el onPosted del asiento
 *         (o entra todo o no entra nada).
 *     2b. refundPayment al proveedor:
 *         aprobado  -> refund.settle (liability -> provider.clearing) con
 *                      onPosted: refund succeeded + amount_refunded += monto +
 *                      intent partially_refunded|refunded. UNA transaccion.
 *         rechazado -> refund.cancel (la reserva vuelve integra al comercio)
 *                      con onPosted: refund failed + failure_code.
 *         circuito abierto -> jamas se envio: mismo camino que rechazado, con
 *                      `provider_unavailable` (semantica F3-04).
 *         throw / pending -> desenlace DESCONOCIDO (la peticion pudo salir, o
 *                      el proveedor la acepto de forma asincrona): el refund
 *                      pasa a `indeterminate` con la reserva RETENIDA. Nada lo
 *                      resuelve por asuncion NI por re-envio (V4 §23); SOLO
 *                      `resolveFromProvider` (fuente verificada) lo cierra.
 *
 * Cada cambio de estado de cara al comercio emite `refund.<estado>` al outbox
 * EN la misma transaccion (topics de webhook-delivery.md §5) — el comercio se
 * entera por los webhooks de F3-07. `indeterminate` es interno (no emite): el
 * comercio ve `processing` hasta la resolucion verificada.
 *
 * PENDIENTE (desviacion registrada, espeja F3-03→F3-04): la INGESTA de
 * webhooks de refund del proveedor y un watchdog que barra refunds
 * `processing`/`indeterminate` envejecidos llegan en un incremento posterior
 * (F4 conciliacion). Hoy `execute` se dispara una vez desde el endpoint; un
 * refund atascado conserva su cupo (conservador: jamas sobre-reembolsa).
 */

export interface RefundDto {
  id: string;
  tenantId: string;
  paymentIntentId: string;
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

interface RefundRow {
  id: string;
  tenant_id: string;
  payment_intent_id: string;
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

const REFUND_COLUMNS = `id, tenant_id, payment_intent_id, amount::text, currency, status,
  reason, failure_code, provider_ref, created_at, updated_at, resolved_at`;

function toDto(r: RefundRow): RefundDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    paymentIntentId: r.payment_intent_id,
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

export interface CreateRefundInput {
  paymentIntentId: string;
  /** Unidades menores; ausente = todo lo remanente reembolsable. */
  amount?: bigint;
  reason?: string;
}

export class RefundService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool,
    private readonly intents: PaymentIntentService,
    private readonly posting: PostingService,
    private readonly provider: PaymentProvider
  ) {
    if (!provider.refundPayment) {
      throw new Error(`Provider ${provider.name} does not support refunds (refundPayment missing)`);
    }
  }

  /** Fase 1 — client-bound: compone con la capa de idempotencia (F2-09). */
  async beginIn(c: TxClient, tenantId: string, input: CreateRefundInput): Promise<RefundDto> {
    const cur = await c.query<{
      status: string;
      amount_captured: string;
      amount_refunded: string;
      currency: string;
    }>(
      `SELECT status, amount_captured::text, amount_refunded::text, currency
       FROM payment_intents WHERE id = $1 FOR UPDATE`,
      [input.paymentIntentId]
    );
    const intent = cur.rows[0];
    if (!intent) throw new PaymentIntentNotFoundError();
    if (intent.status !== 'succeeded' && intent.status !== 'partially_refunded') {
      throw new InvalidStateTransitionError(intent.status, 'refunded');
    }

    // Remanente REAL bajo el lock del intent: capturado − aplicado − en vuelo
    // (created/processing reservan cupo; failed/canceled lo devuelven).
    const inFlight = await c.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM refunds
       WHERE payment_intent_id = $1 AND status IN ('created', 'processing')`,
      [input.paymentIntentId]
    );
    const remaining =
      BigInt(intent.amount_captured) -
      BigInt(intent.amount_refunded) -
      BigInt(inFlight.rows[0]!.total);
    const requested = input.amount ?? (remaining > 0n ? remaining : 0n);
    if (requested <= 0n || requested > remaining) {
      throw new RefundAmountExceedsRemainingError(requested.toString(), remaining.toString());
    }

    const res = await c.query<RefundRow>(
      `INSERT INTO refunds (tenant_id, payment_intent_id, amount, currency, reason, provider)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${REFUND_COLUMNS}`,
      [
        tenantId,
        input.paymentIntentId,
        requested.toString(),
        intent.currency,
        input.reason ?? null,
        this.provider.name,
      ]
    );
    const dto = toDto(res.rows[0]!);
    await this.emit(c, dto, 'created');
    return dto;
  }

  async get(tenantId: string, refundId: string): Promise<RefundDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<RefundRow>(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE id = $1`, [
        refundId,
      ]);
      if (!res.rows[0]) throw new RefundNotFoundError();
      return toDto(res.rows[0]);
    });
  }

  async list(tenantId: string, paymentIntentId?: string, limit = 20): Promise<RefundDto[]> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = paymentIntentId
        ? await c.query<RefundRow>(
            `SELECT ${REFUND_COLUMNS} FROM refunds WHERE payment_intent_id = $2
             ORDER BY created_at DESC, id LIMIT $1`,
            [capped, paymentIntentId]
          )
        : await c.query<RefundRow>(
            `SELECT ${REFUND_COLUMNS} FROM refunds ORDER BY created_at DESC, id LIMIT $1`,
            [capped]
          );
      return res.rows.map(toDto);
    });
  }

  /** Fase 2 — proveedor fuera de tx; cada paso contable es atomico (onPosted). */
  async execute(tenantId: string, refundId: string): Promise<void> {
    const cur = await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query<{
        status: string;
        amount: string;
        currency: string;
        payment_intent_id: string;
        merchant_id: string;
        charge_ref: string | null;
      }>(
        `SELECT r.status, r.amount::text, r.currency, r.payment_intent_id, i.merchant_id,
                (SELECT a.provider_ref FROM payment_attempts a
                 WHERE a.intent_id = i.id AND a.status = 'succeeded'
                 ORDER BY a.attempt_number DESC LIMIT 1) AS charge_ref
         FROM refunds r
         JOIN payment_intents i ON i.id = r.payment_intent_id
         WHERE r.id = $1 AND r.status IN ('created', 'processing')`,
        [refundId]
      )
    );
    const row = cur.rows[0];
    // Terminal o inexistente (reintento tras crash): no hay nada que hacer.
    if (!row) return;
    const amount = Money.of(row.amount, row.currency.trim());

    if (row.status === 'created') {
      // 2a. Reserva contable. El guard de no-negatividad corre EN el motor
      // bajo lock (AUD-P1-010): sin disponible NO hay refund — y como el
      // proveedor jamas fue contactado, el desenlace es CONOCIDO: canceled.
      try {
        await this.posting.requestRefund({
          tenantId,
          merchantId: row.merchant_id,
          idempotencyKey: `refund:${refundId}:request`,
          sourceType: 'refund',
          sourceId: refundId,
          amount,
          onPosted: async (client) => {
            await this.transitionRefund(client, refundId, 'processing', {});
          },
        });
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          await withTenantTransaction(this.appPool, tenantId, (c) =>
            this.transitionRefund(c, refundId, 'canceled', {
              failureCode: 'insufficient_merchant_balance',
            })
          );
          return;
        }
        // Fallo de infraestructura: el refund queda en `created` (re-ejecutable).
        throw err;
      }
    }

    // 2b. Proveedor FUERA de toda tx (Nivel A).
    let outcome;
    try {
      outcome = await this.provider.refundPayment!({
        refundId,
        amount: row.amount,
        currency: row.currency.trim(),
        chargeProviderRef: row.charge_ref,
      });
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // Circuito abierto (F3-04): la peticion JAMAS se envio — fallo limpio
        // y la reserva vuelve integra al comercio.
        await this.recordFailed(
          tenantId,
          refundId,
          row.merchant_id,
          amount,
          null,
          'provider_unavailable'
        );
        return;
      }
      // Desenlace DESCONOCIDO (throw/timeout): la peticion PUDO haber salido.
      // El refund pasa a `indeterminate` con la reserva RETENIDA — SOLO una
      // fuente verificada lo resuelve (V4 §23), jamas por asuncion ni re-envio.
      await this.recordIndeterminate(tenantId, refundId);
      return;
    }

    if (outcome.outcome === 'approved') {
      await this.recordSucceeded(tenantId, refundId, row, amount, outcome.providerRef);
      return;
    }
    if (outcome.outcome === 'declined') {
      await this.recordFailed(
        tenantId,
        refundId,
        row.merchant_id,
        amount,
        outcome.providerRef,
        outcome.failureCode ?? 'refund_declined'
      );
      return;
    }
    // `pending` (aceptado asincrono): el desenlace AUN es desconocido. Marcar
    // failed y devolver la reserva seria resolver por asuncion (V4 §23) — el
    // refund podria completarse y el comercio ya habria recuperado el saldo.
    // Reserva RETENIDA en `indeterminate` hasta la confirmacion verificada.
    await this.recordIndeterminate(tenantId, refundId);
  }

  /**
   * Resolucion por FUENTE VERIFICADA (V4 §23): la unica via legitima para
   * cerrar un refund `processing`/`indeterminate` (webhook del proveedor,
   * consulta o conciliacion). Espeja `resolveFromProvider` de attempts.
   *  - applied: el refund se liquido (settle) o se revirtio (cancel).
   *  - ignored_out_of_order: el refund ya es terminal (evento tardio).
   *  - ignored: refund inexistente para este tenant/proveedor.
   */
  async resolveFromProvider(
    tenantId: string,
    input: {
      refundId: string;
      result: 'succeeded' | 'failed';
      providerRef?: string;
      failureCode?: string;
    }
  ): Promise<'applied' | 'ignored_out_of_order' | 'ignored'> {
    const cur = await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query<{
        status: string;
        amount: string;
        currency: string;
        payment_intent_id: string;
        merchant_id: string;
      }>(
        `SELECT r.status, r.amount::text, r.currency, r.payment_intent_id, i.merchant_id
         FROM refunds r JOIN payment_intents i ON i.id = r.payment_intent_id
         WHERE r.id = $1 AND r.provider = $2`,
        [input.refundId, this.provider.name]
      )
    );
    const row = cur.rows[0];
    if (!row) return 'ignored';
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'canceled') {
      return 'ignored_out_of_order';
    }
    if (row.status !== 'processing' && row.status !== 'indeterminate') {
      // `created`: la reserva contable aun no existe; la fase 2 debe correr
      // primero. El re-intento del inbox lo reintenta (backoff) sin perderlo.
      throw new Error(`refund ${input.refundId} still ${row.status}; retry later`);
    }
    const amount = Money.of(row.amount, row.currency.trim());
    if (input.result === 'succeeded') {
      await this.recordSucceeded(tenantId, input.refundId, row, amount, input.providerRef ?? '');
    } else {
      await this.recordFailed(
        tenantId,
        input.refundId,
        row.merchant_id,
        amount,
        input.providerRef ?? null,
        input.failureCode ?? 'refund_declined'
      );
    }
    return 'applied';
  }

  /** refund.settle + refund succeeded + intent refunded/partially: UNA tx. */
  private async recordSucceeded(
    tenantId: string,
    refundId: string,
    row: { payment_intent_id: string; merchant_id: string },
    amount: Money,
    providerRef: string
  ): Promise<void> {
    await this.posting.settleRefund({
      tenantId,
      merchantId: row.merchant_id,
      idempotencyKey: `refund:${refundId}:settle`,
      sourceType: 'refund',
      sourceId: refundId,
      amount,
      onPosted: async (client) => {
        await this.transitionRefund(client, refundId, 'succeeded', { providerRef });
        const updated = await client.query<{
          amount_refunded: string;
          amount_captured: string;
        }>(
          `UPDATE payment_intents SET amount_refunded = amount_refunded + $2
           WHERE id = $1
           RETURNING amount_refunded::text, amount_captured::text`,
          [row.payment_intent_id, amount.amount.toString()]
        );
        const target =
          updated.rows[0]!.amount_refunded === updated.rows[0]!.amount_captured
            ? 'refunded'
            : 'partially_refunded';
        await this.intents.transitionIn(client, row.payment_intent_id, target);
      },
    });
  }

  /** refund.cancel (reserva de vuelta) + refund failed: UNA tx. */
  private async recordFailed(
    tenantId: string,
    refundId: string,
    merchantId: string,
    amount: Money,
    providerRef: string | null,
    failureCode: string
  ): Promise<void> {
    await this.posting.cancelRefundReservation({
      tenantId,
      merchantId,
      idempotencyKey: `refund:${refundId}:cancel`,
      sourceType: 'refund',
      sourceId: refundId,
      amount,
      onPosted: async (client) => {
        await this.transitionRefund(client, refundId, 'failed', { failureCode, providerRef });
      },
    });
  }

  /**
   * `indeterminate` es un estado OPERATIVO interno (dinero en desenlace
   * desconocido), no un evento del comercio: no emite webhook. El comercio ve
   * `processing` hasta que una fuente verificada lo cierre en succeeded/failed.
   */
  private async recordIndeterminate(tenantId: string, refundId: string): Promise<void> {
    await withTenantTransaction(this.appPool, tenantId, (c) =>
      this.transitionRefund(c, refundId, 'indeterminate', { silent: true })
    );
  }

  private async transitionRefund(
    c: TxClient,
    refundId: string,
    to: string,
    opts: { failureCode?: string; providerRef?: string | null; silent?: boolean }
  ): Promise<void> {
    // El trigger de 0020 re-valida contra refund_transitions al COMMIT.
    const res = await c.query<RefundRow>(
      `UPDATE refunds
       SET status = $2,
           updated_at = now(),
           resolved_at = CASE WHEN $2 IN ('succeeded', 'failed', 'canceled') THEN now() ELSE resolved_at END,
           failure_code = COALESCE($3, failure_code),
           provider_ref = COALESCE($4, provider_ref)
       WHERE id = $1
       RETURNING ${REFUND_COLUMNS}`,
      [refundId, to, opts.failureCode ?? null, opts.providerRef ?? null]
    );
    if (!res.rows[0]) throw new RefundNotFoundError();
    if (!opts.silent) await this.emit(c, toDto(res.rows[0]), to);
  }

  private async emit(c: TxClient, refund: RefundDto, status: string): Promise<void> {
    const envelope = buildEnvelope({
      producer: 'fluvia.payments',
      resource: { type: 'refund', id: refund.id },
      data: {
        refund_id: refund.id,
        payment_intent_id: refund.paymentIntentId,
        status,
        amount: refund.amount,
        currency: refund.currency,
        failure_code: refund.failureCode,
      },
    });
    await c.query(`INSERT INTO outbox_events (tenant_id, topic, payload) VALUES ($1, $2, $3)`, [
      refund.tenantId,
      `refund.${status}`,
      JSON.stringify(envelope),
    ]);
  }
}
