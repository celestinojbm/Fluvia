import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { Money } from '@fluvia/money';
import { SALE_RELEASING_STATUSES, type PaymentLinkService } from '@fluvia/payments-core';
import type { AuditHook } from './catalog.js';
import {
  CustomerNotVisibleError,
  OrderAmountOutOfRangeError,
  OrderCurrencyMismatchError,
  OrderNotCancellableError,
  OrderNotFoundError,
  OrderTotalMismatchError,
  ProductUnavailableError,
  hasEngineMessage,
} from './errors.js';
import { reserveForOrderIn } from './inventory.js';

/**
 * Pedidos (ventas con líneas, 0049).
 *
 * Crear un pedido = en UNA transacción (la de la idempotency key):
 *  1. leer los productos bajo RLS (FOR SHARE: una edición concurrente espera),
 *  2. calcular el total en el SERVIDOR (bigint, unidades menores),
 *  3. comparar con el total que vio el cajero (`expectedTotal`): si un precio
 *     cambió mientras armaba el carrito, NO se crea nada (409),
 *  4. crear el payment link de COBRO ÚNICO del pedido (0046) por ese total,
 *  5. insertar cabecera + líneas con la COPIA histórica de nombre/precio,
 *  6. RESERVAR las existencias de los productos que las controlan (0051).
 * El motor revalida Σ líneas = total y link = (comercio, total, moneda,
 * cobro único) al COMMIT.
 *
 * El estado de pago NO se guarda: se DERIVA de los payment_intents del link
 * (misma regla que `PaymentLinkService.getSale`). El plan de cuotas SANDBOX se
 * informa aparte y jamás cuenta como pago.
 */

export const ORDER_MAX_LINES = 50;
export const ORDER_MAX_QUANTITY = 999;

export interface CreateOrderInput {
  merchantId: string;
  currency: string;
  lines: Array<{ productId: string; quantity: number }>;
  customerId?: string | null;
  note?: string | null;
  /** Total (unidades menores) que el cajero revisó antes de confirmar. */
  expectedTotal: bigint;
  createdByUserId?: string | null;
}

export interface OrderLineDto {
  position: number;
  productId: string | null;
  name: string;
  sku: string | null;
  unitPrice: bigint;
  quantity: number;
  lineTotal: bigint;
  variantLabel: string | null;
}

/**
 * Estado de pago DERIVADO del pedido:
 *  - awaiting_payment: ningún cobro retiene ni cobró la venta.
 *  - payment_in_progress: un cobro está en curso o con desenlace INCIERTO
 *    (no cobrar de nuevo).
 *  - paid / partially_refunded / refunded: cobrado (y devoluciones).
 */
export type OrderPaymentState =
  | 'awaiting_payment'
  | 'payment_in_progress'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  /** Anulada por el comercio sin cobro (0051): ningún checkout suyo cobra. */
  | 'cancelled';

export interface OrderPaymentDto {
  state: OrderPaymentState;
  /** Intent que cobró o retiene la venta (null si awaiting_payment). */
  paymentIntentId: string | null;
  intentStatus: string | null;
  amountRefunded: bigint;
  /** Nº de checkouts abiertos para la venta (cualquier desenlace). */
  checkoutCount: number;
  /** Último checkout (para seguirlo en el POS). */
  latestSessionId: string | null;
  /** Estado del último intent (p. ej. `failed` = último intento rechazado). */
  latestIntentStatus: string | null;
}

export interface OrderInstallmentsSummary {
  planId: string;
  status: 'pending' | 'approved' | 'declined';
  installmentsCount: number;
  paidCount: number;
  overdueCount: number;
}

export interface OrderDto {
  id: string;
  number: number;
  merchantId: string;
  merchantName: string | null;
  customerId: string | null;
  customerName: string | null;
  currency: string;
  total: bigint;
  lineCount: number;
  note: string | null;
  paymentLinkId: string;
  createdByUserId: string | null;
  createdAt: string;
  payment: OrderPaymentDto;
  /** Último plan de cuotas SANDBOX del pedido (simulación; no es un pago). */
  installments: OrderInstallmentsSummary | null;
  cancellation: { reason: string; byUserId: string | null; createdAt: string } | null;
}

/** Estado de la reserva de existencias de un producto de la venta. */
export interface OrderStockDto {
  productId: string;
  quantity: number;
  /** reserved = retenida; sold = descontada por cobro confirmado; released = liberada al anular. */
  status: 'reserved' | 'sold' | 'released';
}

