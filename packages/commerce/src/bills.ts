import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { SALE_RELEASING_STATUSES, type PaymentLinkService } from '@fluvia/payments-core';
import { CommerceError, hasEngineMessage } from './errors.js';
import type { DiningService } from './dining.js';
import { DiningStateError, DiningVersionConflictError } from './dining.js';
import { VenueNotFoundError, assertVenue, venueCan, type VenueAccess } from './venue.js';

/**
 * CUENTA del pedido y asignación de pagos (0060). Cada fracción de la cuenta
 * (completa, por monto o por artículos) es una ASIGNACIÓN con su propio link
 * de COBRO ÚNICO: hereda todas las guardas existentes (un solo intent cobra,
 * un incierto retiene la fracción, devolución por intent). Las sumas son
 * exactas en unidades menores; el remanente = total − Σ asignaciones vivas.
 *
 * La cuenta pasa a `paid` SOLO cuando el servidor verifica que cada
 * asignación viva tiene un cobro confirmado y que suman el total. Ni la UI
 * ni un callback del cliente la cierran.
 */

const CHARGED = ['succeeded', 'partially_refunded', 'refunded'];

export type AllocationCharge = 'none' | 'failed' | 'in_progress' | 'charged';

export interface BillLineDto {
  id: string;
  lineId: string;
  name: string;
  quantity: number;
  lineTotal: bigint;
  modifiers: string[];
  /** Asignación viva por artículos que lo cubre, si la hay. */
  allocationId: string | null;
}
export interface AllocationDto {
  id: string;
  kind: 'full' | 'amount' | 'items';
  amount: bigint;
  label: string | null;
  paymentLinkId: string;
  payUrl: string;
  voided: boolean;
  voidReason: string | null;
  /** Estado del cobro DERIVADO de los intents del link (servidor). */
  charge: AllocationCharge;
  chargeIntentId: string | null;
  lineIds: string[];
  createdAt: string;
}
export interface BillDto {
  id: string;
  orderId: string;
  orderNumber: number;
  tableLabel: string | null;
  merchantId: string;
  currency: string;
  total: bigint;
  status: 'open' | 'paid' | 'void';
  version: number;
  lines: BillLineDto[];
  allocations: AllocationDto[];
  allocated: bigint;
  remainder: bigint;
  charged: bigint;
  /** Cobros confirmados sobre fracciones anuladas: requieren revisión. */
  anomalies: Array<{ allocationId: string; paymentIntentId: string }>;
  createdAt: string;
  closedAt: string | null;
}

export class BillNotFoundError extends CommerceError {
  constructor() {
    super('Bill not found');
  }
}
export class BillAllocationError extends CommerceError {
  constructor(message: string) {
    super(message);
  }
}
export class AllocationHeldError extends CommerceError {
  constructor() {
    super('The allocation has a payment charged or in progress');
  }
}

/**
 * Reparte `total` en `parts` importes enteros que suman EXACTAMENTE `total`;
 * el resto de la división va, de a una unidad menor, a las primeras partes.
 */
export function splitEvenly(total: bigint, parts: number): bigint[] {
  if (!Number.isInteger(parts) || parts < 1 || parts > 50) throw new RangeError('parts 1..50');
  if (total < BigInt(parts)) throw new RangeError('total smaller than parts');
  const n = BigInt(parts);
  const base = total / n;
  const rest = Number(total % n);
  return Array.from({ length: parts }, (_, i) => base + (i < rest ? 1n : 0n));
}

export class BillService {
  constructor(
    private readonly appPool: Pool,
    private readonly paymentLinks: PaymentLinkService,
    private readonly dining: DiningService
  ) {}

