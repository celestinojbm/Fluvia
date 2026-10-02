import { hashPassword } from '@fluvia/auth';
import type { Pool } from '@fluvia/db';
import { seedUuid } from './deterministic.js';
import { SeedEnvironmentError } from './seed.js';

/**
 * Seed de DEMO de restaurantes y cobro presencial (SOLO local/test).
 *
 *  - Personas y organizaciones sintéticas por SQL (ids deterministas, como el
 *    seed principal); TODO lo demás pasa por la API real (perfil de negocio,
 *    habilitación sandbox, sucursal, mesas, estación, menú, personal), así
 *    se respetan las mismas invariantes que en producto.
 *  - Re-ejecutable: cada paso mira el estado antes de crear (no duplica).
 *  - Devuelve un informe con POSTCONDICIONES comprobadas; si alguna falla,
 *    lanza un error concreto (el script de arranque no lo ignora).
 *
 * No toca la organización «Demo Fluvia» ni el programa de Personal.
 */

export class RestaurantSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestaurantSeedError';
  }
}

interface Person {
  id: string;
  email: string;
  password: string;
}
const person = (email: string, password: string): Person => ({
  id: seedUuid(`user:${email}`),
  email,
  password,
});

export const RESTAURANT_DEMO = {
  restaurant: {
    id: seedUuid('org:demo-fonda'),
    name: 'Fonda de demostración',
    slug: 'demo-fonda',
    merchantId: seedUuid('merchant:demo-fonda'),
    currency: 'USD',
  },
  independent: {
    id: seedUuid('org:demo-independiente'),
    name: 'Cobros independiente (demo)',
    slug: 'demo-independiente',
    merchantId: seedUuid('merchant:demo-independiente'),
    currency: 'USD',
  },
  owner: person('dueno@restaurante.demo.fluvia.test', 'demo-dueno-password'),
  waiter: person('mesero@restaurante.demo.fluvia.test', 'demo-mesero-password'),
  kitchen: person('cocina@restaurante.demo.fluvia.test', 'demo-cocina-password'),
  cashier: person('caja@restaurante.demo.fluvia.test', 'demo-caja-password'),
  solo: person('independiente@demo.fluvia.test', 'demo-independiente-password'),
  branch: 'Centro',
  area: 'Salón',
  tables: ['M1', 'M2', 'M3', 'M4'],
  station: { code: 'cocina', name: 'Cocina' },
  menu: [
    {
      name: 'Arepa reina',
      price: 450,
      ingredients: 'Harina de maíz, pollo, aguacate, mayonesa',
      allergens: 'Huevo (mayonesa)',
    },
    {
      name: 'Hamburguesa',
      price: 800,
      ingredients: 'Pan, carne de res, lechuga, tomate',
      allergens: 'Gluten',
    },
    { name: 'Jugo de naranja', price: 250, ingredients: 'Naranja', allergens: null },
    { name: 'Agua', price: 150, ingredients: null, allergens: null },
  ],
} as const;

export interface RestaurantSeedReport {
  restaurantId: string;
  independentId: string;
  menuUrl: string;
  tables: number;
  menuItems: number;
  staff: Array<{ email: string; role: string }>;
  restaurantEnablement: string;
  independentEnablement: string;
}

type Json = Record<string, unknown>;

class Api {
  constructor(
    private readonly base: string,
    private token = ''
  ) {}
  async login(email: string, password: string) {
    const r = await this.req('POST', '/v1/auth/login', { email, password });
    if (r.status !== 200) {
      throw new RestaurantSeedError(`login de ${email} devolvió ${r.status}`);
    }
    this.token = String(r.json.session_token);
    return this;
  }
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json };
  }
  /** Igual que `req`, pero exige uno de los códigos esperados. */
  async must(method: string, path: string, body?: unknown, ok = [200, 201]) {
    const r = await this.req(method, path, body);
    if (!ok.includes(r.status)) {
      throw new RestaurantSeedError(
        `${method} ${path} devolvió ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`
      );
    }
    return r.json;
  }
}

async function identity(admin: Pool) {
  const D = RESTAURANT_DEMO;
  for (const o of [D.restaurant, D.independent]) {
    await admin.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [o.id, o.name, o.slug]
    );
    await admin.query(
      `INSERT INTO merchants (id, tenant_id, name, default_currency) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [o.merchantId, o.id, o.name, o.currency]
    );
  }
  const members: Array<[Person, string, string]> = [
    [D.owner, D.restaurant.id, 'owner'],
    [D.waiter, D.restaurant.id, 'staff'],
    [D.kitchen, D.restaurant.id, 'staff'],
    [D.cashier, D.restaurant.id, 'staff'],
    [D.solo, D.independent.id, 'owner'],
  ];
  for (const [u, org, role] of members) {
    await admin.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`,
      [u.id, u.email, await hashPassword(u.password)]
    );
    await admin.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [seedUuid(`membership:${u.email}:${org}`), org, u.id, role]
    );
  }
}

async function profile(api: Api, org: string, body: Json) {
  const p = await api.must('GET', `/v1/organizations/${org}/business-profile`);
  if (p.configured === true && p.business_type === body.business_type) return;
  await api.must('PUT', `/v1/organizations/${org}/business-profile`, {
    ...body,
    expected_version: p.version,
  });
}

