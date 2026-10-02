import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

/**
 * Restaurante por HTTP contra PostgreSQL real: configuración por owner,
 * permisos de LOCAL en el servidor (rol de membresía `staff` + venue_staff),
 * pedido de mesa → comandas con revisiones → KDS, versiones (409 sin
 * duplicar), stream SSE, QR público sin acceso a pedidos ajenos y
 * aislamiento entre organizaciones.
 */

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let orgA: string;
let orgB: string;
const PASSWORD = 'dining password 77';
type Headers = Record<string, string>;
type User = { userId: string; headers: Headers };

async function sessionUser(role: string, orgId: string): Promise<User> {
  const email = `din-${randomUUID().slice(0, 12)}@example.com`;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const { user_id, verification_token } = reg.json();
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: verification_token },
  });
  await adminPool.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
    orgId,
    user_id,
    role,
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return {
    userId: user_id as string,
    headers: { authorization: `Bearer ${login.json().session_token as string}` },
  };
}

async function createOrg(name: string): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  await adminPool.query(
    `INSERT INTO merchants (tenant_id, name, default_currency) VALUES ($1, $2, 'USD')`,
    [res.rows[0]!.id, `${name} SA`]
  );
  return res.rows[0]!.id;
}

const base = (org: string) => `/v1/organizations/${org}`;
async function call(
  u: User,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  payload?: unknown,
  org = orgA
) {
  return app.inject({
    method,
    url: `${base(org)}${path}`,
    headers: u.headers,
    payload: payload as never,
  });
}

let owner: User;
let waiter: User;
let cook: User;
let outsider: User; // staff sin rol de local
let ownerB: User;
let branch: string;
let otherBranch: string;
let table1: string;
let table2: string;
let qrToken: string;
let burger: string;
let cheeseOpt: string;
let pointGroup: string;
let medium: string;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  appPool = createPool({ connectionString: config.db.app, max: 8 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService: new ApiKeyService(appPool),
    authRateLimits: {
      loginPerEmail: { max: 10_000, windowMs: 60_000 },
      loginPerIp: { max: 10_000, windowMs: 60_000 },
      registerPerIp: { max: 10_000, windowMs: 60_000 },
      mfaPerIp: { max: 10_000, windowMs: 60_000 },
    },
  });
  await app.ready();
  orgA = await createOrg('Restaurante A');
  orgB = await createOrg('Restaurante B');
  owner = await sessionUser('owner', orgA);
  waiter = await sessionUser('staff', orgA);
  cook = await sessionUser('staff', orgA);
  outsider = await sessionUser('staff', orgA);
  ownerB = await sessionUser('owner', orgB);
}, 60_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
});