export interface OrderDetailDto extends OrderDto {
  lines: OrderLineDto[];
  stock: OrderStockDto[];
}

export interface OrderQuery {
  /** Número de pedido exacto o texto en nombre de cliente / nota. */
  q?: string;
  customerId?: string;
  state?: OrderPaymentState;
  /** Paginación por número descendente: pedidos con number < beforeNumber. */
  beforeNumber?: number;
  limit?: number;
}

const CHARGED = ['succeeded', 'partially_refunded', 'refunded'];

/** Proyección derivada del pago + plan sandbox, por pedido (LATERAL). */
const ORDER_SELECT = `
  SELECT o.id, o.number::text, o.merchant_id, m.name AS merchant_name, o.customer_id,
         cu.name AS customer_name, o.currency, o.total::text, o.line_count, o.note,
         o.payment_link_id, o.created_by_user_id, o.created_at,
         pay.charged_id, pay.charged_status, pay.charged_refunded, pay.holding_id,
         pay.holding_status, pay.checkout_count, pay.latest_session_id, pay.latest_status,
         plan.id AS plan_id, plan.status AS plan_status, plan.installments_count,
         plan.paid_count, plan.overdue_count,
         x.reason AS cancel_reason, x.cancelled_by_user_id, x.created_at AS cancelled_at
  FROM commerce_orders o
  LEFT JOIN merchants m ON m.id = o.merchant_id
  LEFT JOIN customers cu ON cu.id = o.customer_id
  LEFT JOIN commerce_order_cancellations x ON x.order_id = o.id
  LEFT JOIN LATERAL (
    SELECT
      (array_agg(i.id ORDER BY i.created_at DESC) FILTER (WHERE i.status = ANY($1::text[])))[1]
        AS charged_id,
      (array_agg(i.status ORDER BY i.created_at DESC) FILTER (WHERE i.status = ANY($1::text[])))[1]
        AS charged_status,
      (array_agg(i.amount_refunded::text ORDER BY i.created_at DESC)
        FILTER (WHERE i.status = ANY($1::text[])))[1] AS charged_refunded,
      (array_agg(i.id ORDER BY i.created_at DESC) FILTER (WHERE NOT (i.status = ANY($2::text[]))))[1]
        AS holding_id,
      (array_agg(i.status ORDER BY i.created_at DESC)
        FILTER (WHERE NOT (i.status = ANY($2::text[]))))[1] AS holding_status,
      count(*)::int AS checkout_count,
      (array_agg(cs.id ORDER BY i.created_at DESC) FILTER (WHERE cs.id IS NOT NULL))[1]
        AS latest_session_id,
      (array_agg(i.status ORDER BY i.created_at DESC))[1] AS latest_status
    FROM payment_intents i
    LEFT JOIN checkout_sessions cs ON cs.payment_intent_id = i.id
    WHERE i.payment_link_id = o.payment_link_id
  ) pay ON true
  LEFT JOIN LATERAL (
    SELECT p.id, p.status, p.installments_count,
           (SELECT count(*)::int FROM sandbox_installments s
             WHERE s.plan_id = p.id AND s.status = 'paid_simulated') AS paid_count,
           (SELECT count(*)::int FROM sandbox_installments s
             WHERE s.plan_id = p.id AND s.status = 'overdue_simulated') AS overdue_count
    FROM sandbox_installment_plans p
    WHERE p.order_id = o.id
    ORDER BY p.created_at DESC LIMIT 1
  ) plan ON true`;

interface OrderRow {
  id: string;
  number: string;
  merchant_id: string;
  merchant_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  currency: string;
  total: string;
  line_count: number;
  note: string | null;
  payment_link_id: string;
  created_by_user_id: string | null;
  created_at: Date;
  charged_id: string | null;
  charged_status: string | null;
  charged_refunded: string | null;
  holding_id: string | null;
  holding_status: string | null;
  checkout_count: number | null;
  latest_session_id: string | null;
  latest_status: string | null;
  plan_id: string | null;
  plan_status: 'pending' | 'approved' | 'declined' | null;
  installments_count: number | null;
  paid_count: number | null;
  overdue_count: number | null;
  cancel_reason: string | null;
  cancelled_by_user_id: string | null;
  cancelled_at: Date | null;
}

