import { createHash, randomBytes } from 'node:crypto';
import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { CommerceError } from './errors.js';
import {
  assertVenue,
  venueCan,
  VenueForbiddenError,
  VenueNotFoundError,
  type VenueAccess,
} from './venue.js';

/**
 * Pedidos de sala, comandas y pantalla de cocina (0059).
 *
 * Reglas auditables (cada una deja un evento en dining_events):
 *  - Añadir líneas: precio y modificadores del CATÁLOGO en ese momento
 *    (copia histórica); los modificadores se validan contra los grupos del
 *    producto (mínimo, máximo, disponibilidad).
 *  - Enviar a cocina: solo las líneas en borrador; una comanda por estación y
 *    una REVISIÓN nueva por envío. Nada se reenvía.
 *  - Anular una línea: con motivo. Si ya se envió, genera una comanda de
 *    ANULACIÓN para su estación; nunca se reescribe la original.
 *  - Mover mesa: misma sucursal y mesa destino libre.
 *  - Comandas: queued → accepted → preparing → ready → delivered. Recuperar
 *    (ready/delivered → preparing) exige motivo y permiso.
 *  - Concurrencia: versión esperada del pedido/comanda; el servidor rechaza
 *    con conflicto si otro usuario cambió antes.
 */

export type DiningMode = 'dine_in' | 'takeaway' | 'pickup';
export type OrderStatus =
  'pending_acceptance' | 'open' | 'bill_requested' | 'closed' | 'cancelled' | 'rejected';
export type PrepStatus = 'draft' | 'queued' | 'accepted' | 'preparing' | 'ready' | 'delivered';
export type TicketStatus = 'queued' | 'accepted' | 'preparing' | 'ready' | 'delivered';

export class DiningVersionConflictError extends CommerceError {
  constructor() {
    super('The order or ticket was changed by someone else; reload');
  }
}
export class DiningStateError extends CommerceError {
  constructor(message: string) {
    super(message);
  }
}
export class TableOccupiedError extends CommerceError {
  constructor() {
    super('The table already has an open order');
  }
}
export class ModifierSelectionError extends CommerceError {
  constructor(message: string) {
    super(message);
  }
}
export class DiningProductUnavailableError extends CommerceError {
  constructor(readonly productId: string) {
    super('Product not available');
  }
}

export interface ModifierSnapshot {
  optionId: string;
  groupName: string;
  name: string;
  priceDelta: string;
}
export interface DiningLineDto {
  id: string;
  seq: number;
  productId: string | null;
  name: string;
  unitPrice: bigint;
  modifiers: ModifierSnapshot[];
  modifiersTotal: bigint;
  quantity: number;
  lineTotal: bigint;
  note: string | null;
  stationCode: string;
  ticketId: string | null;
  prepStatus: PrepStatus;
  voided: boolean;
  voidReason: string | null;
  createdAt: string;
}
export interface TicketDto {
  id: string;
  orderId: string;
  number: number;
  revision: number;
  kind: 'new' | 'addition' | 'void';
  stationCode: string;
  status: TicketStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface DiningOrderDto {
  id: string;
  branchId: string;
  number: number;
  mode: DiningMode;
  tableId: string | null;
  tableLabel: string | null;
  source: 'staff' | 'customer';
  status: OrderStatus;
  currency: string;
  guestCount: number | null;
  customerName: string | null;
  note: string | null;
  attentionRequestedAt: string | null;
  version: number;
  total: bigint;
  lines: DiningLineDto[];
  tickets: TicketDto[];
  createdAt: string;
  updatedAt: string;
}
export interface KitchenTicketView extends TicketDto {
  orderNumber: number;
  mode: DiningMode;
  tableLabel: string | null;
  customerName: string | null;
  orderNote: string | null;
  items: Array<{
    lineId: string;
    name: string;
    quantity: number;
    modifiers: string[];
    note: string | null;
    voided: boolean;
    voidReason: string | null;
  }>;
}
export interface LineInput {
  productId: string;
  quantity: number;
  optionIds?: string[];
  note?: string;
}

const TICKET_NEXT: Record<TicketStatus, TicketStatus | null> = {
  queued: 'accepted',
  accepted: 'preparing',
  preparing: 'ready',
  ready: 'delivered',
  delivered: null,
};

export const hashTrackingToken = (t: string) => createHash('sha256').update(t).digest('hex');

export class DiningService {
  constructor(private readonly appPool: Pool) {}

