import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import type { AuditHook } from './catalog.js';
import {
  InsufficientStockError,
  InventoryConflictError,
  ProductNotFoundError,
  StockNotTrackedError,
  hasEngineMessage,
  isCheckViolation,
} from './errors.js';

/**
 * Existencias (0051). Los niveles son una proyección que SOLO mantiene el
 * motor a partir de movimientos append-only:
 *
 *  - receipt / adjustment: el comercio (entradas y correcciones, con motivo).
 *  - reservation: al registrar una venta (OrderService, misma transacción).
 *  - sale: el MOTOR, cuando un cobro de la venta llega a `succeeded`.
 *  - release: al ANULAR la venta (OrderService.cancel).
 *
 * Nunca se descuenta en el navegador ni por un timeout: un cobro incierto o
 * rechazado deja la reserva intacta.
 */

export type MovementKind = 'receipt' | 'adjustment' | 'reservation' | 'release' | 'sale';

export interface MovementDto {
  id: string;
  productId: string;
  kind: MovementKind;
  quantity: number;
  orderId: string | null;
  orderNumber: number | null;
  reason: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface StockDto {
  productId: string;
  trackStock: boolean;
  onHand: bigint;
  reserved: bigint;
  free: bigint;
}

export interface StockChangeInput {
  kind: 'receipt' | 'adjustment';
  /** receipt > 0; adjustment ≠ 0 (negativo = merma o corrección a la baja). */
  quantity: number;
  reason: string;
  createdByUserId?: string | null;
}

interface MovementRow {
  id: string;
  product_id: string;
  kind: MovementKind;
  quantity: number;
  order_id: string | null;
  order_number: string | null;
  reason: string | null;
  created_by_user_id: string | null;
  created_at: Date;
}

const toMovement = (r: MovementRow): MovementDto => ({
  id: r.id,
  productId: r.product_id,
  kind: r.kind,
  quantity: r.quantity,
  orderId: r.order_id,
  orderNumber: r.order_number === null ? null : Number(r.order_number),
  reason: r.reason,
  createdByUserId: r.created_by_user_id,
  createdAt: r.created_at.toISOString(),
});

/**
 * Reserva las existencias de una venta recién creada (misma tx que el pedido).
 * Serializa las reservas de cada producto con un lock consultivo de la
 * transacción (en orden de id: sin interbloqueos entre ventas; la app no
 * tiene UPDATE sobre los niveles, así que no puede usar FOR UPDATE) y falla
 * con InsufficientStockError. Garantía final: el CHECK reservado ≤ existencia
 * del motor (una corrección concurrente a la baja también lo dispara).
 */
export async function reserveForOrderIn(
  c: PoolClient,
  tenantId: string,
  orderId: string,
  lines: Array<{ productId: string; quantity: number; trackStock: boolean }>
): Promise<void> {
  const qty = new Map<string, number>();
  for (const l of lines) {
    if (!l.trackStock) continue;
    qty.set(l.productId, (qty.get(l.productId) ?? 0) + l.quantity);
  }
  const ids = [...qty.keys()].sort();
  for (const productId of ids) {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('fluvia:stock:' || $1, 0))`, [
      productId,
    ]);
    const lv = await c.query<{ on_hand: string; reserved: string }>(
      `SELECT on_hand::text, reserved::text FROM inventory_levels WHERE product_id = $1`,
      [productId]
    );
    const free = lv.rows[0] ? BigInt(lv.rows[0].on_hand) - BigInt(lv.rows[0].reserved) : 0n;
    const want = BigInt(qty.get(productId)!);
    if (free < want) throw new InsufficientStockError(productId, free < 0n ? 0n : free);
    try {
      await c.query(
        `INSERT INTO inventory_movements (tenant_id, product_id, kind, quantity, order_id)
         VALUES ($1, $2, 'reservation', $3, $4)`,
        [tenantId, productId, Number(want), orderId]
      );
    } catch (err) {
      if (isCheckViolation(err, 'inventory_levels_reserved_chk')) {
        throw new InsufficientStockError(productId, 0n);
      }
      throw err;
    }
  }
}

export class InventoryService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool
  ) {}

  private async stockIn(c: PoolClient, productId: string): Promise<StockDto> {
    const r = await c.query<{
      track_stock: boolean;
      on_hand: string | null;
      reserved: string | null;
    }>(
      `SELECT p.track_stock, lv.on_hand::text, lv.reserved::text
       FROM catalog_products p LEFT JOIN inventory_levels lv ON lv.product_id = p.id
       WHERE p.id = $1`,
      [productId]
    );
    const row = r.rows[0];
    if (!row) throw new ProductNotFoundError();
    const onHand = BigInt(row.on_hand ?? '0');
    const reserved = BigInt(row.reserved ?? '0');
    return { productId, trackStock: row.track_stock, onHand, reserved, free: onHand - reserved };
  }

  async stock(tenantId: string, productId: string): Promise<StockDto> {
    return withTenantTransaction(this.appPool, tenantId, (c) => this.stockIn(c, productId));
  }

  /** Entrada o ajuste del comercio. Auditado en la misma transacción. */
  async change(
    tenantId: string,
    productId: string,
    input: StockChangeInput,
    audit?: AuditHook<{ stock: StockDto; movement: MovementDto }>
  ): Promise<{ stock: StockDto; movement: MovementDto }> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const out = await this.changeIn(c, tenantId, productId, input);
      await audit?.(c, out);
      return out;
    });
  }

  /**
   * Client-bound (compone con la idempotencia). Un fallo del motor aborta la
   * transacción: el error se traduce y se relanza, nunca se sigue usando `c`.
   */
  async changeIn(
    c: PoolClient,
    tenantId: string,
    productId: string,
    input: StockChangeInput
  ): Promise<{ stock: StockDto; movement: MovementDto }> {
    const p = await c.query<{ track_stock: boolean }>(
      `SELECT track_stock FROM catalog_products WHERE id = $1 FOR SHARE`,
      [productId]
    );
    if (!p.rows[0]) throw new ProductNotFoundError();
    if (!p.rows[0].track_stock) throw new StockNotTrackedError();
    let row: MovementRow;
    try {
      const ins = await c.query<MovementRow>(
        `INSERT INTO inventory_movements
           (tenant_id, product_id, kind, quantity, reason, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, product_id, kind, quantity, order_id, NULL::text AS order_number,
                   reason, created_by_user_id, created_at`,
        [
          tenantId,
          productId,
          input.kind,
          input.quantity,
          input.reason.trim(),
          input.createdByUserId ?? null,
        ]
      );
      row = ins.rows[0]!;
    } catch (err) {
      if (
        isCheckViolation(err, 'inventory_levels_reserved_chk') ||
        isCheckViolation(err, 'inventory_levels_on_hand_check')
      ) {
        throw new InventoryConflictError();
      }
      if (hasEngineMessage(err, 'FLUVIA_INVENTORY: product does not track stock')) {
        throw new StockNotTrackedError();
      }
      throw err;
    }
    return { stock: await this.stockIn(c, productId), movement: toMovement(row) };
  }

  async movements(tenantId: string, productId: string, limit = 50): Promise<MovementDto[]> {
    const n = Math.min(Math.max(Math.floor(limit), 1), 200);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<MovementRow>(
        `SELECT m.id, m.product_id, m.kind, m.quantity, m.order_id, o.number::text AS order_number,
                m.reason, m.created_by_user_id, m.created_at
         FROM inventory_movements m
         LEFT JOIN commerce_orders o ON o.id = m.order_id
         WHERE m.product_id = $1
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $2`,
        [productId, n]
      );
      return r.rows.map(toMovement);
    });
  }

  /** Excepciones registradas por el motor (no deberían existir). */
  async exceptions(tenantId: string): Promise<Array<{ orderId: string | null; detail: string }>> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<{ order_id: string | null; detail: string }>(
        `SELECT order_id, detail FROM inventory_exceptions ORDER BY created_at DESC LIMIT 20`
      );
      return r.rows.map((x) => ({ orderId: x.order_id, detail: x.detail }));
    });
  }
}