async function enable(api: Api, org: string): Promise<string> {
  const base = `/v1/organizations/${org}/collection-enablement`;
  const e = await api.must('GET', base);
  if (e.status === 'enabled') return 'enabled';
  for (const r of ['identity', 'payout_account', 'terms', 'device']) {
    await api.must('POST', `${base}/requirements/${r}/complete`, undefined, [200, 201, 409]);
  }
  const d = await api.must('POST', `${base}/sandbox-decision`, { status: 'enabled' });
  return String(d.status);
}

export async function seedRestaurantDemo(
  env: string,
  deps: { admin: Pool; apiUrl: string }
): Promise<RestaurantSeedReport> {
  if (env !== 'local' && env !== 'test') throw new SeedEnvironmentError(env);
  const D = RESTAURANT_DEMO;
  const org = D.restaurant.id;
  const o = (p: string) => `/v1/organizations/${org}${p}`;
  await identity(deps.admin);

  // ── Restaurante ─────────────────────────────────────────────────────────
  const api = await new Api(deps.apiUrl).login(D.owner.email, D.owner.password);
  await profile(api, org, { business_type: 'restaurant' });
  const restaurantEnablement = await enable(api, org);

  type Branch = {
    id: string;
    name: string;
    areas: Array<{ id: string; name: string }>;
    tables: Array<{ label: string; menu_url: string | null }>;
    stations: Array<{ code: string }>;
  };
  const layout = async () =>
    ((await api.must('GET', o('/venue'))).branches as Branch[]).find((b) => b.name === D.branch);
  let br = await layout();
  if (!br) {
    await api.must('POST', o('/venue/branches'), { name: D.branch });
    br = (await layout())!;
  }
  if (!br.areas.some((a) => a.name === D.area)) {
    await api.must('POST', o('/venue/areas'), { branch_id: br.id, name: D.area });
    br = (await layout())!;
  }
  const area = br.areas.find((a) => a.name === D.area)!;
  for (const label of D.tables) {
    if (br.tables.some((t) => t.label === label)) continue;
    await api.must('POST', o('/venue/tables'), {
      branch_id: br.id,
      area_id: area.id,
      label,
      capacity: 4,
    });
  }
  if (!br.stations.some((s) => s.code === D.station.code)) {
    await api.must('POST', o('/venue/stations'), { branch_id: br.id, ...D.station });
  }

  const products = (await api.must('GET', o('/catalog/products'))).data as Array<{
    id: string;
    name: string;
  }>;
  for (const m of D.menu) {
    let id = products.find((p) => p.name === m.name)?.id;
    if (!id) {
      id = String(
        (
          await api.must('POST', o('/catalog/products'), {
            name: m.name,
            price: m.price,
            currency: D.restaurant.currency,
          })
        ).id
      );
    }
    // PUT idempotentes: estación e información del plato.
    await api.must('PUT', o(`/venue/products/${id}/route`), { station_code: D.station.code });
    await api.must('PUT', o(`/venue/products/${id}/info`), {
      ingredients: m.ingredients,
      allergen_info: m.allergens,
    });
  }

  const roles: Array<[Person, string]> = [
    [D.waiter, 'waiter'],
    [D.kitchen, 'kitchen'],
    [D.cashier, 'cashier'],
  ];
  const current = (await api.must('GET', o('/venue/staff'))).data as Array<{
    email: string;
    role: string;
  }>;
  for (const [u, role] of roles) {
    if (current.some((s) => s.email === u.email && s.role === role)) continue;
    await api.must('POST', o('/venue/staff'), { user_id: u.id, role, branch_id: br.id });
  }

  // ── Independiente («Cobrar») ────────────────────────────────────────────
  const solo = await new Api(deps.apiUrl).login(D.solo.email, D.solo.password);
  await profile(solo, D.independent.id, { business_type: 'services', solo: true });
  const independentEnablement = await enable(solo, D.independent.id);

  // ── Postcondiciones (comprobadas, no supuestas) ─────────────────────────
  br = (await layout())!;
  const staff = (
    (await api.must('GET', o('/venue/staff'))).data as Array<{
      email: string;
      role: string;
    }>
  ).map((s) => ({ email: s.email, role: s.role }));
  const menu = ((await api.must('GET', o('/catalog/products'))).data as Array<{ name: string }>)
    .map((p) => p.name)
    .filter((n) => D.menu.some((m) => m.name === n));
  const m1 = br.tables.find((t) => t.label === D.tables[0]);
  const problems = [
    br.tables.length < D.tables.length && `mesas ${br.tables.length}/${D.tables.length}`,
    menu.length !== D.menu.length && `menú ${menu.length}/${D.menu.length}`,
    roles.some(([u, r]) => !staff.some((s) => s.email === u.email && s.role === r)) &&
      'personal del local incompleto',
    restaurantEnablement !== 'enabled' && `habilitación restaurante=${restaurantEnablement}`,
    independentEnablement !== 'enabled' && `habilitación independiente=${independentEnablement}`,
    !m1?.menu_url && 'la mesa M1 no tiene URL de menú',
  ].filter(Boolean);
  // Cada persona entra con su contraseña sintética.
  for (const u of [D.waiter, D.kitchen, D.cashier]) {
    await new Api(deps.apiUrl).login(u.email, u.password);
  }
  if (problems.length) throw new RestaurantSeedError(`postcondiciones: ${problems.join('; ')}`);

  return {
    restaurantId: org,
    independentId: D.independent.id,
    menuUrl: m1!.menu_url!,
    tables: br.tables.length,
    menuItems: menu.length,
    staff,
    restaurantEnablement,
    independentEnablement,
  };
}
