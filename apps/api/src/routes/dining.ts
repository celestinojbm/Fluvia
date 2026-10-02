import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  IdempotencyService,
  assertValidIdempotencyKey,
  computeRequestHash,
} from '@fluvia/idempotency';
import {
  BUSINESS_TYPES,
  MODULES,
  VENUE_PERMISSIONS,
  VENUE_ROLES,
  VenueNotFoundError,
  type BusinessModule,
  type BusinessProfileDto,
  type BusinessProfileService,
  type CollectionEnablementDto,
  type DiningLineDto,
  type DiningOrderDto,
  type DiningService,
  type KitchenTicketView,
  type MenuProductDto,
  type TicketDto,
  type VenueAccess,
  type VenueService,
} from '@fluvia/commerce';
import { hasPermission, type Role } from '@fluvia/identity';
import { FixedWindowLimiter, ipKey, rateLimit, type RateLimiter } from '../rate-limit.js';
import type { Security } from '../security.js';

/**
 * Restaurantes y tipo de negocio — plano de SESIÓN (personal del comercio) y
 * plano PÚBLICO (QR de mesa y seguimiento del propio pedido).
 *
 * Autorización en dos capas, ambas en el servidor:
 *  1. Membresía de la organización (RBAC): `org:read` para entrar; la
 *     configuración del local y del negocio exige `merchants:write`.
 *  2. Permiso efectivo de LOCAL (venue_staff: rol + sucursal), evaluado por
 *     DiningService en cada operación. owner/admin = completo.
 * Concurrencia: toda escritura sobre un pedido o comanda lleva
 * `expected_version`; un reintento con versión vieja es 409, nunca un
 * duplicado. Importes en unidades menores.
 */

const OrgParam = z.object({ orgId: z.string().uuid() });
const IdParams = OrgParam.extend({ id: z.string().uuid() });
const LineParams = IdParams.extend({ lineId: z.string().uuid() });
const Version = z.number().int().min(1);
const Name = z.string().trim().min(1).max(80);
const Reason = z.string().trim().min(3).max(200);
const StationCode = z.string().regex(/^[a-z0-9_-]{1,24}$/);
const MinorDelta = z.number().int().min(0).max(1_000_000_000);
const Token = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/);

const ProfileBody = z
  .object({
    business_type: z.enum(BUSINESS_TYPES),
    modules: z.array(z.enum(MODULES)).max(MODULES.length).optional(),
    solo: z.boolean().optional(),
    customer_orders_need_acceptance: z.boolean().optional(),
    expected_version: z.number().int().min(0),
  })
  .strict();

const LineInput = z
  .object({
    product_id: z.string().uuid(),
    quantity: z.number().int().min(1).max(99),
    option_ids: z.array(z.string().uuid()).max(20).optional(),
    note: z.string().trim().max(140).optional(),
  })
  .strict();
const Lines = z.array(LineInput).min(1).max(40);

const OpenBody = z
  .object({
    branch_id: z.string().uuid(),
    mode: z.enum(['dine_in', 'takeaway', 'pickup']),
    table_id: z.string().uuid().nullable().optional(),
    guest_count: z.number().int().min(1).max(99).nullable().optional(),
    customer_name: z.string().trim().max(80).nullable().optional(),
    note: z.string().trim().max(280).nullable().optional(),
  })
  .strict();

// ── Serializadores (lista blanca) ──────────────────────────────────────────

const n = (v: bigint) => Number(v);

export function publicProfile(p: BusinessProfileDto) {
  return {
    object: 'business_profile',
    business_type: p.businessType,
    modules: p.modules,
    solo: p.solo,
    customer_orders_need_acceptance: p.customerOrdersNeedAcceptance,
    version: p.version,
    configured: p.configured,
    vocabulary: p.vocabulary,
  };
}

export function publicEnablement(e: CollectionEnablementDto) {
  return {
    object: 'collection_enablement',
    method: e.method,
    status: e.status,
    provider: e.provider,
    reason: e.reason,
    version: e.version,
    requirements: e.requirements.map((r) => ({ id: r.id, label: r.label, done: r.done })),
  };
}

function publicAccess(a: VenueAccess) {
  return {
    full: a.full,
    grants: a.grants.map((g) => ({ role: g.role, branch_id: g.branchId })),
  };
}

