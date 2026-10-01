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
  installmentsSandbox: CurrencyFigure[];
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
      const [confirmed, inFlight, refundsConfirmed, refundsOpen, orders, awaiting, inst] =
        await Promise.all([
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
        installmentsSandbox: inst,
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