describe('configuración del restaurante (owner)', () => {
  it('perfil restaurante, sucursal, salón, mesas, estación, modificadores y personal', async () => {
    const p0 = await call(owner, 'GET', '/business-profile');
    expect(p0.json()).toMatchObject({ business_type: 'retail', configured: false, version: 0 });
    const p1 = await call(owner, 'PUT', '/business-profile', {
      business_type: 'restaurant',
      expected_version: 0,
    });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().modules).toEqual(expect.arrayContaining(['tables', 'kitchen', 'qr_menu']));
    // Versión vieja: conflicto, no sobrescritura silenciosa.
    const stale = await call(owner, 'PUT', '/business-profile', {
      business_type: 'retail',
      expected_version: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('version_conflict');

    branch = (await call(owner, 'POST', '/venue/branches', { name: 'Centro' })).json().id;
    otherBranch = (await call(owner, 'POST', '/venue/branches', { name: 'Playa' })).json().id;
    const area = (
      await call(owner, 'POST', '/venue/areas', { branch_id: branch, name: 'Salón' })
    ).json().id;
    const t1 = await call(owner, 'POST', '/venue/tables', {
      branch_id: branch,
      area_id: area,
      label: 'M1',
      capacity: 4,
    });
    expect(t1.statusCode).toBe(201);
    table1 = t1.json().id;
    qrToken = t1.json().qr_token;
    table2 = (
      await call(owner, 'POST', '/venue/tables', {
        branch_id: branch,
        area_id: area,
        label: 'M2',
        capacity: 2,
      })
    ).json().id;
    expect(
      (
        await call(owner, 'POST', '/venue/stations', {
          branch_id: branch,
          code: 'parrilla',
          name: 'Parrilla',
        })
      ).statusCode
    ).toBe(201);

    const prod = await call(owner, 'POST', '/catalog/products', {
      name: 'Hamburguesa',
      price: 800,
      currency: 'USD',
    });
    burger = prod.json().id;
    await call(owner, 'PUT', `/venue/products/${burger}/route`, { station_code: 'parrilla' });
    await call(owner, 'PUT', `/venue/products/${burger}/info`, {
      ingredients: 'Pan, carne de res, lechuga',
      allergen_info: null,
    });
    const extras = await call(owner, 'POST', '/venue/modifier-groups', {
      name: 'Extras',
      min_select: 0,
      max_select: 2,
      options: [{ name: 'Queso', price_delta: 100 }],
    });
    cheeseOpt = extras.json().options[0].id;
    const point = await call(owner, 'POST', '/venue/modifier-groups', {
      name: 'Término',
      min_select: 1,
      max_select: 1,
      options: [
        { name: 'Medio', price_delta: 0 },
        { name: 'Bien cocido', price_delta: 0 },
      ],
    });
    pointGroup = point.json().id;
    medium = point.json().options[0].id;
    for (const g of [extras.json().id, pointGroup]) {
      const r = await call(owner, 'PUT', `/venue/products/${burger}/modifier-groups/${g}`, {
        active: true,
      });
      expect(r.statusCode).toBe(200);
    }

    for (const [u, role, b] of [
      [waiter, 'waiter', branch],
      [cook, 'kitchen', branch],
    ] as const) {
      const r = await call(owner, 'POST', '/venue/staff', {
        user_id: u.userId,
        role,
        branch_id: b,
      });
      expect(r.statusCode).toBe(201);
    }
    const staff = await call(owner, 'GET', '/venue/staff');
    expect(staff.json().data).toHaveLength(2);
  });

  it('el personal no configura ni ve los QR; staff no lee pagos de la organización', async () => {
    expect((await call(waiter, 'POST', '/venue/branches', { name: 'X' })).statusCode).toBe(403);
    const layout = await call(waiter, 'GET', '/venue');
    expect(layout.statusCode).toBe(200);
    const tables = layout.json().branches.flatMap((b: { tables: unknown[] }) => b.tables);
    expect(tables.every((t: { qr_token: unknown }) => t.qr_token === null)).toBe(true);
    expect((await call(waiter, 'GET', '/payment_intents')).statusCode).toBe(403);
    const me = await call(waiter, 'GET', '/business-profile');
    expect(me.json().my_access).toMatchObject({
      membership_role: 'staff',
      can_configure: false,
      can_view_payments: false,
      venue: { full: false, grants: [{ role: 'waiter', branch_id: branch }] },
    });
  });
});

describe('mesa → cocina → entrega (personal en dispositivos distintos)', () => {
  let orderId: string;
  let version: number;

  it('mesero abre, agrega con modificadores y envía; cocina ve la comanda', async () => {
    const opened = await call(waiter, 'POST', '/dining/orders', {
      branch_id: branch,
      mode: 'dine_in',
      table_id: table1,
      guest_count: 2,
    });
    expect(opened.statusCode).toBe(201);
    orderId = opened.json().id;
    // La misma mesa no admite un segundo pedido abierto.
    const dup = await call(waiter, 'POST', '/dining/orders', {
      branch_id: branch,
      mode: 'dine_in',
      table_id: table1,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('table_occupied');

    // Falta el término obligatorio → 422.
    const bad = await call(waiter, 'POST', `/dining/orders/${orderId}/lines`, {
      expected_version: opened.json().version,
      lines: [{ product_id: burger, quantity: 1, option_ids: [cheeseOpt] }],
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('modifier_selection_invalid');

    const added = await call(waiter, 'POST', `/dining/orders/${orderId}/lines`, {
      expected_version: opened.json().version,
      lines: [
        { product_id: burger, quantity: 2, option_ids: [cheeseOpt, medium], note: 'sin cebolla' },
      ],
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().total).toBe(1800); // (800 + 100) × 2
    version = added.json().version;

    const sent = await call(waiter, 'POST', `/dining/orders/${orderId}/send`, {
      expected_version: version,
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().tickets).toHaveLength(1);
    expect(sent.json().tickets[0]).toMatchObject({
      kind: 'new',
      revision: 1,
      station_code: 'parrilla',
    });
    // Reintento con la versión vieja: 409, ninguna comanda duplicada.
    const again = await call(waiter, 'POST', `/dining/orders/${orderId}/send`, {
      expected_version: version,
    });
    expect(again.statusCode).toBe(409);
    version = sent.json().order.version;

    const snap = await call(cook, 'GET', `/kitchen/snapshot?branch_id=${branch}`);
    expect(snap.statusCode).toBe(200);
    const mine = snap.json().tickets.filter((t: { order_id: string }) => t.order_id === orderId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ table_label: 'M1', status: 'queued' });
    expect(mine[0].items[0]).toMatchObject({
      quantity: 2,
      modifiers: expect.arrayContaining(['Queso', 'Medio']),
      note: 'sin cebolla',
    });
  });

  it('cocina avanza estados con versión; mesero no puede actuar en cocina; el cocinero no abre mesas', async () => {
    const snap = await call(cook, 'GET', `/kitchen/snapshot?branch_id=${branch}`);
    const t = snap.json().tickets.find((x: { order_id: string }) => x.order_id === orderId);
    expect(
      (
        await call(waiter, 'POST', `/kitchen/tickets/${t.id}/action`, {
          to: 'accepted',
          expected_version: t.version,
        })
      ).statusCode
    ).toBe(403);
    expect(
      (await call(cook, 'POST', '/dining/orders', { branch_id: branch, mode: 'takeaway' }))
        .statusCode
    ).toBe(403);
    let v = t.version;
    for (const to of ['accepted', 'preparing', 'ready']) {
      const r = await call(cook, 'POST', `/kitchen/tickets/${t.id}/action`, {
        to,
        expected_version: v,
      });
      expect(r.statusCode, to).toBe(200);
      v = r.json().version;
    }
    // Doble toque con versión vieja: 409, el estado no salta.
    const stale = await call(cook, 'POST', `/kitchen/tickets/${t.id}/action`, {
      to: 'delivered',
      expected_version: v - 1,
    });
    expect(stale.statusCode).toBe(409);
    // El mesero entrega (orders:send).
    const dl = await call(waiter, 'POST', `/kitchen/tickets/${t.id}/action`, {
      to: 'delivered',
      expected_version: v,
    });
    expect(dl.statusCode).toBe(200);
  });

  it('agregado posterior = nueva revisión; anular una línea enviada = comanda de anulación', async () => {
    const cur = (await call(waiter, 'GET', `/dining/orders/${orderId}`)).json();
    const added = await call(waiter, 'POST', `/dining/orders/${orderId}/lines`, {
      expected_version: cur.version,
      lines: [{ product_id: burger, quantity: 1, option_ids: [medium] }],
    });
    const sent = await call(waiter, 'POST', `/dining/orders/${orderId}/send`, {
      expected_version: added.json().version,
    });
    expect(sent.json().tickets[0]).toMatchObject({ kind: 'addition', revision: 2 });
    const order = sent.json().order;
    // La primera línea (ya entregada) conserva su estado.
    expect(order.lines[0].prep_status).toBe('delivered');
    // Mesero sin orders:void_line no anula una línea enviada.
    const noVoid = await call(
      waiter,
      'POST',
      `/dining/orders/${orderId}/lines/${order.lines[1].id}/void`,
      {
        expected_version: order.version,
        reason: 'cliente cambió de idea',
      }
    );
    expect(noVoid.statusCode).toBe(403);
    const voided = await call(
      owner,
      'POST',
      `/dining/orders/${orderId}/lines/${order.lines[1].id}/void`,
      {
        expected_version: order.version,
        reason: 'cliente cambió de idea',
      }
    );
    expect(voided.statusCode).toBe(200);
    expect(voided.json().tickets.map((t: { kind: string }) => t.kind)).toContain('void');
    expect(voided.json().total).toBe(1800);
  });

  it('mover de mesa y pedir la cuenta', async () => {
    const cur = (await call(waiter, 'GET', `/dining/orders/${orderId}`)).json();
    const moved = await call(waiter, 'POST', `/dining/orders/${orderId}/move`, {
      expected_version: cur.version,
      to_table_id: table2,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().table_label).toBe('M2');
    const bill = await call(waiter, 'POST', `/dining/orders/${orderId}/request-bill`, {
      expected_version: moved.json().version,
    });
    expect(bill.statusCode).toBe(200);
    expect(bill.json().status).toBe('bill_requested');
    // La cuenta pedida no admite más platos.
    const late = await call(waiter, 'POST', `/dining/orders/${orderId}/lines`, {
      expected_version: bill.json().version,
      lines: [{ product_id: burger, quantity: 1, option_ids: [medium] }],
    });
    expect(late.statusCode).toBe(409);
  });

  it('aislamiento: staff sin rol de local, otra sucursal y otra organización', async () => {
    expect((await call(outsider, 'GET', `/dining/orders/${orderId}`)).statusCode).toBe(403);
    expect((await call(waiter, 'GET', `/dining/orders?branch_id=${otherBranch}`)).statusCode).toBe(
      403
    );
    expect(
      (await call(ownerB, 'GET', `/dining/orders/${orderId}`, undefined, orgB)).statusCode
    ).toBe(404);
    // Org ajena por la URL de A: indistinguible de inexistente.
    expect((await call(ownerB, 'GET', `/dining/orders/${orderId}`)).statusCode).toBe(404);
  });
});

describe('stream SSE del KDS', () => {
  it('anuncia cambios; reconectar con el cursor no pierde eventos', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const snap = (await call(cook, 'GET', `/kitchen/snapshot?branch_id=${branch}`)).json();
    const ctrl = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${port}${base(orgA)}/dining/stream?branch_id=${branch}&since=${snap.cursor}`,
      { headers: cook.headers, signal: ctrl.signal }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (re: RegExp) => {
      const deadline = Date.now() + 8000;
      while (!re.test(buf)) {
        if (Date.now() > deadline) throw new Error(`timeout waiting ${re}: ${buf}`);
        const { value, done } = await reader.read();
        if (done) throw new Error('stream closed');
        buf += dec.decode(value);
      }
    };
    await until(/event: ready/);
    // Otro usuario (mesero) abre un pedido para llevar: la cocina se entera.
    const o = await call(waiter, 'POST', '/dining/orders', { branch_id: branch, mode: 'takeaway' });
    expect(o.statusCode).toBe(201);
    await until(/event: changed\ndata: [^\n]*order_opened/);
    ctrl.abort();
    // Al reconectar, eventos desde el cursor viejo incluyen el cambio.
    const ev = await call(cook, 'GET', `/dining/events?branch_id=${branch}&since=${snap.cursor}`);
    expect(ev.json().data.map((e: { order_id: string }) => e.order_id)).toContain(o.json().id);
  });

  it('sin permiso de local, el stream responde 403 sin abrirse', async () => {
    const r = await call(outsider, 'GET', `/dining/stream?branch_id=${branch}`);
    expect(r.statusCode).toBe(403);
  });
});

describe('QR público de mesa', () => {
  it('muestra el menú SOLO con datos del catálogo y ningún pedido', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/public/tables/${qrToken}` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      table_label: 'M1',
      ordering: { enabled: true, needs_acceptance: true },
    });
    const item = body.menu.find((m: { id: string }) => m.id === burger);
    expect(item).toMatchObject({ ingredients: 'Pan, carne de res, lechuga', allergen_info: null });
    expect(JSON.stringify(body)).not.toMatch(/orders|tracking|tenant/);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/public/tables/${'x'.repeat(32)}` })).statusCode
    ).toBe(404);
  });

  it('pedido propio idempotente, sujeto a aceptación, con seguimiento privado', async () => {
    const key = `qr-${randomUUID()}`;
    const payload = {
      customer_name: 'Ana',
      expected_total: 800,
      lines: [{ product_id: burger, quantity: 1, option_ids: [medium] }],
    };
    const post = (p = payload) =>
      app.inject({
        method: 'POST',
        url: `/v1/public/tables/${qrToken}/orders`,
        headers: { 'idempotency-key': key },
        payload: p,
      });
    const first = await post();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ status: 'pending_acceptance', total: 800 });
    const tracking = first.json().tracking_token as string;
    // Reintento por red: misma respuesta, ningún pedido nuevo.
    const replay = await post();
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().tracking_token).toBe(tracking);
    // Misma clave, otro contenido: rechazado.
    const other = await post({ ...payload, customer_name: 'Otro' });
    expect(other.statusCode).toBe(422);
    expect(other.json().error.code).toBe('idempotency_key_reuse');
    // Total desactualizado: no se crea.
    const changed = await app.inject({
      method: 'POST',
      url: `/v1/public/tables/${qrToken}/orders`,
      headers: { 'idempotency-key': `qr-${randomUUID()}` },
      payload: { ...payload, expected_total: 700 },
    });
    expect(changed.statusCode).toBe(409);

    const view = await app.inject({ method: 'GET', url: `/v1/public/dining/orders/${tracking}` });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ status: 'pending_acceptance', table_label: 'M1' });
    expect(JSON.stringify(view.json())).not.toMatch(/"id"|branch_id|ticket/);
    expect(
      (await app.inject({ method: 'POST', url: `/v1/public/dining/orders/${tracking}/attention` }))
        .statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/public/dining/orders/${'a'.repeat(32)}` }))
        .statusCode
    ).toBe(404);

    // El personal ve el pedido con el llamado y lo acepta; cocina recién entonces.
    const list = await call(waiter, 'GET', `/dining/orders?branch_id=${branch}`);
    const o = list
      .json()
      .data.find((x: { source: string; status: string }) => x.source === 'customer');
    expect(o.attention_requested_at).not.toBeNull();
    const acc = await call(waiter, 'POST', `/dining/orders/${o.id}/decision`, {
      expected_version: o.version,
      accept: true,
    });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().status).toBe('open');
    const after = await app.inject({ method: 'GET', url: `/v1/public/dining/orders/${tracking}` });
    expect(after.json().status).toBe('open');
  });

  it('sin el módulo qr_menu, el QR no revela nada', async () => {
    const cur = (await call(owner, 'GET', '/business-profile')).json();
    await call(owner, 'PUT', '/business-profile', {
      business_type: 'restaurant',
      modules: cur.modules.filter((m: string) => m !== 'qr_menu'),
      expected_version: cur.version,
    });
    const r = await app.inject({ method: 'GET', url: `/v1/public/tables/${qrToken}` });
    expect(r.statusCode).toBe(404);
    const now = (await call(owner, 'GET', '/business-profile')).json();
    await call(owner, 'PUT', '/business-profile', {
      business_type: 'restaurant',
      expected_version: now.version,
    });
  });
});

