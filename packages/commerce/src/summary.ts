import { withTenantTransaction, type Pool } from '@fluvia/db';
import { SALE_RELEASING_STATUSES } from '@fluvia/payments-core';

/**
 * Indicadores del panel y de la caja, calculados en SQL sobre las tablas
 * reales (no sobre una ventana de 100 filas en el navegador).
 *
 * Definiciones (las mismas que muestra la UI junto a cada cifra):
 *  - confirmed: cobros cuyo payment_intent está succeeded / partially_refunded
 *    / refunded, CREADOS en el periodo (fecha de creación del cobro, UTC). Es
 *    importe COBRADO bruto: NO es saldo disponible (los fondos quedan
 *    pendientes de liquidación y ningún camino de producto los libera).
 *  - in_flight: cobros que hoy retienen su venta sin desenlace confirmado
 *    (processing, requires_action, authorized…), incluido el INCIERTO.
 *    Instantánea actual, sin periodo. NO son ingresos.
 *  - refunds_confirmed: devoluciones `succeeded` creadas en el periodo.
 *  - refunds_open: devoluciones created/processing/indeterminate (ahora).
 *  - orders: pedidos creados en el periodo y su importe (lo VENDIDO, cobrado
 *    o no).
 *  - installments_sandbox: planes de cuotas SIMULADOS aprobados en el
 *    periodo. Simulación: no es cobro, ni ingreso, ni saldo.
 *  - orders_cancelled: ventas del periodo anuladas sin cobro (0051).
 *  - balances (insights): SALDO del comercio en el ledger por moneda
 *    (pendiente de liquidación, disponible, reserva). Instantánea actual: es lo
 *    único que es «saldo»; lo vendido y lo cobrado no lo son.
 * Todo agrupado por moneda: jamás se suman monedas distintas.
 */

const CHARGED = ['succeeded', 'partially_refunded', 'refunded'];

export interface CurrencyFigure {
  currency: string;
  count: number;
  amount: bigint;
}

export interface CommerceSummary {
  periodStart: string;
  periodEnd: string;
  confirmed: CurrencyFigure[];
  inFlight: CurrencyFigure[];
  refundsConfirmed: CurrencyFigure[];
  refundsOpen: CurrencyFigure[];
  orders: CurrencyFigure[];
  ordersAwaitingPayment: CurrencyFigure[];
  ordersCancelled: CurrencyFigure[];
  installmentsSandbox: CurrencyFigure[];
}

/** Un día UTC de la serie de una moneda. */
export interface DayPoint {
  day: string;
  ordersCount: number;
  ordersAmount: bigint;
  confirmedCount: number;
  confirmedAmount: bigint;
  refundedAmount: bigint;
}

export interface TopProduct {
  productId: string | null;
  name: string;
  variantLabel: string | null;
  sku: string | null;
  quantity: number;
  amount: bigint;
}

export interface MerchantBalance {
  currency: string;
  /** merchant.pending: cobrado pendiente de liquidación (no disponible). */
  pending: bigint;
  /** merchant.available: liquidado y disponible para devoluciones/pagos. */
  available: bigint;
  /** merchant.reserve: retenido por reservas de riesgo. */
  reserve: bigint;
}

/** Evolución y ranking de UNA moneda en un periodo + saldo actual por moneda. */
export interface CommerceInsights {
  periodStart: string;
  periodEnd: string;
  currency: string;
  /** Monedas con actividad (pedidos o cobros) en el periodo, para el selector. */
  currencies: string[];
  series: DayPoint[];
  /** Días del periodo con al menos un pedido o cobro. */
  activeDays: number;
  /** Productos más vendidos en ventas COBRADAS del periodo (por cantidad). */
  topProducts: TopProduct[];
  balances: MerchantBalance[];
}

/** Desglose de caja de un periodo por canal y por estado. */
export interface CashSummary {
  periodStart: string;
  periodEnd: string;
  /** Cobros confirmados por canal: `pos_order` (pedido del POS) o `other`. */
  confirmedByChannel: Array<CurrencyFigure & { channel: 'pos_order' | 'other' }>;
  refundsByStatus: Array<CurrencyFigure & { status: string }>;
  /** Neto operativo = cobrado − devuelto confirmado, por moneda (NO saldo). */
  net: Array<{ currency: string; amount: bigint }>;
  installmentsSandboxByStatus: Array<CurrencyFigure & { status: string }>;
}