/** Regla única de derivación (pura, testeable). */
export function deriveOrderPayment(r: {
  charged_id: string | null;
  charged_status: string | null;
  charged_refunded: string | null;
  holding_id: string | null;
  holding_status: string | null;
  checkout_count: number | null;
  latest_session_id: string | null;
  latest_status: string | null;
  cancelled_at?: Date | null;
}): OrderPaymentDto {
  const base = {
    checkoutCount: r.checkout_count ?? 0,
    latestSessionId: r.latest_session_id,
    latestIntentStatus: r.latest_status,
  };
  if (r.charged_id) {
    const s = r.charged_status;
    return {
      ...base,
      state:
        s === 'refunded' ? 'refunded' : s === 'partially_refunded' ? 'partially_refunded' : 'paid',
      paymentIntentId: r.charged_id,
      intentStatus: s,
      amountRefunded: BigInt(r.charged_refunded ?? '0'),
    };
  }
  if (r.holding_id) {
    return {
      ...base,
      state: 'payment_in_progress',
      paymentIntentId: r.holding_id,
      intentStatus: r.holding_status,
      amountRefunded: 0n,
    };
  }
  return {
    ...base,
    // El motor impide anular con un cobro que retiene la venta: solo una venta
    // sin cobro puede estar anulada.
    state: r.cancelled_at ? 'cancelled' : 'awaiting_payment',
    paymentIntentId: null,
    intentStatus: null,
    amountRefunded: 0n,
  };
}

function toOrder(r: OrderRow): OrderDto {
  return {
    id: r.id,
    number: Number(r.number),
    merchantId: r.merchant_id,
    merchantName: r.merchant_name,
    customerId: r.customer_id,
    customerName: r.customer_name,
    currency: r.currency.trim(),
    total: BigInt(r.total),
    lineCount: r.line_count,
    note: r.note,
    paymentLinkId: r.payment_link_id,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at.toISOString(),
    payment: deriveOrderPayment(r),
    installments: r.plan_id
      ? {
          planId: r.plan_id,
          status: r.plan_status!,
          installmentsCount: r.installments_count ?? 0,
          paidCount: r.paid_count ?? 0,
          overdueCount: r.overdue_count ?? 0,
        }
      : null,
    cancellation: r.cancelled_at
      ? {
          reason: r.cancel_reason ?? '',
          byUserId: r.cancelled_by_user_id,
          createdAt: r.cancelled_at.toISOString(),
        }
      : null,
  };
}

const STATE_SQL: Record<OrderPaymentState, string> = {
  paid: `pay.charged_status = 'succeeded'`,
  partially_refunded: `pay.charged_status = 'partially_refunded'`,
  refunded: `pay.charged_status = 'refunded'`,
  payment_in_progress: `pay.charged_id IS NULL AND pay.holding_id IS NOT NULL`,
  awaiting_payment: `pay.charged_id IS NULL AND pay.holding_id IS NULL AND x.id IS NULL`,
  cancelled: `x.id IS NOT NULL`,
};