  /**
   * Abre la cuenta del pedido (tras «pedir la cuenta»). Copia las líneas no
   * anuladas con su precio histórico. Idempotente: si ya hay una cuenta viva,
   * la devuelve.
   */
  async open(tenantId: string, access: VenueAccess, orderId: string): Promise<BillDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const o = await c.query<{ branch_id: string; status: string; currency: string }>(
        `SELECT branch_id, status, currency FROM dining_orders WHERE id = $1 FOR UPDATE`,
        [orderId]
      );
      const order = o.rows[0];
      if (!order) throw new VenueNotFoundError('Order');
      assertVenue(access, 'bill:manage', order.branch_id);
      const live = await c.query<{ id: string }>(
        `SELECT id FROM dining_bills WHERE order_id = $1 AND status <> 'void'`,
        [orderId]
      );
      if (live.rows[0]) return this.getIn(c, live.rows[0].id);
      if (order.status !== 'bill_requested') {
        throw new DiningStateError('Request the bill before opening it');
      }
      const total = await this.dining.totalIn(c, orderId);
      if (total <= 0n) throw new BillAllocationError('Nothing to bill');
      const m = await c.query<{ id: string }>(
        `SELECT id FROM merchants WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`
      );
      if (!m.rows[0]) throw new VenueNotFoundError('Merchant');
      const b = await c.query<{ id: string }>(
        `INSERT INTO dining_bills (tenant_id, order_id, merchant_id, currency, total, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenantId, orderId, m.rows[0].id, order.currency.trim(), total.toString(), access.userId]
      );
      const billId = b.rows[0]!.id;
      await c.query(
        `INSERT INTO dining_bill_lines (tenant_id, bill_id, line_id, name, quantity, line_total, modifiers)
         SELECT tenant_id, $2, id, name, quantity, line_total,
                COALESCE((SELECT jsonb_agg(m->>'name') FROM jsonb_array_elements(modifiers) m), '[]'::jsonb)
           FROM dining_order_lines
          WHERE order_id = $1 AND voided_at IS NULL AND line_total > 0
          ORDER BY seq`,
        [orderId, billId]
      );
      await this.dining.event(
        c,
        tenantId,
        order.branch_id,
        orderId,
        null,
        'bill_opened',
        { total: total.toString() },
        access.userId
      );
      return this.getIn(c, billId);
    });
  }

  async get(tenantId: string, access: VenueAccess, billId: string): Promise<BillDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const bill = await this.settleIn(c, tenantId, billId);
      const branch = await this.branchOf(c, bill.orderId);
      if (!venueCan(access, 'bill:manage', branch) && !venueCan(access, 'bill:collect', branch)) {
        if (!venueCan(access, 'orders:view', branch)) throw new BillNotFoundError();
      }
      return bill;
    });
  }

  async forOrder(tenantId: string, access: VenueAccess, orderId: string): Promise<BillDto | null> {
    const r = await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM dining_bills WHERE order_id = $1 AND status <> 'void'`,
        [orderId]
      )
    );
    return r.rows[0] ? this.get(tenantId, access, r.rows[0].id) : null;
  }

  /**
   * Nueva fracción de la cuenta. `full` = toda la cuenta (sin otras vivas);
   * `amount` = importe ≤ remanente; `items` = artículos aún no asignados (su
   * suma ≤ remanente). Versión optimista + lock de la cuenta (dos cajeros).
   */
  async allocate(
    tenantId: string,
    access: VenueAccess,
    billId: string,
    input: {
      kind: 'full' | 'amount' | 'items';
      amount?: bigint;
      billLineIds?: string[];
      label?: string | null;
      expectedVersion: number;
    }
  ): Promise<BillDto> {
    return this.guard(() =>
      withTenantTransaction(this.appPool, tenantId, async (c) => {
        const b = await this.lockIn(c, tenantId, access, billId, input.expectedVersion);
        const live = await this.liveSumIn(c, billId);
        const remainder = BigInt(b.total) - live;
        let amount: bigint;
        let lineIds: string[] = [];
        if (input.kind === 'full') {
          if (live > 0n) throw new BillAllocationError('The bill already has allocations');
          amount = BigInt(b.total);
        } else if (input.kind === 'amount') {
          amount = input.amount ?? 0n;
          if (amount <= 0n || amount > remainder) {
            throw new BillAllocationError('Amount must be > 0 and <= remainder');
          }
        } else {
          lineIds = [...new Set(input.billLineIds ?? [])];
          if (lineIds.length === 0) throw new BillAllocationError('Select at least one item');
          const r = await c.query<{ id: string; line_total: string; taken: boolean }>(
            `SELECT l.id, l.line_total::text,
                    EXISTS (SELECT 1 FROM dining_bill_allocation_items i
                             WHERE i.bill_line_id = l.id AND i.active) AS taken
               FROM dining_bill_lines l WHERE l.bill_id = $1 AND l.id = ANY($2::uuid[])`,
            [billId, lineIds]
          );
          if (r.rows.length !== lineIds.length || r.rows.some((x) => x.taken)) {
            throw new BillAllocationError('Items unknown or already allocated');
          }
          amount = r.rows.reduce((s, x) => s + BigInt(x.line_total), 0n);
          if (amount > remainder) throw new BillAllocationError('Items exceed the remainder');
        }
        await this.insertAllocationIn(c, tenantId, b, {
          kind: input.kind,
          amount,
          label: input.label ?? null,
          lineIds,
          userId: access.userId,
        });
        return this.bumpAndGet(c, tenantId, billId);
      })
    );
  }

  /** Divide el REMANENTE en `parts` fracciones iguales (resto exacto). */
  async allocateEqual(
    tenantId: string,
    access: VenueAccess,
    billId: string,
    input: { parts: number; expectedVersion: number }
  ): Promise<BillDto> {
    return this.guard(() =>
      withTenantTransaction(this.appPool, tenantId, async (c) => {
        const b = await this.lockIn(c, tenantId, access, billId, input.expectedVersion);
        const remainder = BigInt(b.total) - (await this.liveSumIn(c, billId));
        let amounts: bigint[];
        try {
          amounts = splitEvenly(remainder, input.parts);
        } catch {
          throw new BillAllocationError('Cannot split the remainder in that many parts');
        }
        for (const [i, amount] of amounts.entries()) {
          await this.insertAllocationIn(c, tenantId, b, {
            kind: 'amount',
            amount,
            label: `Parte ${i + 1} de ${input.parts}`,
            lineIds: [],
            userId: access.userId,
          });
        }
        return this.bumpAndGet(c, tenantId, billId);
      })
    );
  }

  /**
   * Anula una fracción SIN cobro: bloquea su link, comprueba que ningún
   * intent cobró ni retiene, y lo deshabilita (0060 impide intents nuevos
   * sobre links inactivos). Con cobro: 409, se resuelve por devolución.
   */
  async voidAllocation(
    tenantId: string,
    access: VenueAccess,
    billId: string,
    input: { allocationId: string; reason: string; expectedVersion: number }
  ): Promise<BillDto> {
    return this.guard(() =>
      withTenantTransaction(this.appPool, tenantId, async (c) => {
        await this.lockIn(c, tenantId, access, billId, input.expectedVersion);
        const a = await c.query<{ payment_link_id: string; voided_at: Date | null }>(
          `SELECT payment_link_id, voided_at FROM dining_bill_allocations
            WHERE id = $1 AND bill_id = $2`,
          [input.allocationId, billId]
        );
        const alloc = a.rows[0];
        if (!alloc) throw new BillNotFoundError();
        if (alloc.voided_at) return this.getIn(c, billId);
        await c.query(`SELECT 1 FROM payment_links WHERE id = $1 FOR UPDATE`, [
          alloc.payment_link_id,
        ]);
        const held = await c.query(
          `SELECT 1 FROM payment_intents
            WHERE payment_link_id = $1 AND NOT (status = ANY($2::text[])) LIMIT 1`,
          [alloc.payment_link_id, SALE_RELEASING_STATUSES]
        );
        if ((held.rowCount ?? 0) > 0) throw new AllocationHeldError();
        await c.query(
          `UPDATE payment_links SET status = 'disabled', disabled_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'active'`,
          [alloc.payment_link_id]
        );
        await c.query(
          `UPDATE dining_bill_allocations SET voided_at = now(), void_reason = $2 WHERE id = $1`,
          [input.allocationId, input.reason.trim()]
        );
        await c.query(
          `UPDATE dining_bill_allocation_items SET active = false WHERE allocation_id = $1`,
          [input.allocationId]
        );
        return this.bumpAndGet(c, tenantId, billId);
      })
    );
  }

  /** Cuenta visible para el comensal con SU token de seguimiento. */
  async forTracking(token: string): Promise<{ tenantId: string; bill: BillDto } | null> {
    const ref = await this.dining.resolveTracking(token);
    if (!ref) return null;
    const bill = await withTenantTransaction(this.appPool, ref.tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM dining_bills WHERE order_id = $1 AND status <> 'void'`,
        [ref.orderId]
      );
      return r.rows[0] ? this.settleIn(c, ref.tenantId, r.rows[0].id) : null;
    });
    return bill ? { tenantId: ref.tenantId, bill } : null;
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  /**
   * Verificación en servidor: si cada asignación viva tiene cobro confirmado
   * y suman el total, la cuenta pasa a `paid` y el pedido a `closed`.
   */
  async settleIn(c: PoolClient, tenantId: string, billId: string): Promise<BillDto> {
    const bill = await this.getIn(c, billId);
    if (bill.status !== 'open') return bill;
    const live = bill.allocations.filter((a) => !a.voided);
    const allCharged = live.length > 0 && live.every((a) => a.charge === 'charged');
    if (!allCharged || bill.charged !== bill.total) return bill;
    const upd = await c.query<{ order_id: string }>(
      `UPDATE dining_bills SET status = 'paid', closed_at = now(), version = version + 1
        WHERE id = $1 AND status = 'open' RETURNING order_id`,
      [billId]
    );
    if (upd.rows[0]) {
      const o = await c.query<{ branch_id: string }>(
        `UPDATE dining_orders SET status = 'closed', version = version + 1, updated_at = now()
          WHERE id = $1 AND status = 'bill_requested' RETURNING branch_id`,
        [upd.rows[0].order_id]
      );
      if (o.rows[0]) {
        await this.dining.event(
          c,
          tenantId,
          o.rows[0].branch_id,
          upd.rows[0].order_id,
          null,
          'bill_paid',
          { total: bill.total.toString() },
          null
        );
      }
    }
    return this.getIn(c, billId);
  }

  async getIn(c: PoolClient, billId: string): Promise<BillDto> {
    const b = await c.query<{
      id: string;
      order_id: string;
      merchant_id: string;
      currency: string;
      total: string;
      status: BillDto['status'];
      version: number;
      created_at: Date;
      closed_at: Date | null;
      number: string;
      table_label: string | null;
    }>(
      `SELECT b.id, b.order_id, b.merchant_id, b.currency, b.total::text, b.status, b.version,
              b.created_at, b.closed_at, o.number::text, t.label AS table_label
         FROM dining_bills b JOIN dining_orders o ON o.id = b.order_id
         LEFT JOIN venue_tables t ON t.id = o.table_id
        WHERE b.id = $1`,
      [billId]
    );
    const row = b.rows[0];
    if (!row) throw new BillNotFoundError();
    const lines = await c.query<{
      id: string;
      line_id: string;
      name: string;
      quantity: number;
      line_total: string;
      modifiers: string[];
      allocation_id: string | null;
    }>(
      `SELECT l.id, l.line_id, l.name, l.quantity, l.line_total::text, l.modifiers,
              (SELECT i.allocation_id FROM dining_bill_allocation_items i
                WHERE i.bill_line_id = l.id AND i.active) AS allocation_id
         FROM dining_bill_lines l JOIN dining_order_lines ol ON ol.id = l.line_id
        WHERE l.bill_id = $1 ORDER BY ol.seq`,
      [billId]
    );
    const allocs = await c.query<{
      id: string;
      kind: AllocationDto['kind'];
      amount: string;
      label: string | null;
      payment_link_id: string;
      voided_at: Date | null;
      void_reason: string | null;
      created_at: Date;
      charged_id: string | null;
      holding_id: string | null;
      failed: boolean;
      line_ids: string[] | null;
    }>(
      `SELECT a.id, a.kind, a.amount::text, a.label, a.payment_link_id, a.voided_at,
              a.void_reason, a.created_at,
              (SELECT p.id FROM payment_intents p WHERE p.payment_link_id = a.payment_link_id
                 AND p.status = ANY($2::text[]) ORDER BY p.created_at DESC LIMIT 1) AS charged_id,
              (SELECT p.id FROM payment_intents p WHERE p.payment_link_id = a.payment_link_id
                 AND NOT (p.status = ANY($3::text[])) ORDER BY p.created_at DESC LIMIT 1) AS holding_id,
              EXISTS (SELECT 1 FROM payment_intents p WHERE p.payment_link_id = a.payment_link_id
                 AND p.status = 'failed') AS failed,
              (SELECT array_agg(i.bill_line_id) FROM dining_bill_allocation_items i
                WHERE i.allocation_id = a.id) AS line_ids
         FROM dining_bill_allocations a WHERE a.bill_id = $1 ORDER BY a.created_at, a.id`,
      [billId, CHARGED, SALE_RELEASING_STATUSES]
    );
    const allocations: AllocationDto[] = allocs.rows.map((a) => ({
      id: a.id,
      kind: a.kind,
      amount: BigInt(a.amount),
      label: a.label,
      paymentLinkId: a.payment_link_id,
      payUrl: this.paymentLinks.urlFor(a.payment_link_id),
      voided: a.voided_at !== null,
      voidReason: a.void_reason,
      charge: a.charged_id
        ? 'charged'
        : a.holding_id
          ? 'in_progress'
          : a.failed
            ? 'failed'
            : 'none',
      chargeIntentId: a.charged_id ?? a.holding_id,
      lineIds: a.line_ids ?? [],
      createdAt: a.created_at.toISOString(),
    }));
    const liveAllocs = allocations.filter((a) => !a.voided);
    const allocated = liveAllocs.reduce((s, a) => s + a.amount, 0n);
    const charged = liveAllocs
      .filter((a) => a.charge === 'charged')
      .reduce((s, a) => s + a.amount, 0n);
    const total = BigInt(row.total);
    return {
      id: row.id,
      orderId: row.order_id,
      orderNumber: Number(row.number),
      tableLabel: row.table_label,
      merchantId: row.merchant_id,
      currency: row.currency.trim(),
      total,
      status: row.status,
      version: row.version,
      lines: lines.rows.map((l) => ({
        id: l.id,
        lineId: l.line_id,
        name: l.name,
        quantity: l.quantity,
        lineTotal: BigInt(l.line_total),
        modifiers: l.modifiers,
        allocationId: l.allocation_id,
      })),
      allocations,
      allocated,
      remainder: total - allocated,
      charged,
      anomalies: allocations
        .filter((a) => a.voided && a.charge === 'charged' && a.chargeIntentId)
        .map((a) => ({ allocationId: a.id, paymentIntentId: a.chargeIntentId! })),
      createdAt: row.created_at.toISOString(),
      closedAt: row.closed_at?.toISOString() ?? null,
    };
  }

  private async lockIn(
    c: PoolClient,
    _tenantId: string,
    access: VenueAccess,
    billId: string,
    expectedVersion: number
  ) {
    const r = await c.query<{
      id: string;
      total: string;
      version: number;
      status: string;
      currency: string;
      merchant_id: string;
      order_id: string;
      branch_id: string;
      number: string;
      table_label: string | null;
    }>(
      `SELECT b.id, b.total::text, b.version, b.status, b.currency, b.merchant_id, b.order_id,
              o.branch_id, o.number::text, t.label AS table_label
         FROM dining_bills b JOIN dining_orders o ON o.id = b.order_id
         LEFT JOIN venue_tables t ON t.id = o.table_id
        WHERE b.id = $1 FOR UPDATE OF b`,
      [billId]
    );
    const b = r.rows[0];
    if (!b) throw new BillNotFoundError();
    assertVenue(access, 'bill:manage', b.branch_id);
    if (b.version !== expectedVersion) throw new DiningVersionConflictError();
    if (b.status !== 'open') throw new DiningStateError('The bill is not open');
    return b;
  }

  private async liveSumIn(c: PoolClient, billId: string): Promise<bigint> {
    const r = await c.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS s FROM dining_bill_allocations
        WHERE bill_id = $1 AND voided_at IS NULL`,
      [billId]
    );
    return BigInt(r.rows[0]!.s);
  }

  private async insertAllocationIn(
    c: PoolClient,
    tenantId: string,
    b: {
      id: string;
      currency: string;
      merchant_id: string;
      number: string;
      table_label: string | null;
    },
    input: {
      kind: AllocationDto['kind'];
      amount: bigint;
      label: string | null;
      lineIds: string[];
      userId: string;
    }
  ): Promise<void> {
    const where = b.table_label ? `Mesa ${b.table_label} · ` : '';
    const link = await this.paymentLinks.createIn(c, tenantId, {
      merchantId: b.merchant_id,
      amount: input.amount,
      currency: b.currency.trim(),
      description: `${where}Pedido #${b.number}${input.label ? ` · ${input.label}` : ''}`,
      metadata: { dining_bill_id: b.id, order_number: b.number },
      singleCharge: true,
    });
    const a = await c.query<{ id: string }>(
      `INSERT INTO dining_bill_allocations
         (tenant_id, bill_id, kind, amount, currency, payment_link_id, label, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp()) RETURNING id`,
      [
        tenantId,
        b.id,
        input.kind,
        input.amount.toString(),
        b.currency.trim(),
        link.id,
        input.label,
        input.userId,
      ]
    );
    for (const lineId of input.lineIds) {
      await c.query(
        `INSERT INTO dining_bill_allocation_items (tenant_id, allocation_id, bill_line_id)
         VALUES ($1, $2, $3)`,
        [tenantId, a.rows[0]!.id, lineId]
      );
    }
  }

  private async bumpAndGet(c: PoolClient, tenantId: string, billId: string): Promise<BillDto> {
    await c.query(`UPDATE dining_bills SET version = version + 1 WHERE id = $1`, [billId]);
    return this.settleIn(c, tenantId, billId);
  }

  private async branchOf(c: PoolClient, orderId: string): Promise<string> {
    const r = await c.query<{ branch_id: string }>(
      `SELECT branch_id FROM dining_orders WHERE id = $1`,
      [orderId]
    );
    if (!r.rows[0]) throw new BillNotFoundError();
    return r.rows[0].branch_id;
  }

  /** Traduce las invariantes del motor (al COMMIT) a errores de dominio. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (
        hasEngineMessage(err, 'FLUVIA_BILL_OVERALLOCATED') ||
        hasEngineMessage(err, 'FLUVIA_BILL_LINK_MISMATCH')
      ) {
        throw new BillAllocationError('Allocation rejected by the bill invariant');
      }
      if ((err as { code?: string }).code === '23505') {
        throw new BillAllocationError('Items already allocated');
      }
      throw err;
    }
  }
}