  // ── Pedidos del personal ─────────────────────────────────────────────────
  async open(
    tenantId: string,
    access: VenueAccess,
    input: {
      branchId: string;
      mode: DiningMode;
      tableId?: string | null;
      guestCount?: number | null;
      customerName?: string | null;
      note?: string | null;
    }
  ): Promise<DiningOrderDto> {
    assertVenue(access, 'orders:open', input.branchId);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const currency = await this.currencyIn(c);
      const id = await this.insertOrderIn(c, tenantId, {
        ...input,
        source: 'staff',
        status: 'open',
        currency,
        openedBy: access.userId,
      });
      await this.event(c, tenantId, input.branchId, id, null, 'order_opened', {}, access.userId);
      return this.getIn(c, id);
    });
  }

  async get(tenantId: string, access: VenueAccess, orderId: string): Promise<DiningOrderDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const o = await this.getIn(c, orderId);
      if (
        !venueCan(access, 'orders:view', o.branchId) &&
        !venueCan(access, 'kitchen:view', o.branchId)
      ) {
        throw new VenueForbiddenError('orders:view');
      }
      return o;
    });
  }

  async list(
    tenantId: string,
    access: VenueAccess,
    branchId: string,
    scope: 'active' | 'recent' = 'active'
  ): Promise<DiningOrderDto[]> {
    assertVenue(access, 'orders:view', branchId);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        scope === 'active'
          ? `SELECT id FROM dining_orders WHERE branch_id = $1
               AND status IN ('pending_acceptance', 'open', 'bill_requested') ORDER BY created_at`
          : `SELECT id FROM dining_orders WHERE branch_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [branchId]
      );
      const out = [];
      for (const x of r.rows) out.push(await this.getIn(c, x.id));
      return out;
    });
  }

  async addLines(
    tenantId: string,
    access: VenueAccess,
    orderId: string,
    input: { expectedVersion: number; lines: LineInput[] }
  ): Promise<DiningOrderDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const o = await this.lockIn(c, orderId, input.expectedVersion);
      assertVenue(access, 'orders:add', o.branch_id);
      if (o.status !== 'open') throw new DiningStateError('Only open orders accept new items');
      await this.insertLinesIn(c, tenantId, o, input.lines, access.userId);
      await this.bumpIn(c, orderId);
      await this.event(
        c,
        tenantId,
        o.branch_id,
        orderId,
        null,
        'lines_added',
        {
          count: input.lines.length,
        },
        access.userId
      );
      return this.getIn(c, orderId);
    });
  }

  /** Envía las líneas en borrador: comandas nuevas (una por estación). */
  async sendToKitchen(
    tenantId: string,
    access: VenueAccess,
    orderId: string,
    expectedVersion: number
  ): Promise<{ order: DiningOrderDto; tickets: TicketDto[] }> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const o = await this.lockIn(c, orderId, expectedVersion);
      assertVenue(access, 'orders:send', o.branch_id);
      if (o.status !== 'open') throw new DiningStateError('Only open orders can be sent');
      const drafts = await c.query<{ id: string; station_code: string }>(
        `SELECT id, station_code FROM dining_order_lines
          WHERE order_id = $1 AND ticket_id IS NULL AND voided_at IS NULL ORDER BY seq`,
        [orderId]
      );
      const created: TicketDto[] = [];
      if (drafts.rows.length > 0) {
        const rev = await this.nextRevisionIn(c, orderId);
        const first = rev === 1;
        const stations = [...new Set(drafts.rows.map((d) => d.station_code))];
        for (const station of stations) {
          const t = await this.insertTicketIn(c, tenantId, {
            branchId: o.branch_id,
            orderId,
            revision: rev,
            kind: first ? 'new' : 'addition',
            station,
            actor: access.userId,
          });
          await c.query(
            `UPDATE dining_order_lines SET ticket_id = $2, prep_status = 'queued'
              WHERE order_id = $1 AND ticket_id IS NULL AND voided_at IS NULL AND station_code = $3`,
            [orderId, t.id, station]
          );
          created.push(t);
          await this.event(
            c,
            tenantId,
            o.branch_id,
            orderId,
            t.id,
            'ticket_created',
            {
              station,
              revision: rev,
              kind: t.kind,
            },
            access.userId
          );
        }
        await this.bumpIn(c, orderId);
      }
      return { order: await this.getIn(c, orderId), tickets: created };
    });
  }

  async voidLine(
    tenantId: string,
    access: VenueAccess,
    orderId: string,
    input: { lineId: string; reason: string; expectedVersion: number }
  ): Promise<DiningOrderDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const o = await this.lockIn(c, orderId, input.expectedVersion);
      if (o.status !== 'open' && o.status !== 'pending_acceptance') {
        throw new DiningStateError('Lines can only be voided on open orders');
      }
      const l = await c.query<{
        ticket_id: string | null;
        station_code: string;
        voided_at: Date | null;
      }>(
        `SELECT ticket_id, station_code, voided_at FROM dining_order_lines
          WHERE id = $1 AND order_id = $2 FOR UPDATE`,
        [input.lineId, orderId]
      );
      const line = l.rows[0];
      if (!line) throw new VenueNotFoundError('Line');
      if (line.voided_at) throw new DiningStateError('Line already voided');
      // Lo que no ha llegado a cocina lo quita quien añade; lo enviado exige
      // permiso de anulación y deja comanda de anulación.
      assertVenue(access, line.ticket_id ? 'orders:void_line' : 'orders:add', o.branch_id);
      let voidTicket: string | null = null;
      if (line.ticket_id) {
        const t = await this.insertTicketIn(c, tenantId, {
          branchId: o.branch_id,
          orderId,
          revision: await this.nextRevisionIn(c, orderId),
          kind: 'void',
          station: line.station_code,
          actor: access.userId,
        });
        voidTicket = t.id;
        await this.event(
          c,
          tenantId,
          o.branch_id,
          orderId,
          t.id,
          'ticket_created',
          {
            station: line.station_code,
            kind: 'void',
            line_id: input.lineId,
          },
          access.userId
        );
      }
      await c.query(
        `UPDATE dining_order_lines
            SET voided_at = now(), void_reason = $2, voided_by = $3, void_ticket_id = $4
          WHERE id = $1`,
        [input.lineId, input.reason.trim(), access.userId, voidTicket]
      );
      await this.bumpIn(c, orderId);
      await this.event(
        c,
        tenantId,
        o.branch_id,
        orderId,
        null,
        'line_voided',
        {
          line_id: input.lineId,
          reason: input.reason.trim(),
          sent: !!line.ticket_id,
        },
        access.userId
      );
      return this.getIn(c, orderId);
    });
  }

  async moveTable(
    tenantId: string,
    access: VenueAccess,
    orderId: string,
    input: { toTableId: string; expectedVersion: number }
  ): Promise<DiningOrderDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const o = await this.lockIn(c, orderId, input.expectedVersion);
      assertVenue(access, 'orders:move', o.branch_id);
      if (o.mode !== 'dine_in' || !['open', 'bill_requested'].includes(o.status)) {
        throw new DiningStateError('Only open dine-in orders can move');
      }
      const t = await c.query(
        `SELECT 1 FROM venue_tables WHERE id = $1 AND branch_id = $2 AND archived_at IS NULL`,
        [input.toTableId, o.branch_id]
      );
      if ((t.rowCount ?? 0) === 0) throw new VenueNotFoundError('Table');
      await c
        .query(`UPDATE dining_orders SET table_id = $2 WHERE id = $1`, [orderId, input.toTableId])
        .catch((e: unknown) => {
          if ((e as { code?: string }).code === '23505') throw new TableOccupiedError();
          throw e;
        });
      await this.bumpIn(c, orderId);
      await this.event(
        c,
        tenantId,
        o.branch_id,
        orderId,
        null,
        'table_moved',
        {
          from: o.table_id,
          to: input.toTableId,
        },
        access.userId
      );
      return this.getIn(c, orderId);
    });
  }

  /** «Pedir la cuenta»: el pedido deja de aceptar líneas (la cuenta la crea Bills). */
  async requestBill(
    tenantId: string,
    access: VenueAccess,
    orderId: string,
    expectedVersion: number
  ): Promise<DiningOrderDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const o = await this.lockIn(c, orderId, expectedVersion);
      assertVenue(access, 'bill:request', o.branch_id);
      if (o.status !== 'open') throw new DiningStateError('Only open orders can request the bill');
      const drafts = await c.query(
        `SELECT 1 FROM dining_order_lines WHERE order_id = $1 AND ticket_id IS NULL AND voided_at IS NULL`,
        [orderId]
      );
      if ((drafts.rowCount ?? 0) > 0) {
        throw new DiningStateError('Send or remove unsent items before requesting the bill');
      }
      await c.query(`UPDATE dining_orders SET status = 'bill_requested' WHERE id = $1`, [orderId]);
      await this.bumpIn(c, orderId);
      await this.event(
        c,
        tenantId,
        o.branch_id,
        orderId,
        null,
        'bill_requested',
        {},
        access.userId
      );
      return this.getIn(c, orderId);
    });
  }

  // ── Cocina ────────────────────────────────────────────────────────────────
  async ticketAction(
    tenantId: string,
    access: VenueAccess,
    ticketId: string,
    input: { to: TicketStatus; expectedVersion: number; reason?: string }
  ): Promise<KitchenTicketView> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<{
        status: TicketStatus;
        version: number;
        branch_id: string;
        order_id: string;
        kind: string;
      }>(
        `SELECT status, version, branch_id, order_id, kind FROM kitchen_tickets WHERE id = $1 FOR UPDATE`,
        [ticketId]
      );
      const t = r.rows[0];
      if (!t) throw new VenueNotFoundError('Ticket');
      if (t.version !== input.expectedVersion) throw new DiningVersionConflictError();
      const recall = input.to === 'preparing' && (t.status === 'ready' || t.status === 'delivered');
      if (recall) {
        assertVenue(access, 'kitchen:recall', t.branch_id);
        if (!input.reason || input.reason.trim().length < 3) {
          throw new DiningStateError('A reason is required to recall a ticket');
        }
      } else {
        if (TICKET_NEXT[t.status] !== input.to) {
          throw new DiningStateError(`Invalid ticket transition ${t.status} -> ${input.to}`);
        }
        // Entregar puede hacerlo cocina o sala; el resto, cocina.
        if (input.to === 'delivered') {
          if (
            !venueCan(access, 'kitchen:act', t.branch_id) &&
            !venueCan(access, 'orders:send', t.branch_id)
          ) {
            throw new VenueForbiddenError('kitchen:act');
          }
        } else {
          assertVenue(access, 'kitchen:act', t.branch_id);
        }
      }
      await c.query(
        `UPDATE kitchen_tickets SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`,
        [ticketId, input.to]
      );
      if (t.kind !== 'void') {
        await c.query(
          `UPDATE dining_order_lines SET prep_status = $2 WHERE ticket_id = $1 AND voided_at IS NULL`,
          [ticketId, input.to]
        );
      }
      await this.event(
        c,
        tenantId,
        t.branch_id,
        t.order_id,
        ticketId,
        recall ? 'ticket_recalled' : 'ticket_status',
        {
          from: t.status,
          to: input.to,
          ...(recall ? { reason: input.reason!.trim() } : {}),
        },
        access.userId
      );
      return (await this.kitchenTicketsIn(c, { ids: [ticketId] }))[0]!;
    });
  }

  /**
   * Instantánea AUTORITATIVA de la cocina (para arrancar y para reconectar):
   * comandas activas + entregadas en los últimos 30 min, con versión, y el
   * cursor de eventos visible. La pantalla reemplaza su estado con esto.
   */
  async kitchenSnapshot(
    tenantId: string,
    access: VenueAccess,
    branchId: string,
    station?: string | null
  ): Promise<{ cursor: number; tickets: KitchenTicketView[] }> {
    assertVenue(access, 'kitchen:view', branchId);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const cur = await c.query<{ seq: string | null }>(
        `SELECT max(seq)::text AS seq FROM dining_events WHERE branch_id = $1`,
        [branchId]
      );
      return {
        cursor: Number(cur.rows[0]?.seq ?? 0),
        tickets: await this.kitchenTicketsIn(c, { branchId, station: station ?? null }),
      };
    });
  }

  async kitchenHistory(
    tenantId: string,
    access: VenueAccess,
    branchId: string
  ): Promise<KitchenTicketView[]> {
    assertVenue(access, 'kitchen:view', branchId);
    return withTenantTransaction(this.appPool, tenantId, (c) =>
      this.kitchenTicketsIn(c, { branchId, history: true })
    );
  }

  /** Eventos desde un cursor (aviso en vivo; la verdad es la instantánea). */
  async eventsSince(
    tenantId: string,
    access: VenueAccess,
    branchId: string,
    since: number
  ): Promise<
    Array<{ seq: number; type: string; orderId: string | null; ticketId: string | null }>
  > {
    if (!venueCan(access, 'kitchen:view', branchId) && !venueCan(access, 'orders:view', branchId)) {
      throw new VenueForbiddenError('kitchen:view');
    }
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<{
        seq: string;
        type: string;
        order_id: string | null;
        ticket_id: string | null;
      }>(
        `SELECT seq::text, type, order_id, ticket_id FROM dining_events
          WHERE branch_id = $1 AND seq > $2 ORDER BY seq LIMIT 200`,
        [branchId, since]
      );
      return r.rows.map((e) => ({
        seq: Number(e.seq),
        type: e.type,
        orderId: e.order_id,
        ticketId: e.ticket_id,
      }));
    });
  }

  // ── Cliente (QR) ──────────────────────────────────────────────────────────
  /**
   * Pedido del cliente desde el QR de la mesa. Si el comercio exige
   * aceptación, queda `pending_acceptance` y no llega a cocina hasta que el
   * personal lo acepta. Devuelve el token PRIVADO de seguimiento (una vez).
   */
  async createCustomerOrder(
    tenantId: string,
    input: {
      branchId: string;
      tableId: string | null;
      mode: DiningMode;
      needsAcceptance: boolean;
      customerName?: string | null;
      note?: string | null;
      lines: LineInput[];
      expectedTotal: bigint;
    }
  ): Promise<{ order: DiningOrderDto; trackingToken: string }> {
    const token = randomBytes(24).toString('base64url');
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const currency = await this.currencyIn(c);
      const id = await this.insertOrderIn(c, tenantId, {
        branchId: input.branchId,
        mode: input.mode,
        tableId: input.tableId,
        customerName: input.customerName ?? null,
        note: input.note ?? null,
        source: 'customer',
        status: input.needsAcceptance ? 'pending_acceptance' : 'open',
        currency,
        openedBy: null,
        trackingHash: hashTrackingToken(token),
      });
      const o = await this.lockIn(c, id, 1);
      await this.insertLinesIn(c, tenantId, o, input.lines, null);
      const total = await this.totalIn(c, id);
      if (total !== input.expectedTotal)
        throw new DiningStateError('Total changed; review the order');
      await this.event(
        c,
        tenantId,
        input.branchId,
        id,
        null,
        'customer_order',
        {
          needs_acceptance: input.needsAcceptance,
        },
        null
      );
      return { order: await this.getIn(c, id), trackingToken: token };
    });
  }

  async acceptCustomerOrder(
    tenantId: string,
    access: VenueAccess,
    orderId: string,
    input: { accept: boolean; reason?: string; expectedVersion: number }
  ): Promise<DiningOrderDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const o = await this.lockIn(c, orderId, input.expectedVersion);
      assertVenue(access, 'orders:accept_customer', o.branch_id);
      if (o.status !== 'pending_acceptance') throw new DiningStateError('Order is not pending');
      await c.query(`UPDATE dining_orders SET status = $2 WHERE id = $1`, [
        orderId,
        input.accept ? 'open' : 'rejected',
      ]);
      await this.bumpIn(c, orderId);
      await this.event(
        c,
        tenantId,
        o.branch_id,
        orderId,
        null,
        input.accept ? 'customer_accepted' : 'customer_rejected',
        {
          ...(input.reason ? { reason: input.reason } : {}),
        },
        access.userId
      );
      return this.getIn(c, orderId);
    });
  }

  /** Vista del cliente con su token privado: solo SU pedido. */
  async byTrackingToken(
    token: string
  ): Promise<{ tenantId: string; order: DiningOrderDto } | null> {
    const ref = await this.resolveTracking(token);
    if (!ref) return null;
    const order = await withTenantTransaction(this.appPool, ref.tenantId, (c) =>
      this.getIn(c, ref.orderId)
    );
    return { tenantId: ref.tenantId, order };
  }

  async requestAttention(token: string): Promise<boolean> {
    const ref = await this.resolveTracking(token);
    if (!ref) return false;
    await withTenantTransaction(this.appPool, ref.tenantId, async (c) => {
      const r = await c.query<{ branch_id: string }>(
        `UPDATE dining_orders SET attention_requested_at = now(), updated_at = now()
          WHERE id = $1 AND status IN ('pending_acceptance', 'open', 'bill_requested')
          RETURNING branch_id`,
        [ref.orderId]
      );
      if (r.rows[0]) {
        await this.event(
          c,
          ref.tenantId,
          r.rows[0].branch_id,
          ref.orderId,
          null,
          'attention_requested',
          {},
          null
        );
      }
    });
    return true;
  }

  async resolveTracking(token: string): Promise<{ tenantId: string; orderId: string } | null> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const r = await this.appPool.query<{ tenant_id: string; order_id: string }>(
      `SELECT tenant_id, order_id FROM dining_order_by_tracking($1)`,
      [hashTrackingToken(token)]
    );
    const row = r.rows[0];
    return row ? { tenantId: row.tenant_id, orderId: row.order_id } : null;
  }

  // ── Internos ──────────────────────────────────────────────────────────────
  async getIn(c: PoolClient, orderId: string): Promise<DiningOrderDto> {
    const r = await c.query<{
      id: string;
      branch_id: string;
      number: string;
      mode: DiningMode;
      table_id: string | null;
      table_label: string | null;
      source: 'staff' | 'customer';
      status: OrderStatus;
      currency: string;
      guest_count: number | null;
      customer_name: string | null;
      note: string | null;
      attention_requested_at: Date | null;
      version: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT o.*, t.label AS table_label FROM dining_orders o
         LEFT JOIN venue_tables t ON t.id = o.table_id WHERE o.id = $1`,
      [orderId]
    );
    const o = r.rows[0];
    if (!o) throw new VenueNotFoundError('Order');
    const lines = await c.query<{
      id: string;
      seq: number;
      product_id: string | null;
      name: string;
      unit_price: string;
      modifiers: ModifierSnapshot[];
      modifiers_total: string;
      quantity: number;
      line_total: string;
      note: string | null;
      station_code: string;
      ticket_id: string | null;
      prep_status: PrepStatus;
      voided_at: Date | null;
      void_reason: string | null;
      created_at: Date;
    }>(`SELECT * FROM dining_order_lines WHERE order_id = $1 ORDER BY seq`, [orderId]);
    const tickets = await c.query<TicketRow>(
      `SELECT * FROM kitchen_tickets WHERE order_id = $1 ORDER BY revision, station_code`,
      [orderId]
    );
    const ls = lines.rows.map((l) => ({
      id: l.id,
      seq: l.seq,
      productId: l.product_id,
      name: l.name,
      unitPrice: BigInt(l.unit_price),
      modifiers: l.modifiers,
      modifiersTotal: BigInt(l.modifiers_total),
      quantity: l.quantity,
      lineTotal: BigInt(l.line_total),
      note: l.note,
      stationCode: l.station_code,
      ticketId: l.ticket_id,
      prepStatus: l.prep_status,
      voided: l.voided_at !== null,
      voidReason: l.void_reason,
      createdAt: l.created_at.toISOString(),
    }));
    return {
      id: o.id,
      branchId: o.branch_id,
      number: Number(o.number),
      mode: o.mode,
      tableId: o.table_id,
      tableLabel: o.table_label,
      source: o.source,
      status: o.status,
      currency: o.currency.trim(),
      guestCount: o.guest_count,
      customerName: o.customer_name,
      note: o.note,
      attentionRequestedAt: o.attention_requested_at?.toISOString() ?? null,
      version: o.version,
      total: ls.filter((l) => !l.voided).reduce((a, l) => a + l.lineTotal, 0n),
      lines: ls,
      tickets: tickets.rows.map(ticketDto),
      createdAt: o.created_at.toISOString(),
      updatedAt: o.updated_at.toISOString(),
    };
  }

  async totalIn(c: PoolClient, orderId: string): Promise<bigint> {
    const r = await c.query<{ s: string }>(
      `SELECT COALESCE(SUM(line_total), 0)::text AS s FROM dining_order_lines
        WHERE order_id = $1 AND voided_at IS NULL`,
      [orderId]
    );
    return BigInt(r.rows[0]!.s);
  }

  async lockIn(c: PoolClient, orderId: string, expectedVersion: number): Promise<OrderRow> {
    const r = await c.query<OrderRow>(`SELECT * FROM dining_orders WHERE id = $1 FOR UPDATE`, [
      orderId,
    ]);
    const o = r.rows[0];
    if (!o) throw new VenueNotFoundError('Order');
    if (o.version !== expectedVersion) throw new DiningVersionConflictError();
    return o;
  }

  async bumpIn(c: PoolClient, orderId: string): Promise<void> {
    await c.query(
      `UPDATE dining_orders SET version = version + 1, updated_at = now() WHERE id = $1`,
      [orderId]
    );
  }

  async event(
    c: PoolClient,
    tenantId: string,
    branchId: string,
    orderId: string | null,
    ticketId: string | null,
    type: string,
    payload: Record<string, unknown>,
    actorId: string | null
  ): Promise<void> {
    await c.query(
      `INSERT INTO dining_events (tenant_id, branch_id, order_id, ticket_id, type, payload, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, branchId, orderId, ticketId, type, JSON.stringify(payload), actorId]
    );
  }

  private async currencyIn(c: PoolClient): Promise<string> {
    const r = await c.query<{ default_currency: string }>(
      `SELECT default_currency FROM merchants WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`
    );
    if (!r.rows[0]) throw new VenueNotFoundError('Merchant');
    return r.rows[0].default_currency.trim();
  }

  private async insertOrderIn(
    c: PoolClient,
    tenantId: string,
    input: {
      branchId: string;
      mode: DiningMode;
      tableId?: string | null;
      guestCount?: number | null;
      customerName?: string | null;
      note?: string | null;
      source: 'staff' | 'customer';
      status: OrderStatus;
      currency: string;
      openedBy: string | null;
      trackingHash?: string;
    }
  ): Promise<string> {
    if ((input.mode === 'dine_in') !== !!input.tableId) {
      throw new DiningStateError('Dine-in orders need a table (and only dine-in)');
    }
    const n = await c.query<{ last_number: string }>(
      `INSERT INTO dining_order_counters (tenant_id, last_number) VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET last_number = dining_order_counters.last_number + 1
       RETURNING last_number::text`,
      [tenantId]
    );
    const r = await c
      .query<{ id: string }>(
        `INSERT INTO dining_orders
           (tenant_id, branch_id, number, mode, table_id, source, status, currency, guest_count,
            customer_name, note, opened_by, tracking_token_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [
          tenantId,
          input.branchId,
          n.rows[0]!.last_number,
          input.mode,
          input.tableId ?? null,
          input.source,
          input.status,
          input.currency,
          input.guestCount ?? null,
          input.customerName?.trim() || null,
          input.note?.trim() || null,
          input.openedBy,
          input.trackingHash ?? null,
        ]
      )
      .catch((e: unknown) => {
        const code = (e as { code?: string }).code;
        if (code === '23505') throw new TableOccupiedError();
        if (code === '23503') throw new VenueNotFoundError('Table or branch');
        throw e;
      });
    return r.rows[0]!.id;
  }

  private async insertLinesIn(
    c: PoolClient,
    tenantId: string,
    o: OrderRow,
    lines: LineInput[],
    actor: string | null
  ): Promise<void> {
    if (lines.length === 0 || lines.length > 40)
      throw new DiningStateError('1 to 40 items per request');
    const ids = [...new Set(lines.map((l) => l.productId))];
    const prods = await c.query<{
      id: string;
      name: string;
      price: string;
      currency: string;
      available: boolean;
      station_code: string | null;
    }>(
      `SELECT p.id, p.name, p.price::text, p.currency,
              (p.available AND p.archived_at IS NULL AND COALESCE(ba.available, true)) AS available,
              rt.station_code
         FROM catalog_products p
         LEFT JOIN product_branch_availability ba ON ba.product_id = p.id AND ba.branch_id = $2
         LEFT JOIN product_prep_routes rt ON rt.product_id = p.id
        WHERE p.id = ANY($1::uuid[]) FOR SHARE OF p`,
      [ids, o.branch_id]
    );
    const byId = new Map(prods.rows.map((p) => [p.id, p]));
    const groups = await c.query<{
      product_id: string;
      group_id: string;
      name: string;
      min_select: number;
      max_select: number;
    }>(
      `SELECT pg.product_id, g.id AS group_id, g.name, g.min_select, g.max_select
         FROM product_modifier_groups pg JOIN modifier_groups g ON g.id = pg.group_id
        WHERE pg.product_id = ANY($1::uuid[]) AND pg.active AND g.archived_at IS NULL`,
      [ids]
    );
    const optionIds = [...new Set(lines.flatMap((l) => l.optionIds ?? []))];
    const opts = await c.query<{
      id: string;
      group_id: string;
      name: string;
      price_delta: string;
      available: boolean;
    }>(
      `SELECT id, group_id, name, price_delta::text, (available AND archived_at IS NULL) AS available
         FROM modifier_options WHERE id = ANY($1::uuid[])`,
      [optionIds]
    );
    const optById = new Map(opts.rows.map((x) => [x.id, x]));
    const seqR = await c.query<{ m: number }>(
      `SELECT COALESCE(MAX(seq), 0)::int AS m FROM dining_order_lines WHERE order_id = $1`,
      [o.id]
    );
    let seq = seqR.rows[0]!.m;
    for (const l of lines) {
      const p = byId.get(l.productId);
      if (!p || !p.available) throw new DiningProductUnavailableError(l.productId);
      if (p.currency.trim() !== o.currency.trim()) throw new DiningStateError('Currency mismatch');
      const pg = groups.rows.filter((g) => g.product_id === p.id);
      const chosen = [...new Set(l.optionIds ?? [])].map((id) => {
        const x = optById.get(id);
        if (!x || !pg.some((g) => g.group_id === x.group_id)) {
          throw new ModifierSelectionError('Option does not belong to this product');
        }
        if (!x.available) throw new ModifierSelectionError(`Option not available: ${x.name}`);
        return x;
      });
      for (const g of pg) {
        const n = chosen.filter((x) => x.group_id === g.group_id).length;
        if (n < g.min_select || n > g.max_select) {
          throw new ModifierSelectionError(
            `«${g.name}»: elige entre ${g.min_select} y ${g.max_select}`
          );
        }
      }
      const mods: ModifierSnapshot[] = chosen.map((x) => ({
        optionId: x.id,
        groupName: pg.find((g) => g.group_id === x.group_id)!.name,
        name: x.name,
        priceDelta: x.price_delta,
      }));
      const modsTotal = chosen.reduce((a, x) => a + BigInt(x.price_delta), 0n);
      const unit = BigInt(p.price);
      const total = (unit + modsTotal) * BigInt(l.quantity);
      if (total > BigInt(Number.MAX_SAFE_INTEGER))
        throw new DiningStateError('Amount out of range');
      seq++;
      await c.query(
        `INSERT INTO dining_order_lines
           (tenant_id, order_id, seq, product_id, name, unit_price, modifiers, modifiers_total,
            quantity, line_total, currency, note, station_code, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          tenantId,
          o.id,
          seq,
          p.id,
          p.name,
          unit.toString(),
          JSON.stringify(mods),
          modsTotal.toString(),
          l.quantity,
          total.toString(),
          o.currency,
          l.note?.trim() || null,
          p.station_code ?? 'cocina',
          actor,
        ]
      );
    }
  }

  private async nextRevisionIn(c: PoolClient, orderId: string): Promise<number> {
    const r = await c.query<{ m: number }>(
      `SELECT COALESCE(MAX(revision), 0)::int AS m FROM kitchen_tickets WHERE order_id = $1`,
      [orderId]
    );
    return r.rows[0]!.m + 1;
  }

  private async insertTicketIn(
    c: PoolClient,
    tenantId: string,
    input: {
      branchId: string;
      orderId: string;
      revision: number;
      kind: 'new' | 'addition' | 'void';
      station: string;
      actor: string | null;
    }
  ): Promise<TicketDto> {
    const n = await c.query<{ last_number: string }>(
      `INSERT INTO kitchen_ticket_counters (tenant_id, last_number) VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET last_number = kitchen_ticket_counters.last_number + 1
       RETURNING last_number::text`,
      [tenantId]
    );
    const r = await c.query<TicketRow>(
      `INSERT INTO kitchen_tickets
         (tenant_id, branch_id, order_id, number, revision, kind, station_code, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        tenantId,
        input.branchId,
        input.orderId,
        n.rows[0]!.last_number,
        input.revision,
        input.kind,
        input.station,
        input.actor,
      ]
    );
    return ticketDto(r.rows[0]!);
  }

  private async kitchenTicketsIn(
    c: PoolClient,
    q: { branchId?: string; station?: string | null; ids?: string[]; history?: boolean }
  ): Promise<KitchenTicketView[]> {
    // SQL fijo; los filtros opcionales van como parámetros NULL-ables.
    const r = await c.query<
      TicketRow & {
        order_number: string;
        mode: DiningMode;
        table_label: string | null;
        customer_name: string | null;
        order_note: string | null;
      }
    >(
      `SELECT t.*, o.number AS order_number, o.mode, vt.label AS table_label,
              o.customer_name, o.note AS order_note
         FROM kitchen_tickets t JOIN dining_orders o ON o.id = t.order_id
         LEFT JOIN venue_tables vt ON vt.id = o.table_id
        WHERE ($1::uuid[] IS NOT NULL AND t.id = ANY($1::uuid[]))
           OR ($1::uuid[] IS NULL AND t.branch_id = $2
               AND ($3::text IS NULL OR t.station_code = $3)
               AND (CASE WHEN $4::boolean THEN t.status = 'delivered'
                         ELSE (t.status <> 'delivered'
                               OR t.updated_at > now() - interval '30 minutes') END))
        ORDER BY t.created_at DESC
        LIMIT $5`,
      [
        q.ids ?? null,
        q.branchId ?? null,
        q.station ?? null,
        q.history ?? false,
        q.history ? 50 : null,
      ]
    );
    // Historial: lo más reciente primero. Vista activa: en orden de llegada.
    if (!q.history) r.rows.reverse();
    const ids = r.rows.map((t) => t.id);
    const items = await c.query<{
      id: string;
      ticket_id: string | null;
      void_ticket_id: string | null;
      name: string;
      quantity: number;
      modifiers: ModifierSnapshot[];
      note: string | null;
      voided_at: Date | null;
      void_reason: string | null;
      seq: number;
    }>(
      `SELECT id, ticket_id, void_ticket_id, name, quantity, modifiers, note, voided_at, void_reason, seq
         FROM dining_order_lines
        WHERE ticket_id = ANY($1::uuid[]) OR void_ticket_id = ANY($1::uuid[]) ORDER BY seq`,
      [ids]
    );
    return r.rows.map((t) => ({
      ...ticketDto(t),
      orderNumber: Number(t.order_number),
      mode: t.mode,
      tableLabel: t.table_label,
      customerName: t.customer_name,
      orderNote: t.order_note,
      items: items.rows
        .filter((i) => (t.kind === 'void' ? i.void_ticket_id === t.id : i.ticket_id === t.id))
        .map((i) => ({
          lineId: i.id,
          name: i.name,
          quantity: i.quantity,
          modifiers: i.modifiers.map((m) => m.name),
          note: i.note,
          voided: i.voided_at !== null,
          voidReason: i.void_reason,
        })),
    }));
  }
}

interface OrderRow {
  id: string;
  branch_id: string;
  mode: DiningMode;
  table_id: string | null;
  status: OrderStatus;
  currency: string;
  version: number;
}
interface TicketRow {
  id: string;
  order_id: string;
  number: string;
  revision: number;
  kind: 'new' | 'addition' | 'void';
  station_code: string;
  status: TicketStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
}
function ticketDto(t: TicketRow): TicketDto {
  return {
    id: t.id,
    orderId: t.order_id,
    number: Number(t.number),
    revision: t.revision,
    kind: t.kind,
    stationCode: t.station_code,
    status: t.status,
    version: t.version,
    createdAt: t.created_at.toISOString(),
    updatedAt: t.updated_at.toISOString(),
  };
}