interface FigureRow {
  currency: string;
  n: number;
  amount: string;
}

const fig = (r: FigureRow): CurrencyFigure => ({
  currency: r.currency.trim(),
  count: r.n,
  amount: BigInt(r.amount),
});

export class SummaryService {
  constructor(private readonly appPool: Pool) {}

  async summary(tenantId: string, from: Date, to: Date): Promise<CommerceSummary> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const q = (sql: string, values: unknown[]) =>
        c.query<FigureRow>(sql, values).then((r) => r.rows.map(fig));
      const range = [from.toISOString(), to.toISOString()];
      const [
        confirmed,
        inFlight,
        refundsConfirmed,
        refundsOpen,
        orders,
        awaiting,
        inst,
        cancelled,
      ] = await Promise.all([
        q(
          `SELECT currency, count(*)::int AS n, coalesce(sum(amount), 0)::text AS amount
             FROM payment_intents
             WHERE status = ANY($3::text[]) AND created_at >= $1 AND created_at < $2
             GROUP BY currency ORDER BY currency`,
          [...range, CHARGED]
        ),
        q(
          `SELECT currency, count(*)::int AS n, coalesce(sum(amount), 0)::text AS amount
             FROM payment_intents
             WHERE NOT (status = ANY($1::text[])) AND NOT (status = ANY($2::text[]))
             GROUP BY currency ORDER BY currency`,
          [CHARGED, SALE_RELEASING_STATUSES]
        ),
        q(
          `SELECT currency, count(*)::int AS n, coalesce(sum(amount), 0)::text AS amount
             FROM refunds WHERE status = 'succeeded' AND created_at >= $1 AND created_at < $2
             GROUP BY currency ORDER BY currency`,
          range
        ),
        q(
          `SELECT currency, count(*)::int AS n, coalesce(sum(amount), 0)::text AS amount
             FROM refunds WHERE status IN ('created', 'processing', 'indeterminate')
             GROUP BY currency ORDER BY currency`,
          []
        ),
        q(
          `SELECT currency, count(*)::int AS n, coalesce(sum(total), 0)::text AS amount
             FROM commerce_orders WHERE created_at >= $1 AND created_at < $2
             GROUP BY currency ORDER BY currency`,
          range
        ),
        q(
          `SELECT o.currency, count(*)::int AS n, coalesce(sum(o.total), 0)::text AS amount
             FROM commerce_orders o
             WHERE o.created_at >= $1 AND o.created_at < $2
               AND NOT EXISTS (SELECT 1 FROM payment_intents i
                               WHERE i.payment_link_id = o.payment_link_id
                                 AND NOT (i.status = ANY($3::text[])))
               AND NOT EXISTS (SELECT 1 FROM commerce_order_cancellations x
                               WHERE x.order_id = o.id)
             GROUP BY o.currency ORDER BY o.currency`,
          [...range, SALE_RELEASING_STATUSES]
        ),
        q(
          `SELECT currency, count(*)::int AS n, coalesce(sum(total), 0)::text AS amount
             FROM sandbox_installment_plans
             WHERE status = 'approved' AND decided_at >= $1 AND decided_at < $2
             GROUP BY currency ORDER BY currency`,
          range
        ),
        q(
          `SELECT o.currency, count(*)::int AS n, coalesce(sum(o.total), 0)::text AS amount
             FROM commerce_orders o JOIN commerce_order_cancellations x ON x.order_id = o.id
             WHERE o.created_at >= $1 AND o.created_at < $2
             GROUP BY o.currency ORDER BY o.currency`,
          range
        ),
      ]);
      return {
        periodStart: range[0]!,
        periodEnd: range[1]!,
        confirmed,
        inFlight,
        refundsConfirmed,
        refundsOpen,
        orders,
        ordersAwaitingPayment: awaiting,
        ordersCancelled: cancelled,
        installmentsSandbox: inst,
      };
    });
  }

  /**
   * Evolución diaria (UTC) y productos más vendidos de UNA moneda, y el saldo
   * del ledger por moneda. `currency` ausente ⇒ la moneda con más pedidos del
   * periodo (o la primera con saldo).
   */
  async insights(
    tenantId: string,
    from: Date,
    to: Date,
    currency?: string
  ): Promise<CommerceInsights> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const range = [from.toISOString(), to.toISOString()];
      const cur = await c.query<{ currency: string; n: number }>(
        `SELECT currency, sum(n)::int AS n FROM (
           SELECT currency, count(*) AS n FROM commerce_orders
            WHERE created_at >= $1 AND created_at < $2 GROUP BY currency
           UNION ALL
           SELECT currency, count(*) AS n FROM payment_intents
            WHERE status = ANY($3::text[]) AND created_at >= $1 AND created_at < $2
            GROUP BY currency
         ) t GROUP BY currency ORDER BY n DESC, currency`,
        [...range, CHARGED]
      );
      const bal = await c.query<{
        currency: string;
        pending: string;
        available: string;
        reserve: string;
      }>(
        `SELECT a.currency,
                coalesce(sum(bp.available) FILTER (WHERE a.name LIKE 'merchant.pending:%'), 0)::text
                  AS pending,
                coalesce(sum(bp.available) FILTER (WHERE a.name LIKE 'merchant.available:%'), 0)::text
                  AS available,
                coalesce(sum(bp.available) FILTER (WHERE a.name LIKE 'merchant.reserve:%'), 0)::text
                  AS reserve
         FROM ledger_accounts a JOIN balance_projections bp ON bp.account_id = a.id
         WHERE a.deleted_at IS NULL AND a.name LIKE 'merchant.%'
         GROUP BY a.currency ORDER BY a.currency`
      );
      const balances = bal.rows.map((r) => ({
        currency: r.currency.trim(),
        pending: BigInt(r.pending),
        available: BigInt(r.available),
        reserve: BigInt(r.reserve),
      }));
      const currencies = cur.rows.map((r) => r.currency.trim());
      const chosen = currency ?? currencies[0] ?? balances[0]?.currency ?? null;
      if (!chosen) {
        return {
          periodStart: range[0]!,
          periodEnd: range[1]!,
          currency: '',
          currencies,
          series: [],
          activeDays: 0,
          topProducts: [],
          balances,
        };
      }
      const series = await c.query<{
        day: string;
        orders_n: number;
        orders_amount: string;
        confirmed_n: number;
        confirmed_amount: string;
        refunded_amount: string;
      }>(
        `WITH days AS (
           SELECT generate_series(date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC'),
                                  date_trunc('day', ($2::timestamptz - interval '1 microsecond')
                                                    AT TIME ZONE 'UTC'),
                                  interval '1 day') AS d
         )
         SELECT to_char(days.d, 'YYYY-MM-DD') AS day,
                coalesce(o.n, 0)::int AS orders_n, coalesce(o.amount, 0)::text AS orders_amount,
                coalesce(p.n, 0)::int AS confirmed_n,
                coalesce(p.amount, 0)::text AS confirmed_amount,
                coalesce(r.amount, 0)::text AS refunded_amount
         FROM days
         LEFT JOIN (
           SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS d, count(*) AS n,
                  sum(total) AS amount
           FROM commerce_orders
           WHERE currency = $3 AND created_at >= $1 AND created_at < $2 GROUP BY 1
         ) o ON o.d = days.d
         LEFT JOIN (
           SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS d, count(*) AS n,
                  sum(amount) AS amount
           FROM payment_intents
           WHERE currency = $3 AND status = ANY($4::text[])
             AND created_at >= $1 AND created_at < $2 GROUP BY 1
         ) p ON p.d = days.d
         LEFT JOIN (
           SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS d, sum(amount) AS amount
           FROM refunds
           WHERE currency = $3 AND status = 'succeeded'
             AND created_at >= $1 AND created_at < $2 GROUP BY 1
         ) r ON r.d = days.d
         ORDER BY days.d`,
        [...range, chosen, CHARGED]
      );
      const top = await c.query<{
        product_id: string | null;
        name: string;
        variant_label: string | null;
        sku: string | null;
        qty: number;
        amount: string;
      }>(
        `SELECT l.product_id, max(l.name) AS name, max(l.variant_label) AS variant_label,
                max(l.sku) AS sku, sum(l.quantity)::int AS qty, sum(l.line_total)::text AS amount
         FROM commerce_order_lines l
         JOIN commerce_orders o ON o.id = l.order_id
         WHERE o.currency = $3 AND o.created_at >= $1 AND o.created_at < $2
           AND EXISTS (SELECT 1 FROM payment_intents i
                       WHERE i.payment_link_id = o.payment_link_id
                         AND i.status = ANY($4::text[]))
         GROUP BY l.product_id, CASE WHEN l.product_id IS NULL THEN l.name END
         ORDER BY qty DESC, amount DESC, name
         LIMIT 5`,
        [...range, chosen, CHARGED]
      );
      const points = series.rows.map((r) => ({
        day: r.day,
        ordersCount: r.orders_n,
        ordersAmount: BigInt(r.orders_amount),
        confirmedCount: r.confirmed_n,
        confirmedAmount: BigInt(r.confirmed_amount),
        refundedAmount: BigInt(r.refunded_amount),
      }));
      return {
        periodStart: range[0]!,
        periodEnd: range[1]!,
        currency: chosen,
        currencies: currencies.includes(chosen) ? currencies : [...currencies, chosen],
        series: points,
        activeDays: points.filter((p) => p.ordersCount > 0 || p.confirmedCount > 0).length,
        topProducts: top.rows.map((t) => ({
          productId: t.product_id,
          name: t.name,
          variantLabel: t.variant_label,
          sku: t.sku,
          quantity: t.qty,
          amount: BigInt(t.amount),
        })),
        balances,
      };
    });
  }

  async cash(tenantId: string, from: Date, to: Date): Promise<CashSummary> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const range = [from.toISOString(), to.toISOString()];
      const byChannel = await c.query<FigureRow & { channel: 'pos_order' | 'other' }>(
        `SELECT i.currency,
                CASE WHEN o.id IS NULL THEN 'other' ELSE 'pos_order' END AS channel,
                count(*)::int AS n, coalesce(sum(i.amount), 0)::text AS amount
         FROM payment_intents i
         LEFT JOIN commerce_orders o ON o.payment_link_id = i.payment_link_id
         WHERE i.status = ANY($3::text[]) AND i.created_at >= $1 AND i.created_at < $2
         GROUP BY 1, 2 ORDER BY 1, 2`,
        [...range, CHARGED]
      );
      const refunds = await c.query<FigureRow & { status: string }>(
        `SELECT currency, status, count(*)::int AS n, coalesce(sum(amount), 0)::text AS amount
         FROM refunds WHERE created_at >= $1 AND created_at < $2
         GROUP BY 1, 2 ORDER BY 1, 2`,
        range
      );
      const inst = await c.query<FigureRow & { status: string }>(
        `SELECT currency, status, count(*)::int AS n, coalesce(sum(total), 0)::text AS amount
         FROM sandbox_installment_plans WHERE created_at >= $1 AND created_at < $2
         GROUP BY 1, 2 ORDER BY 1, 2`,
        range
      );
      const net = new Map<string, bigint>();
      for (const r of byChannel.rows) {
        const k = r.currency.trim();
        net.set(k, (net.get(k) ?? 0n) + BigInt(r.amount));
      }
      for (const r of refunds.rows) {
        if (r.status !== 'succeeded') continue;
        const k = r.currency.trim();
        net.set(k, (net.get(k) ?? 0n) - BigInt(r.amount));
      }
      return {
        periodStart: range[0]!,
        periodEnd: range[1]!,
        confirmedByChannel: byChannel.rows.map((r) => ({ ...fig(r), channel: r.channel })),
        refundsByStatus: refunds.rows.map((r) => ({ ...fig(r), status: r.status })),
        net: [...net.entries()].map(([currency, amount]) => ({ currency, amount })),
        installmentsSandboxByStatus: inst.rows.map((r) => ({ ...fig(r), status: r.status })),
      };
    });
  }
}
