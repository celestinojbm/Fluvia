import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  BusinessProfileService,
  BusinessProfileVersionConflictError,
  CatalogService,
  DiningService,
  DiningStateError,
  DiningVersionConflictError,
  ModifierSelectionError,
  TableOccupiedError,
  VenueForbiddenError,
  VenueService,
  type VenueAccess,
} from '../src/index.js';

/**
 * Restaurante contra PostgreSQL REAL: configuración por tipo de negocio,
 * estructura del local, permisos efectivos de servidor, pedido con
 * modificadores y precio histórico, comandas con revisiones (sin reenvío ni
 * sobrescritura), anulación con comanda de anulación, mover mesa,
 * concurrencia por versión, cocina con recuperación con motivo, pedido del
 * cliente con aceptación y aislamiento entre organizaciones.
 */
let ctx: TestContext;
let tenant: string;
let other: string;
let business: BusinessProfileService;
let venue: VenueService;
let dining: DiningService;
let catalog: CatalogService;
let branch: string;
let branch2: string;
let table1: string;
let table2: string;
let burger: string;
let soda: string;
let cooking: string;
let extras: { cheese: string; bacon: string };
let cookOpts: { rare: string; well: string };

const owner: VenueAccess = { userId: randomUUID(), full: true, grants: [] };
let waiter: VenueAccess;
let kitchen: VenueAccess;
let waiterOtherBranch: VenueAccess;