export class OrderService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool,
    private readonly paymentLinks: PaymentLinkService
  ) {}

  /** Client-bound: compone con la idempotencia (misma tx que la key). */
  async createIn(
    c: PoolClient,
    tenantId: string,
    input: CreateOrderInput
  ): Promise<OrderDetailDto> {
    const currency = Money.of(0n, input.currency).currency; // valida el código

    if (input.customerId) {
      const cu = await c.query(`SELECT 1 FROM customers WHERE id = $1 AND deleted_at IS NULL`, [
        input.customerId,
      ]);
      if ((cu.rowCount ?? 0) === 0) throw new CustomerNotVisibleError();
    }

    const ids = input.lines.map((l) => l.productId);
    const prods = await c.query<{
      id: string;
      name: string;
      sku: string | null;
      price: string;
      currency: string;
      available: boolean;
      archived_at: Date | null;
      track_stock: boolean;
      variant_label: string | null;
    }>(
      `SELECT id, name, sku, price::text, currency, available, archived_at, track_stock,
              variant_label
       FROM catalog_products WHERE id = ANY($1::uuid[]) FOR SHARE`,
      [ids]
    );
    const byId = new Map(prods.rows.map((p) => [p.id, p]));

    let total = 0n;
    const lines: OrderLineDto[] = input.lines.map((l, i) => {
      const p = byId.get(l.productId);
      if (!p || p.archived_at !== null || !p.available) {
        throw new ProductUnavailableError(l.productId);
      }
      if (p.currency.trim() !== currency) throw new OrderCurrencyMismatchError();
      const unit = BigInt(p.price);
      const lineTotal = unit * BigInt(l.quantity);
      total += lineTotal;
      return {
        position: i + 1,
        productId: p.id,
        name: p.name,
        sku: p.sku,
        unitPrice: unit,
        quantity: l.quantity,
        lineTotal,
        variantLabel: p.variant_label,
      };
    });
    if (total <= 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new OrderAmountOutOfRangeError();
    }
    if (total !== input.expectedTotal) throw new OrderTotalMismatchError();

    const counter = await c.query<{ last_number: string }>(
      `INSERT INTO commerce_order_counters (tenant_id, last_number) VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET last_number = commerce_order_counters.last_number + 1
       RETURNING last_number::text`,
      [tenantId]
    );
    const number = Number(counter.rows[0]!.last_number);

    // La venta de COBRO ÚNICO del pedido (0046): el cobro sigue el flujo
    // existente (checkout alojado + guardas de doble cobro e incertidumbre).
    const link = await this.paymentLinks.createIn(c, tenantId, {
      merchantId: input.merchantId,
      amount: total,
      currency,
      description: `Pedido #${number}`,
      metadata: { order_number: String(number) },
      singleCharge: true,
    });

    const ins = await c.query<{ id: string }>(
      `INSERT INTO commerce_orders
         (tenant_id, number, merchant_id, customer_id, currency, total, line_count, note,
          payment_link_id, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        tenantId,
        number,
        input.merchantId,
        input.customerId ?? null,
        currency,
        total.toString(),
        lines.length,
        input.note?.trim() ? input.note.trim() : null,
        link.id,
        input.createdByUserId ?? null,
      ]
    );
    const orderId = ins.rows[0]!.id;
    for (const l of lines) {
      await c.query(
        `INSERT INTO commerce_order_lines
           (tenant_id, order_id, position, product_id, name, sku, unit_price, quantity,
            line_total, currency, variant_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          tenantId,
          orderId,
          l.position,
          l.productId,
          l.name,
          l.sku,
          l.unitPrice.toString(),
          l.quantity,
          l.lineTotal.toString(),
          currency,
          l.variantLabel,
        ]
      );
    }
    await reserveForOrderIn(
      c,
      tenantId,
      orderId,
      lines.map((l) => ({
        productId: l.productId!,
        quantity: l.quantity,
        trackStock: byId.get(l.productId!)!.track_stock,
      }))
    );
    return this.getIn(c, orderId);
  }

  async getIn(c: PoolClient, orderId: string): Promise<OrderDetailDto> {
    const res = await c.query<OrderRow>(`${ORDER_SELECT} WHERE o.id = $3`, [
      CHARGED,
      SALE_RELEASING_STATUSES,
      orderId,
    ]);
    if (!res.rows[0]) throw new OrderNotFoundError();
    const lines = await c.query<{
      position: number;
      product_id: string | null;
      name: string;
      sku: string | null;
      unit_price: string;
      quantity: number;
      line_total: string;
      variant_label: string | null;
    }>(
      `SELECT position, product_id, name, sku, unit_price::text, quantity, line_total::text,
              variant_label
       FROM commerce_order_lines WHERE order_id = $1 ORDER BY position`,
      [orderId]
    );
    const stock = await c.query<{ product_id: string; quantity: number; settled: string | null }>(
      `SELECT r.product_id, r.quantity,
              (SELECT s.kind FROM inventory_movements s
                WHERE s.order_id = r.order_id AND s.product_id = r.product_id
                  AND s.kind IN ('release', 'sale')) AS settled
       FROM inventory_movements r
       WHERE r.order_id = $1 AND r.kind = 'reservation'
       ORDER BY r.product_id`,
      [orderId]
    );
    return {
      ...toOrder(res.rows[0]),
      stock: stock.rows.map((x) => ({
        productId: x.product_id,
        quantity: x.quantity,
        status: x.settled === 'sale' ? 'sold' : x.settled === 'release' ? 'released' : 'reserved',
      })),
      lines: lines.rows.map((l) => ({
        position: l.position,
        productId: l.product_id,
        name: l.name,
        sku: l.sku,
        unitPrice: BigInt(l.unit_price),
        quantity: l.quantity,
        lineTotal: BigInt(l.line_total),
        variantLabel: l.variant_label,
      })),
    };
  }

  async get(tenantId: string, orderId: string): Promise<OrderDetailDto> {
    return withTenantTransaction(this.appPool, tenantId, (c) => this.getIn(c, orderId));
  }

  /** Pedido de un payment link (para el POS y el checkout del comprador). */
  async findByLinkIn(c: PoolClient, linkId: string): Promise<OrderDetailDto | null> {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM commerce_orders WHERE payment_link_id = $1`,
      [linkId]
    );
    return r.rows[0] ? this.getIn(c, r.rows[0].id) : null;
  }

  async findByLink(tenantId: string, linkId: string): Promise<OrderDetailDto | null> {
    return withTenantTransaction(this.appPool, tenantId, (c) => this.findByLinkIn(c, linkId));
  }

  async list(
    tenantId: string,
    query: OrderQuery = {}
  ): Promise<{ data: OrderDto[]; hasMore: boolean }> {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 25), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const values: unknown[] = [CHARGED, SALE_RELEASING_STATUSES];
      const where: string[] = [];
      if (query.customerId) {
        values.push(query.customerId);
        where.push(`o.customer_id = $${values.length}`);
      }
      if (query.beforeNumber !== undefined) {
        values.push(query.beforeNumber);
        where.push(`o.number < $${values.length}`);
      }
      const q = query.q?.trim().replace(/^#/, '');
      if (q) {
        if (/^\d{1,15}$/.test(q)) {
          values.push(Number(q));
          where.push(`o.number = $${values.length}`);
        } else {
          values.push(`%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
          // Cliente, nota, o un producto vendido (nombre o SKU de una línea).
          where.push(
            `(cu.name ILIKE $${values.length} OR o.note ILIKE $${values.length}
              OR EXISTS (SELECT 1 FROM commerce_order_lines ol WHERE ol.order_id = o.id
                AND (ol.name ILIKE $${values.length} OR ol.sku ILIKE $${values.length})))`
          );
        }
      }
      if (query.state) where.push(STATE_SQL[query.state]);
      values.push(limit + 1);
      const res = await c.query<OrderRow>(
        `${ORDER_SELECT}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY o.number DESC
         LIMIT $${values.length}`,
        values
      );
      const rows = res.rows.map(toOrder);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }

  /**
   * Anula una venta SIN cobro: libera sus reservas y desactiva su link. El
   * motor la rechaza si un cobro la retiene (en curso, incierto o cobrado) o
   * tiene un plan de cuotas vivo, bajo el mismo lock del link que la
   * confirmación de pagos. Reanular una venta ya anulada devuelve la venta.
   */
  async cancel(
    tenantId: string,
    orderId: string,
    input: { reason: string; userId?: string | null },
    audit?: AuditHook<OrderDetailDto>
  ): Promise<{ order: OrderDetailDto; replayed: boolean }> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const o = await c.query<{ payment_link_id: string }>(
        `SELECT payment_link_id FROM commerce_orders WHERE id = $1`,
        [orderId]
      );
      if (!o.rows[0]) throw new OrderNotFoundError();
      const done = await c.query(`SELECT 1 FROM commerce_order_cancellations WHERE order_id = $1`, [
        orderId,
      ]);
      if ((done.rowCount ?? 0) > 0) return { order: await this.getIn(c, orderId), replayed: true };
      let inserted: number;
      try {
        // ON CONFLICT: dos anulaciones simultáneas ⇒ la segunda es un replay.
        const ins = await c.query(
          `INSERT INTO commerce_order_cancellations (tenant_id, order_id, reason, cancelled_by_user_id)
           VALUES ($1, $2, $3, $4) ON CONFLICT (order_id) DO NOTHING RETURNING id`,
          [tenantId, orderId, input.reason.trim(), input.userId ?? null]
        );
        inserted = ins.rowCount ?? 0;
      } catch (err) {
        if (hasEngineMessage(err, 'FLUVIA_ORDER_NOT_CANCELLABLE')) {
          throw new OrderNotCancellableError();
        }
        throw err;
      }
      if (inserted === 0) return { order: await this.getIn(c, orderId), replayed: true };
      await c.query(
        `INSERT INTO inventory_movements (tenant_id, product_id, kind, quantity, order_id)
         SELECT tenant_id, product_id, 'release', quantity, order_id
         FROM inventory_movements r
         WHERE r.order_id = $1 AND r.kind = 'reservation'
           AND NOT EXISTS (SELECT 1 FROM inventory_movements s WHERE s.order_id = r.order_id
                             AND s.product_id = r.product_id AND s.kind IN ('release', 'sale'))`,
        [orderId]
      );
      await c.query(
        `UPDATE payment_links SET status = 'disabled', disabled_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'active'`,
        [o.rows[0].payment_link_id]
      );
      const order = await this.getIn(c, orderId);
      await audit?.(c, order);
      return { order, replayed: false };
    });
  }
}