export function publicMenuItem(p: MenuProductDto) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    // Solo lo que el comercio cargó en su catálogo; null = no informado.
    ingredients: p.ingredients,
    allergen_info: p.allergenInfo,
    price: n(p.price),
    currency: p.currency,
    available: p.available,
    category_name: p.categoryName,
    image_url: p.imageUrl,
    station_code: p.stationCode,
    modifier_groups: p.modifierGroups.map((g) => ({
      id: g.id,
      name: g.name,
      min_select: g.minSelect,
      max_select: g.maxSelect,
      options: g.options.map((o) => ({
        id: o.id,
        name: o.name,
        price_delta: n(o.priceDelta),
        available: o.available,
      })),
    })),
  };
}

function publicLine(l: DiningLineDto) {
  return {
    id: l.id,
    seq: l.seq,
    product_id: l.productId,
    name: l.name,
    unit_price: n(l.unitPrice),
    modifiers: l.modifiers.map((m) => ({
      option_id: m.optionId,
      group_name: m.groupName,
      name: m.name,
      price_delta: Number(m.priceDelta),
    })),
    modifiers_total: n(l.modifiersTotal),
    quantity: l.quantity,
    line_total: n(l.lineTotal),
    note: l.note,
    station_code: l.stationCode,
    ticket_id: l.ticketId,
    prep_status: l.prepStatus,
    voided: l.voided,
    void_reason: l.voidReason,
    created_at: l.createdAt,
  };
}