describe('habilitación de cobro presencial', () => {
  it('pendiente por defecto; habilitar exige requisitos; la decisión es del proveedor (sandbox)', async () => {
    const e0 = await call(owner, 'GET', '/collection-enablement');
    expect(e0.json()).toMatchObject({ status: 'pending', provider: 'none' });
    const early = await call(owner, 'POST', '/collection-enablement/sandbox-decision', {
      status: 'enabled',
    });
    expect(early.statusCode).toBe(409);
    for (const r of ['identity', 'payout_account', 'terms', 'device']) {
      expect(
        (await call(owner, 'POST', `/collection-enablement/requirements/${r}/complete`)).statusCode
      ).toBe(200);
    }
    // El personal no decide la habilitación.
    expect(
      (await call(waiter, 'POST', '/collection-enablement/sandbox-decision', { status: 'enabled' }))
        .statusCode
    ).toBe(403);
    const ok = await call(owner, 'POST', '/collection-enablement/sandbox-decision', {
      status: 'enabled',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'enabled', provider: 'sandbox_simulator' });
    const sus = await call(owner, 'POST', '/collection-enablement/sandbox-decision', {
      status: 'suspended',
      reason: 'revisión del proveedor',
    });
    expect(sus.json().status).toBe('suspended');
  });
});