beforeAll(async () => {
  ctx = await createTestContext();
  business = new BusinessProfileService(ctx.app);
  venue = new VenueService(ctx.app);
  dining = new DiningService(ctx.app);
  catalog = new CatalogService(ctx.app);
  tenant = await ctx.createTenant('Restaurante prueba');
  other = await ctx.createTenant('Otro restaurante');
  for (const t of [tenant, other]) {
    await ctx.admin.query(
      `INSERT INTO merchants (tenant_id, name, country, default_currency) VALUES ($1, 'Local', 'VE', 'VES')`,
      [t]
    );
  }
  waiter = { userId: randomUUID(), full: false, grants: [] };
  kitchen = { userId: randomUUID(), full: false, grants: [] };
  waiterOtherBranch = { userId: randomUUID(), full: false, grants: [] };

  const b = await venue.createBranch(tenant, 'Centro');
  branch = b.id;
  branch2 = (await venue.createBranch(tenant, 'Playa')).id;
  waiter.grants = [{ role: 'waiter', branchId: branch }];
  kitchen.grants = [{ role: 'kitchen', branchId: branch }];
  waiterOtherBranch.grants = [{ role: 'waiter', branchId: branch2 }];
  const area = await venue.createArea(tenant, branch, 'Salón');
  table1 = (
    await venue.createTable(tenant, { branchId: branch, areaId: area.id, label: 'M1', capacity: 4 })
  ).id;
  table2 = (
    await venue.createTable(tenant, { branchId: branch, areaId: area.id, label: 'M2', capacity: 2 })
  ).id;
  await venue.createStation(tenant, { branchId: branch, code: 'cocina', name: 'Cocina' });
  await venue.createStation(tenant, { branchId: branch, code: 'barra', name: 'Barra' });
  burger = (
    await catalog.createProduct(tenant, { name: 'Hamburguesa', price: 1500n, currency: 'VES' })
  ).id;
  soda = (await catalog.createProduct(tenant, { name: 'Refresco', price: 300n, currency: 'VES' }))
    .id;
  await venue.setProductRoute(tenant, burger, 'cocina');
  await venue.setProductRoute(tenant, soda, 'barra');
  const g1 = await venue.createModifierGroup(tenant, {
    name: 'Extras',
    minSelect: 0,
    maxSelect: 2,
    options: [
      { name: 'Queso', priceDelta: 200n },
      { name: 'Tocineta', priceDelta: 350n },
    ],
  });
  const g2 = await venue.createModifierGroup(tenant, {
    name: 'Término',
    minSelect: 1,
    maxSelect: 1,
    options: [
      { name: 'Medio', priceDelta: 0n },
      { name: 'Bien cocido', priceDelta: 0n },
    ],
  });
  extras = { cheese: g1.options[0]!.id, bacon: g1.options[1]!.id };
  cookOpts = { rare: g2.options[0]!.id, well: g2.options[1]!.id };
  cooking = g2.id;
  await venue.attachModifierGroup(tenant, burger, g1.id);
  await venue.attachModifierGroup(tenant, burger, g2.id);
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('tipo de negocio', () => {
  it('sin configurar = minorista; configurar restaurante habilita módulos sin borrar nada', async () => {
    const before = await business.get(tenant);
    expect(before).toMatchObject({ businessType: 'retail', configured: false, version: 0 });
    const p = await business.set(tenant, { businessType: 'restaurant', expectedVersion: 0 });
    expect(p.modules).toEqual(expect.arrayContaining(['tables', 'kitchen', 'split_bill']));
    expect(p.vocabulary.newSale).toBe('Abrir mesa');
    await expect(
      business.set(tenant, { businessType: 'retail', expectedVersion: 0 })
    ).rejects.toBeInstanceOf(BusinessProfileVersionConflictError);
    // El catálogo sigue ahí al cambiar de tipo y volver.
    await business.set(tenant, { businessType: 'retail', expectedVersion: 1 });
    expect((await catalog.listProducts(tenant, {})).length).toBeGreaterThanOrEqual(2);
    await business.set(tenant, { businessType: 'restaurant', expectedVersion: 2 });
    const en = await business.enablement(tenant);
    expect(en.status).toBe('pending');
  });
});

describe('pedido de mesa → cocina → entrega', () => {
  it('modificadores validados, precio histórico, comandas por estación y revisiones', async () => {
    let o = await dining.open(tenant, waiter, {
      branchId: branch,
      mode: 'dine_in',
      tableId: table1,
      guestCount: 2,
    });
    expect(o.status).toBe('open');
    await expect(
      dining.addLines(tenant, waiter, o.id, {
        expectedVersion: o.version,
        lines: [{ productId: burger, quantity: 1, optionIds: [extras.cheese] }],
      })
    ).rejects.toBeInstanceOf(ModifierSelectionError); // falta «Término»
    o = await dining.addLines(tenant, waiter, o.id, {
      expectedVersion: o.version,
      lines: [
        {
          productId: burger,
          quantity: 2,
          optionIds: [extras.cheese, cookOpts.rare],
          note: 'sin cebolla',
        },
        { productId: soda, quantity: 2 },
      ],
    });
    // (1500 + 200) × 2 + 300 × 2
    expect(o.total).toBe(4000n);
    expect(o.lines.map((l) => l.prepStatus)).toEqual(['draft', 'draft']);

    // El catálogo cambia: el pedido conserva el precio histórico.
    await catalog.updateProduct(tenant, burger, { price: 9999n, expectedVersion: 1 });
    const sent = await dining.sendToKitchen(tenant, waiter, o.id, o.version);
    expect(sent.tickets.map((t) => [t.stationCode, t.revision, t.kind]).sort()).toEqual([
      ['barra', 1, 'new'],
      ['cocina', 1, 'new'],
    ]);
    o = sent.order;
    expect(o.total).toBe(4000n);

    // Reenviar sin líneas nuevas no crea comandas.
    const again = await dining.sendToKitchen(tenant, waiter, o.id, o.version);
    expect(again.tickets).toHaveLength(0);

    // Línea posterior → revisión 2 (adición), sin tocar la 1.
    o = await dining.addLines(tenant, waiter, o.id, {
      expectedVersion: o.version,
      lines: [{ productId: burger, quantity: 1, optionIds: [cookOpts.well] }],
    });
    const add = await dining.sendToKitchen(tenant, waiter, o.id, o.version);
    expect(add.tickets).toHaveLength(1);
    expect(add.tickets[0]).toMatchObject({ revision: 2, kind: 'addition', stationCode: 'cocina' });
    expect(add.order.total).toBe(4000n + 9999n); // la nueva línea toma el precio actual

    // La línea enviada no se puede reescribir en el motor.
    await expect(
      ctx.admin.query(`UPDATE dining_order_lines SET quantity = 5 WHERE id = $1`, [
        add.order.lines[0]!.id,
      ])
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);

    // Cocina: aceptar → preparar → listo; otro usuario entrega.
    const snap = await dining.kitchenSnapshot(tenant, kitchen, branch, 'cocina');
    const first = snap.tickets.find((t) => t.orderId === o.id && t.revision === 1)!;
    expect(first.items[0]).toMatchObject({
      quantity: 2,
      modifiers: ['Queso', 'Medio'],
      note: 'sin cebolla',
    });
    let t = await dining.ticketAction(tenant, kitchen, first.id, {
      to: 'accepted',
      expectedVersion: first.version,
    });
    t = await dining.ticketAction(tenant, kitchen, t.id, {
      to: 'preparing',
      expectedVersion: t.version,
    });
    await expect(
      dining.ticketAction(tenant, kitchen, t.id, { to: 'delivered', expectedVersion: t.version })
    ).rejects.toBeInstanceOf(DiningStateError); // no se salta «listo»
    await expect(
      dining.ticketAction(tenant, kitchen, t.id, { to: 'ready', expectedVersion: t.version - 1 })
    ).rejects.toBeInstanceOf(DiningVersionConflictError);
    t = await dining.ticketAction(tenant, kitchen, t.id, {
      to: 'ready',
      expectedVersion: t.version,
    });
    t = await dining.ticketAction(tenant, waiter, t.id, {
      to: 'delivered',
      expectedVersion: t.version,
    });
    // Recuperar una comanda marcada por error: motivo + permiso (cocina no tiene recall).
    await expect(
      dining.ticketAction(tenant, kitchen, t.id, {
        to: 'preparing',
        expectedVersion: t.version,
        reason: 'error',
      })
    ).rejects.toBeInstanceOf(VenueForbiddenError);
    await expect(
      dining.ticketAction(tenant, owner, t.id, { to: 'preparing', expectedVersion: t.version })
    ).rejects.toBeInstanceOf(DiningStateError);
    t = await dining.ticketAction(tenant, owner, t.id, {
      to: 'preparing',
      expectedVersion: t.version,
      reason: 'Marcada lista por error',
    });
    expect(t.status).toBe('preparing');
    const cur = await dining.get(tenant, owner, o.id);
    expect(cur.lines.find((l) => l.ticketId === t.id)!.prepStatus).toBe('preparing');
    // «Listo» no es «pagado»: el pedido sigue abierto.
    expect(cur.status).toBe('open');

    const ev = await ctx.admin.query<{ type: string; payload: { reason?: string } }>(
      `SELECT type, payload FROM dining_events WHERE ticket_id = $1 ORDER BY seq`,
      [t.id]
    );
    expect(ev.rows.at(-1)).toMatchObject({
      type: 'ticket_recalled',
      payload: { reason: 'Marcada lista por error' },
    });
  });

  it('anular una línea enviada genera comanda de anulación; la original no se toca', async () => {
    let o = await dining.open(tenant, waiter, { branchId: branch, mode: 'takeaway' });
    o = await dining.addLines(tenant, waiter, o.id, {
      expectedVersion: o.version,
      lines: [{ productId: soda, quantity: 3 }],
    });
    o = (await dining.sendToKitchen(tenant, waiter, o.id, o.version)).order;
    const line = o.lines[0]!;
    // El mesero no tiene permiso para anular lo enviado.
    await expect(
      dining.voidLine(tenant, waiter, o.id, {
        lineId: line.id,
        reason: 'se equivocó',
        expectedVersion: o.version,
      })
    ).rejects.toBeInstanceOf(VenueForbiddenError);
    o = await dining.voidLine(tenant, owner, o.id, {
      lineId: line.id,
      reason: 'El cliente cambió de opinión',
      expectedVersion: o.version,
    });
    expect(o.total).toBe(0n);
    expect(o.tickets.map((t) => t.kind)).toEqual(['new', 'void']);
    const snap = await dining.kitchenSnapshot(tenant, owner, branch, 'barra');
    const voidT = snap.tickets.find((t) => t.orderId === o.id && t.kind === 'void')!;
    expect(voidT.items[0]).toMatchObject({
      voided: true,
      voidReason: 'El cliente cambió de opinión',
    });
  });

  it('mover mesa: mesa destino libre; dos meseros a la vez → conflicto de versión', async () => {
    const a = await dining.open(tenant, waiter, {
      branchId: branch,
      mode: 'dine_in',
      tableId: table2,
    });
    await expect(
      dining.open(tenant, waiter, { branchId: branch, mode: 'dine_in', tableId: table2 })
    ).rejects.toBeInstanceOf(TableOccupiedError);
    // table1 sigue ocupada por el pedido de la primera prueba.
    await expect(
      dining.moveTable(tenant, waiter, a.id, { toTableId: table1, expectedVersion: a.version })
    ).rejects.toBeInstanceOf(TableOccupiedError);
    const results = await Promise.allSettled([
      dining.addLines(tenant, waiter, a.id, {
        expectedVersion: a.version,
        lines: [{ productId: soda, quantity: 1 }],
      }),
      dining.addLines(tenant, waiter, a.id, {
        expectedVersion: a.version,
        lines: [{ productId: soda, quantity: 1 }],
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason
    ).toBeInstanceOf(DiningVersionConflictError);
  });
});

describe('permisos efectivos y aislamiento', () => {
  it('un mesero de otra sucursal no opera esta; cocina no abre pedidos', async () => {
    await expect(
      dining.open(tenant, waiterOtherBranch, { branchId: branch, mode: 'takeaway' })
    ).rejects.toBeInstanceOf(VenueForbiddenError);
    await expect(
      dining.open(tenant, kitchen, { branchId: branch, mode: 'takeaway' })
    ).rejects.toBeInstanceOf(VenueForbiddenError);
    await expect(dining.kitchenSnapshot(tenant, waiter, branch)).rejects.toBeInstanceOf(
      VenueForbiddenError
    );
  });

  it('otra organización no ve ni toca los pedidos (RLS)', async () => {
    const o = await dining.open(tenant, owner, { branchId: branch, mode: 'pickup' });
    await expect(dining.get(other, owner, o.id)).rejects.toThrow(/not found/);
    await expect(dining.open(other, owner, { branchId: branch, mode: 'pickup' })).rejects.toThrow();
  });

  it('acceso real desde la membresía: owner completo; staff según venue_staff', async () => {
    const u = await ctx.admin.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`mesero-${randomUUID()}@example.com`]
    );
    const userId = u.rows[0]!.id;
    await ctx.admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'staff')`,
      [tenant, userId]
    );
    await venue.assignStaff(tenant, { userId, role: 'cashier', branchId: branch });
    const acc = await venue.access(tenant, userId, 'staff');
    expect(acc).toMatchObject({ full: false, grants: [{ role: 'cashier', branchId: branch }] });
    expect((await venue.access(tenant, userId, 'owner')).full).toBe(true);
  });
});

describe('pedido del cliente (QR)', () => {
  it('sujeto a aceptación: no llega a cocina hasta aceptarse; seguimiento solo con su token', async () => {
    const { order, trackingToken } = await dining.createCustomerOrder(tenant, {
      branchId: branch,
      tableId: null,
      mode: 'pickup',
      needsAcceptance: true,
      customerName: 'Ana',
      lines: [{ productId: soda, quantity: 2 }],
      expectedTotal: 600n,
    });
    expect(order.status).toBe('pending_acceptance');
    await expect(
      dining.sendToKitchen(tenant, owner, order.id, order.version)
    ).rejects.toBeInstanceOf(DiningStateError);
    const seen = await dining.byTrackingToken(trackingToken);
    expect(seen?.order.id).toBe(order.id);
    expect(await dining.byTrackingToken('x'.repeat(32))).toBeNull();
    const acc = await dining.acceptCustomerOrder(tenant, waiter, order.id, {
      accept: true,
      expectedVersion: order.version,
    });
    expect(acc.status).toBe('open');
    // Aceptar = llega a cocina en ese momento; un envío posterior no duplica.
    expect(acc.tickets).toHaveLength(1);
    expect(acc.lines.every((l) => l.prepStatus === 'queued')).toBe(true);
    expect((await dining.sendToKitchen(tenant, waiter, acc.id, acc.version)).tickets).toHaveLength(
      0
    );
    expect(await dining.requestAttention(trackingToken)).toBe(true);
  });

  it('sin aceptación previa, el pedido del cliente llega directo a cocina', async () => {
    const { order } = await dining.createCustomerOrder(tenant, {
      branchId: branch,
      tableId: null,
      mode: 'pickup',
      needsAcceptance: false,
      lines: [{ productId: soda, quantity: 1 }],
      expectedTotal: 300n,
    });
    expect(order.status).toBe('open');
    expect(order.tickets).toHaveLength(1);
    expect(order.tickets[0]!.kind).toBe('new');
  });

  it('el total mostrado debe coincidir con el del servidor', async () => {
    await expect(
      dining.createCustomerOrder(tenant, {
        branchId: branch,
        tableId: null,
        mode: 'pickup',
        needsAcceptance: true,
        lines: [{ productId: soda, quantity: 1 }],
        expectedTotal: 1n,
      })
    ).rejects.toBeInstanceOf(DiningStateError);
  });

  it('modificador obligatorio también para el cliente', async () => {
    await expect(
      dining.createCustomerOrder(tenant, {
        branchId: branch,
        tableId: null,
        mode: 'pickup',
        needsAcceptance: true,
        lines: [{ productId: burger, quantity: 1 }],
        expectedTotal: 9999n,
      })
    ).rejects.toBeInstanceOf(ModifierSelectionError);
    void cooking;
  });
});