function publicTicket(t: TicketDto) {
  return {
    id: t.id,
    order_id: t.orderId,
    number: t.number,
    revision: t.revision,
    kind: t.kind,
    station_code: t.stationCode,
    status: t.status,
    version: t.version,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

export function publicDiningOrder(o: DiningOrderDto) {
  return {
    id: o.id,
    object: 'dining_order',
    branch_id: o.branchId,
    number: o.number,
    mode: o.mode,
    table_id: o.tableId,
    table_label: o.tableLabel,
    source: o.source,
    status: o.status,
    currency: o.currency,
    guest_count: o.guestCount,
    customer_name: o.customerName,
    note: o.note,
    attention_requested_at: o.attentionRequestedAt,
    version: o.version,
    total: n(o.total),
    lines: o.lines.map(publicLine),
    tickets: o.tickets.map(publicTicket),
    created_at: o.createdAt,
    updated_at: o.updatedAt,
  };
}

/** Vista del COMENSAL: su pedido, sin ids internos de personal ni comandas. */
export function customerOrderView(o: DiningOrderDto) {
  return {
    object: 'customer_dining_order',
    number: o.number,
    mode: o.mode,
    table_label: o.tableLabel,
    status: o.status,
    currency: o.currency,
    total: n(o.total),
    attention_requested: o.attentionRequestedAt !== null,
    lines: o.lines
      .filter((l) => !l.voided)
      .map((l) => ({
        name: l.name,
        quantity: l.quantity,
        modifiers: l.modifiers.map((m) => m.name),
        note: l.note,
        line_total: n(l.lineTotal),
        // Estado de preparación ≠ pago: «listo» no implica «pagado».
        prep_status: l.prepStatus,
      })),
    updated_at: o.updatedAt,
  };
}

export function publicKitchenTicket(t: KitchenTicketView) {
  return {
    ...publicTicket(t),
    object: 'kitchen_ticket',
    order_number: t.orderNumber,
    mode: t.mode,
    table_label: t.tableLabel,
    customer_name: t.customerName,
    order_note: t.orderNote,
    items: t.items.map((i) => ({
      line_id: i.lineId,
      name: i.name,
      quantity: i.quantity,
      modifiers: i.modifiers,
      note: i.note,
      voided: i.voided,
      void_reason: i.voidReason,
    })),
  };
}

export interface DiningRoutesOptions {
  security: Security;
  idempotencyService: IdempotencyService;
  businessService: BusinessProfileService;
  venueService: VenueService;
  diningService: DiningService;
  /** Solo local/test: decisión simulada del proveedor de cobro presencial. */
  sandboxSimulation: boolean;
  limiter?: RateLimiter;
  /** Intervalo de sondeo del stream del KDS (ms). */
  streamPollMs?: number;
}

export function registerDiningRoutes(app: FastifyInstance, o: DiningRoutesOptions): void {
  const { security, businessService: biz, venueService: venue, diningService: dining } = o;
  const member = { preHandler: [security.session, security.org('org:read')] };
  const admin = { preHandler: [security.session, security.org('merchants:write')] };
  const tenant = (req: FastifyRequest) => req.org!.organizationId;
  const access = (req: FastifyRequest) =>
    venue.access(tenant(req), req.identity!.userId, req.org!.role);
  const requireModule = (req: FastifyRequest, m: BusinessModule) =>
    biz.requireModule(tenant(req), m);
  const limiter = o.limiter ?? new FixedWindowLimiter();
  const publicRead = {
    preHandler: rateLimit(limiter, [
      { keyOf: ipKey('dining:public:ip'), rule: { max: 300, windowMs: 60_000 } },
    ]),
  };
  const publicWrite = {
    preHandler: rateLimit(limiter, [
      { keyOf: ipKey('dining:public-write:ip'), rule: { max: 20, windowMs: 60_000 } },
    ]),
  };
  const base = '/v1/organizations/:orgId';

  // ── Perfil de negocio y habilitación de cobro ────────────────────────────
  app.get(`${base}/business-profile`, member, async (req) => {
    OrgParam.parse(req.params);
    const [profile, acc] = await Promise.all([biz.get(tenant(req)), access(req)]);
    const role = req.org!.role as Role;
    return {
      ...publicProfile(profile),
      // Lo que ESTE usuario puede hacer (la UI oculta; el servidor decide).
      my_access: {
        membership_role: role,
        can_configure: hasPermission(role, 'merchants:write'),
        can_view_payments: hasPermission(role, 'payments:read'),
        venue: publicAccess(acc),
      },
    };
  });

  app.put(`${base}/business-profile`, admin, async (req) => {
    OrgParam.parse(req.params);
    const b = ProfileBody.parse(req.body);
    const p = await biz.set(tenant(req), {
      businessType: b.business_type,
      modules: b.modules,
      solo: b.solo,
      customerOrdersNeedAcceptance: b.customer_orders_need_acceptance,
      expectedVersion: b.expected_version,
    });
    return publicProfile(p);
  });

  app.get(`${base}/collection-enablement`, member, async (req) => {
    OrgParam.parse(req.params);
    return publicEnablement(await biz.enablement(tenant(req)));
  });

  app.post(`${base}/collection-enablement/requirements/:req/complete`, admin, async (req) => {
    const { req: id } = OrgParam.extend({
      req: z.enum(['identity', 'payout_account', 'terms', 'device']),
    }).parse(req.params);
    return publicEnablement(await biz.completeRequirement(tenant(req), id));
  });

  // La habilitación la decide el PROVEEDOR/operación, nunca el comercio. En
  // local/test existe esta simulación explícita del proveedor de sandbox.
  if (o.sandboxSimulation) {
    app.post(`${base}/collection-enablement/sandbox-decision`, admin, async (req) => {
      OrgParam.parse(req.params);
      const b = z
        .object({
          status: z.enum(['enabled', 'restricted', 'suspended']),
          reason: z.string().trim().max(200).optional(),
        })
        .strict()
        .parse(req.body);
      return publicEnablement(
        await biz.transition(tenant(req), b.status, {
          provider: 'sandbox_simulator',
          reason: b.reason ?? 'sandbox: decisión simulada del proveedor',
          actorId: req.identity!.userId,
        })
      );
    });
  }

  // ── Configuración del local (owner/admin) ─────────────────────────────────
  app.get(`${base}/venue`, member, async (req) => {
    OrgParam.parse(req.params);
    const layout = await venue.layout(tenant(req));
    const canConfigure = hasPermission(req.org!.role as Role, 'merchants:write');
    return {
      object: 'venue',
      branches: layout.branches.map((b) => ({
        id: b.id,
        name: b.name,
        areas: b.areas.map((a) => ({ id: a.id, name: a.name })),
        tables: b.tables.map((t) => ({
          id: t.id,
          area_id: t.areaId,
          label: t.label,
          capacity: t.capacity,
          // El token del QR da acceso al menú de la mesa: solo quien configura.
          qr_token: canConfigure ? t.qrToken : null,
        })),
        stations: b.stations.map((s) => ({ id: s.id, code: s.code, name: s.name })),
      })),
    };
  });

  app.post(`${base}/venue/branches`, admin, async (req, reply) => {
    OrgParam.parse(req.params);
    const b = z.object({ name: Name }).strict().parse(req.body);
    return reply.code(201).send(await venue.createBranch(tenant(req), b.name));
  });

  app.post(`${base}/venue/areas`, admin, async (req, reply) => {
    OrgParam.parse(req.params);
    const b = z.object({ branch_id: z.string().uuid(), name: Name }).strict().parse(req.body);
    const a = await venue.createArea(tenant(req), b.branch_id, b.name);
    return reply.code(201).send({ id: a.id, branch_id: a.branchId, name: a.name });
  });

  app.post(`${base}/venue/tables`, admin, async (req, reply) => {
    OrgParam.parse(req.params);
    const b = z
      .object({
        branch_id: z.string().uuid(),
        area_id: z.string().uuid(),
        label: z.string().trim().min(1).max(20),
        capacity: z.number().int().min(1).max(40),
      })
      .strict()
      .parse(req.body);
    const t = await venue.createTable(tenant(req), {
      branchId: b.branch_id,
      areaId: b.area_id,
      label: b.label,
      capacity: b.capacity,
    });
    return reply.code(201).send({
      id: t.id,
      branch_id: t.branchId,
      area_id: t.areaId,
      label: t.label,
      capacity: t.capacity,
      qr_token: t.qrToken,
    });
  });

  app.post(`${base}/venue/tables/:id/rotate-qr`, admin, async (req) => {
    const { id } = IdParams.parse(req.params);
    const t = await venue.rotateTableQr(tenant(req), id);
    return { id: t.id, label: t.label, qr_token: t.qrToken };
  });

  app.post(`${base}/venue/stations`, admin, async (req, reply) => {
    OrgParam.parse(req.params);
    const b = z
      .object({ branch_id: z.string().uuid(), code: StationCode, name: Name })
      .strict()
      .parse(req.body);
    const s = await venue.createStation(tenant(req), {
      branchId: b.branch_id,
      code: b.code,
      name: b.name,
    });
    return reply.code(201).send({ id: s.id, branch_id: s.branchId, code: s.code, name: s.name });
  });

  app.put(`${base}/venue/products/:id/route`, admin, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ station_code: StationCode }).strict().parse(req.body);
    await venue.setProductRoute(tenant(req), id, b.station_code);
    return { ok: true };
  });

  app.put(`${base}/venue/products/:id/availability`, admin, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z
      .object({ branch_id: z.string().uuid(), available: z.boolean() })
      .strict()
      .parse(req.body);
    await venue.setBranchAvailability(tenant(req), id, b.branch_id, b.available);
    return { ok: true };
  });

  app.put(`${base}/venue/products/:id/info`, admin, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z
      .object({
        ingredients: z.string().trim().max(500).nullable(),
        allergen_info: z.string().trim().max(300).nullable(),
      })
      .strict()
      .parse(req.body);
    await venue.setProductInfo(tenant(req), id, {
      ingredients: b.ingredients || null,
      allergenInfo: b.allergen_info || null,
    });
    return { ok: true };
  });

  app.post(`${base}/venue/modifier-groups`, admin, async (req, reply) => {
    OrgParam.parse(req.params);
    const b = z
      .object({
        name: Name,
        min_select: z.number().int().min(0).max(10),
        max_select: z.number().int().min(1).max(10),
        options: z
          .array(
            z
              .object({ name: Name, price_delta: MinorDelta, available: z.boolean().optional() })
              .strict()
          )
          .min(1)
          .max(20),
      })
      .strict()
      .refine((g) => g.min_select <= g.max_select, 'min_select must be <= max_select')
      .parse(req.body);
    const g = await venue.createModifierGroup(tenant(req), {
      name: b.name,
      minSelect: b.min_select,
      maxSelect: b.max_select,
      options: b.options.map((x) => ({
        name: x.name,
        priceDelta: BigInt(x.price_delta),
        available: x.available,
      })),
    });
    return reply.code(201).send({
      id: g.id,
      name: g.name,
      min_select: g.minSelect,
      max_select: g.maxSelect,
      options: g.options.map((x) => ({
        id: x.id,
        name: x.name,
        price_delta: n(x.priceDelta),
        available: x.available,
      })),
    });
  });

  app.put(`${base}/venue/modifier-options/:id/availability`, admin, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ available: z.boolean() }).strict().parse(req.body);
    await venue.setOptionAvailability(tenant(req), id, b.available);
    return { ok: true };
  });

  app.put(`${base}/venue/products/:id/modifier-groups/:groupId`, admin, async (req) => {
    const p = IdParams.extend({ groupId: z.string().uuid() }).parse(req.params);
    const b = z
      .object({ active: z.boolean() })
      .strict()
      .parse(req.body ?? { active: true });
    await venue.attachModifierGroup(tenant(req), p.id, p.groupId, b.active);
    return { ok: true };
  });

  app.get(`${base}/venue/staff`, admin, async (req) => {
    OrgParam.parse(req.params);
    const list = await venue.listStaff(tenant(req));
    return {
      object: 'list',
      roles: VENUE_ROLES,
      permissions: VENUE_PERMISSIONS,
      data: list.map((s) => ({
        user_id: s.userId,
        email: s.email,
        role: s.role,
        branch_id: s.branchId,
      })),
    };
  });

  const StaffBody = z
    .object({
      user_id: z.string().uuid(),
      role: z.enum(VENUE_ROLES),
      branch_id: z.string().uuid().nullable().optional(),
    })
    .strict();
  app.post(`${base}/venue/staff`, admin, async (req, reply) => {
    OrgParam.parse(req.params);
    const b = StaffBody.parse(req.body);
    await venue.assignStaff(tenant(req), {
      userId: b.user_id,
      role: b.role,
      branchId: b.branch_id ?? null,
    });
    return reply.code(201).send({ ok: true });
  });
  app.post(`${base}/venue/staff/revoke`, admin, async (req) => {
    OrgParam.parse(req.params);
    const b = StaffBody.omit({ branch_id: true }).parse(req.body);
    await venue.revokeStaff(tenant(req), { userId: b.user_id, role: b.role });
    return { ok: true };
  });

  app.get(`${base}/venue/branches/:id/menu`, member, async (req) => {
    const { id } = IdParams.parse(req.params);
    await requireModule(req, 'catalog');
    return { object: 'list', data: (await venue.menu(tenant(req), id)).map(publicMenuItem) };
  });

  // ── Pedidos (personal) ────────────────────────────────────────────────────
  const orderPath = `${base}/dining/orders/:id`;

  app.get(`${base}/dining/orders`, member, async (req) => {
    OrgParam.parse(req.params);
    const q = z
      .object({
        branch_id: z.string().uuid(),
        scope: z.enum(['active', 'recent']).default('active'),
      })
      .passthrough()
      .parse(req.query ?? {});
    const list = await dining.list(tenant(req), await access(req), q.branch_id, q.scope);
    return { object: 'list', data: list.map(publicDiningOrder) };
  });

  app.post(`${base}/dining/orders`, member, async (req, reply) => {
    OrgParam.parse(req.params);
    const b = OpenBody.parse(req.body);
    if (b.mode === 'dine_in') await requireModule(req, 'tables');
    const order = await dining.open(tenant(req), await access(req), {
      branchId: b.branch_id,
      mode: b.mode,
      tableId: b.table_id ?? null,
      guestCount: b.guest_count ?? null,
      customerName: b.customer_name ?? null,
      note: b.note ?? null,
    });
    return reply.code(201).send(publicDiningOrder(order));
  });

  app.get(orderPath, member, async (req) => {
    const { id } = IdParams.parse(req.params);
    return publicDiningOrder(await dining.get(tenant(req), await access(req), id));
  });

  app.post(`${orderPath}/lines`, member, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ expected_version: Version, lines: Lines }).strict().parse(req.body);
    const order = await dining.addLines(tenant(req), await access(req), id, {
      expectedVersion: b.expected_version,
      lines: b.lines.map((l) => ({
        productId: l.product_id,
        quantity: l.quantity,
        optionIds: l.option_ids,
        note: l.note,
      })),
    });
    return publicDiningOrder(order);
  });

  app.post(`${orderPath}/send`, member, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ expected_version: Version }).strict().parse(req.body);
    await requireModule(req, 'kitchen');
    const r = await dining.sendToKitchen(tenant(req), await access(req), id, b.expected_version);
    return { order: publicDiningOrder(r.order), tickets: r.tickets.map(publicTicket) };
  });

  app.post(`${orderPath}/lines/:lineId/void`, member, async (req) => {
    const p = LineParams.parse(req.params);
    const b = z.object({ expected_version: Version, reason: Reason }).strict().parse(req.body);
    const order = await dining.voidLine(tenant(req), await access(req), p.id, {
      lineId: p.lineId,
      reason: b.reason,
      expectedVersion: b.expected_version,
    });
    return publicDiningOrder(order);
  });

  app.post(`${orderPath}/move`, member, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z
      .object({ expected_version: Version, to_table_id: z.string().uuid() })
      .strict()
      .parse(req.body);
    const order = await dining.moveTable(tenant(req), await access(req), id, {
      toTableId: b.to_table_id,
      expectedVersion: b.expected_version,
    });
    return publicDiningOrder(order);
  });

  app.post(`${orderPath}/request-bill`, member, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ expected_version: Version }).strict().parse(req.body);
    return publicDiningOrder(
      await dining.requestBill(tenant(req), await access(req), id, b.expected_version)
    );
  });

  app.post(`${orderPath}/decision`, member, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z
      .object({ expected_version: Version, accept: z.boolean(), reason: Reason.optional() })
      .strict()
      .parse(req.body);
    return publicDiningOrder(
      await dining.acceptCustomerOrder(tenant(req), await access(req), id, {
        accept: b.accept,
        reason: b.reason,
        expectedVersion: b.expected_version,
      })
    );
  });

  app.post(`${orderPath}/attention/clear`, member, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ expected_version: Version }).strict().parse(req.body);
    return publicDiningOrder(
      await dining.clearAttention(tenant(req), await access(req), id, b.expected_version)
    );
  });

  // ── Cocina (KDS) ──────────────────────────────────────────────────────────
  const KitchenQuery = z
    .object({ branch_id: z.string().uuid(), station: StationCode.optional() })
    .passthrough();

  app.get(`${base}/kitchen/snapshot`, member, async (req) => {
    OrgParam.parse(req.params);
    const q = KitchenQuery.parse(req.query ?? {});
    await requireModule(req, 'kitchen');
    const s = await dining.kitchenSnapshot(tenant(req), await access(req), q.branch_id, q.station);
    return {
      object: 'kitchen_snapshot',
      cursor: s.cursor,
      server_time: new Date().toISOString(),
      tickets: s.tickets.map(publicKitchenTicket),
    };
  });

  app.get(`${base}/kitchen/history`, member, async (req) => {
    OrgParam.parse(req.params);
    const q = KitchenQuery.parse(req.query ?? {});
    const list = await dining.kitchenHistory(tenant(req), await access(req), q.branch_id);
    return { object: 'list', data: list.map(publicKitchenTicket) };
  });

  app.post(`${base}/kitchen/tickets/:id/action`, member, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z
      .object({
        to: z.enum(['accepted', 'preparing', 'ready', 'delivered']),
        expected_version: Version,
        reason: Reason.optional(),
      })
      .strict()
      .parse(req.body);
    const t = await dining.ticketAction(tenant(req), await access(req), id, {
      to: b.to,
      expectedVersion: b.expected_version,
      reason: b.reason,
    });
    return publicKitchenTicket(t);
  });

  const EventsQuery = z
    .object({ branch_id: z.string().uuid(), since: z.coerce.number().int().min(0).default(0) })
    .passthrough();

  /** Eventos desde un cursor (sondeo). Son AVISOS: la verdad es la instantánea. */
  app.get(`${base}/dining/events`, member, async (req) => {
    OrgParam.parse(req.params);
    const q = EventsQuery.parse(req.query ?? {});
    const ev = await dining.eventsSince(tenant(req), await access(req), q.branch_id, q.since);
    return {
      object: 'list',
      cursor: ev.length ? ev[ev.length - 1]!.seq : q.since,
      data: ev.map((e) => ({
        seq: e.seq,
        type: e.type,
        order_id: e.orderId,
        ticket_id: e.ticketId,
      })),
    };
  });

  /**
   * Stream SSE para el KDS y la sala. Emite `changed` cuando hay eventos
   * nuevos y `ping` como latido. El cliente, ante `changed` o al reconectar,
   * vuelve a pedir la instantánea: no se pierde ni se duplica nada aunque los
   * eventos lleguen desordenados o el stream se corte.
   */
  app.get(`${base}/dining/stream`, member, async (req, reply) => {
    OrgParam.parse(req.params);
    const q = EventsQuery.parse(req.query ?? {});
    const t = tenant(req);
    const acc = await access(req);
    // Autoriza ANTES de abrir el stream (403/404 como JSON normal).
    await dining.eventsSince(t, acc, q.branch_id, q.since);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let cursor = q.since;
    let closed = false;
    let ticks = 0;
    const pollMs = o.streamPollMs ?? 1000;
    const send = (event: string, data: unknown) => {
      if (!closed && !reply.raw.destroyed) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    send('ready', { cursor });
    const timer = setInterval(() => {
      void (async () => {
        try {
          const ev = await dining.eventsSince(t, acc, q.branch_id, cursor);
          if (ev.length) {
            cursor = ev[ev.length - 1]!.seq;
            send('changed', {
              cursor,
              types: [...new Set(ev.map((e) => e.type))],
              order_ids: [...new Set(ev.map((e) => e.orderId).filter(Boolean))],
            });
          } else if (++ticks % 15 === 0) {
            send('ping', { cursor });
          }
        } catch (err) {
          req.log.warn({ err }, 'dining stream poll failed');
          send('error', { code: 'stream_poll_failed' });
          stop();
        }
      })();
    }, pollMs);
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (!reply.raw.destroyed) reply.raw.end();
    };
    reply.raw.on('close', stop);
  });

  // ── Público: QR de mesa y seguimiento del propio pedido ───────────────────
  const tableCtx = async (token: string) => {
    const t = await venue.tableByToken(token);
    if (!t) throw new VenueNotFoundError('Table');
    const profile = await biz.get(t.tenantId);
    if (!profile.modules.includes('qr_menu')) throw new VenueNotFoundError('Table');
    return { t, profile };
  };

  app.get('/v1/public/tables/:token', publicRead, async (req) => {
    const { token } = z.object({ token: Token }).parse(req.params);
    const { t, profile } = await tableCtx(token);
    const menu = await venue.menu(t.tenantId, t.branchId);
    return {
      object: 'table_menu',
      merchant_name: t.merchantName,
      branch_name: t.branchName,
      table_label: t.tableLabel,
      ordering: {
        enabled: profile.modules.includes('customer_orders'),
        needs_acceptance: profile.customerOrdersNeedAcceptance,
      },
      // Información SOLO del catálogo; null = el comercio no la informó.
      menu: menu.filter((m) => m.available).map(publicMenuItem),
    };
  });

  app.post('/v1/public/tables/:token/orders', publicWrite, async (req, reply) => {
    const { token } = z.object({ token: Token }).parse(req.params);
    const key = assertValidIdempotencyKey(req.headers['idempotency-key']);
    const body = z
      .object({
        customer_name: z.string().trim().max(80).nullable().optional(),
        note: z.string().trim().max(280).nullable().optional(),
        expected_total: z.number().int().positive().refine(Number.isSafeInteger),
        lines: Lines,
      })
      .strict()
      .parse(req.body);
    const { t, profile } = await tableCtx(token);
    if (!profile.modules.includes('customer_orders')) throw new VenueNotFoundError('Ordering');
    const result = await o.idempotencyService.execute({
      tenantId: t.tenantId,
      endpoint: 'POST /v1/public/tables/:token/orders',
      key,
      requestHash: computeRequestHash({ token, ...body }),
      handler: async (client) => {
        const r = await dining.createCustomerOrderIn(client, t.tenantId, {
          branchId: t.branchId,
          tableId: t.tableId,
          mode: 'dine_in',
          needsAcceptance: profile.customerOrdersNeedAcceptance,
          customerName: body.customer_name ?? null,
          note: body.note ?? null,
          expectedTotal: BigInt(body.expected_total),
          lines: body.lines.map((l) => ({
            productId: l.product_id,
            quantity: l.quantity,
            optionIds: l.option_ids,
            note: l.note,
          })),
        });
        return {
          status: 201,
          body: {
            ...customerOrderView(r.order),
            // Token PRIVADO del comensal: solo se entrega en esta respuesta (y
            // en su repetición idempotente). En BD queda solo su hash.
            tracking_token: r.trackingToken,
          },
        };
      },
    });
    reply.header('idempotency-replayed', String(result.replayed));
    return reply.code(result.status).send(result.body);
  });

  app.get('/v1/public/dining/orders/:tracking', publicRead, async (req) => {
    const { tracking } = z.object({ tracking: Token }).parse(req.params);
    const r = await dining.byTrackingToken(tracking);
    if (!r) throw new VenueNotFoundError('Order');
    return customerOrderView(r.order);
  });

  app.post('/v1/public/dining/orders/:tracking/attention', publicWrite, async (req) => {
    const { tracking } = z.object({ tracking: Token }).parse(req.params);
    if (!(await dining.requestAttention(tracking))) throw new VenueNotFoundError('Order');
    return { ok: true };
  });
}
