import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Jornada «restaurantes y cobro presencial» contra el STACK REAL (API +
 * PostgreSQL + panel + checkout). Datos propios de esta corrida (organización,
 * personas y comercio nuevos); nada de la demo se toca.
 *
 *   DEMO_APP_URL       panel   (por defecto 127.0.0.1:3342)
 *   CHECKOUT_URL       checkout (por defecto 127.0.0.1:3341)
 *   API_URL            API     (por defecto 127.0.0.1:3340)
 *   ADMIN_DATABASE_URL para sembrar la organización y las membresías
 *   CAPTURE_DIR        si existe, guarda capturas 390/768/1440 y KDS
 *
 * Cubre: configuración del restaurante por el dueño; mesero (móvil) abre mesa
 * con modificadores y envía; cocina (tablet) prepara desde OTRO usuario y
 * dispositivo; corte de red de la cocina y reconexión sin pérdida ni
 * duplicados; agregado posterior como revisión; cuenta dividida, una parte
 * por QR/checkout y otra por cobro presencial SIMULADO; cierre verificado;
 * comensal por QR con aceptación y seguimiento; independiente «Cobrar»; y
 * aislamiento entre organizaciones.
 */
const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3342';
const API = process.env.API_URL ?? 'http://127.0.0.1:3340';
const ADMIN_DB =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/fluvia';
const CAPTURE = process.env.CAPTURE_DIR ? resolve(process.env.CAPTURE_DIR) : null;
const PASSWORD = 'restaurante e2e password 77';
const RUN = randomUUID().slice(0, 8);

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.use({
  locale: 'es-VE',
  launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {},
});

const sql = (q: string) =>
  execFileSync('psql', [ADMIN_DB, '-Atq', '-c', q], { encoding: 'utf8' }).trim();

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function newUser(tag: string): Promise<{ id: string; email: string }> {
  const email = `${tag}-${RUN}@restaurante.e2e.test`;
  // El registro tiene límite por IP (5/min): se respeta Retry-After, sin tocar el límite.
  let reg = await api('POST', '/v1/auth/register', { email, password: PASSWORD });
  for (let i = 0; reg.status === 429 && i < 3; i++) {
    await new Promise((r) => setTimeout(r, 61_000));
    reg = await api('POST', '/v1/auth/register', { email, password: PASSWORD });
  }
  expect(reg.status, JSON.stringify(reg.json)).toBe(201);
  await api('POST', '/v1/auth/verify-email', { token: reg.json.verification_token });
  return { id: reg.json.user_id, email };
}

function newOrg(name: string, currency = 'USD'): string {
  const id = sql(
    `INSERT INTO organizations (name, slug) VALUES ('${name} ${RUN}', 'e2e-${RUN}-${randomUUID().slice(0, 6)}') RETURNING id`
  );
  sql(
    `INSERT INTO merchants (tenant_id, name, default_currency) VALUES ('${id}', '${name} ${RUN}', '${currency}')`
  );
  return id;
}
const member = (org: string, user: string, role: string) =>
  sql(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ('${org}', '${user}', '${role}')`);

async function login(
  browser: Browser,
  email: string,
  viewport: { width: number; height: number },
  orgId?: string
) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  await p.goto(`${APP}/login`);
  await p.getByLabel('Correo electrónico').fill(email);
  await p.getByLabel('Contraseña').fill(PASSWORD);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  // Entrada a la organización: cada rol aterriza en su pantalla de trabajo.
  if (orgId) await p.goto(`${APP}/o/${orgId}`);
  return p;
}

async function shot(p: Page, name: string) {
  if (!CAPTURE) return;
  mkdirSync(CAPTURE, { recursive: true });
  await p.screenshot({ path: `${CAPTURE}/${name}.png`, fullPage: true });
}

async function noHorizontalScroll(p: Page) {
  const r = await p.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(r.sw, p.url()).toBeLessThanOrEqual(r.cw + 1);
}

const MOBILE = { width: 390, height: 844 };
const TABLET = { width: 1024, height: 768 };
const DESKTOP = { width: 1440, height: 900 };

let org: string;
let otherOrg: string;
let owner: { id: string; email: string };
let waiter: { id: string; email: string };
let cook: { id: string; email: string };
let cashier: { id: string; email: string };
let menuUrl: string;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  org = newOrg('Fonda E2E');
  otherOrg = newOrg('Otra E2E');
  owner = await newUser('dueno');
  waiter = await newUser('mesero');
  cook = await newUser('cocina');
  cashier = await newUser('caja');
  member(org, owner.id, 'owner');
  for (const u of [waiter, cook, cashier]) member(org, u.id, 'staff');
  const other = await newUser('otro');
  member(otherOrg, other.id, 'owner');
  // Catálogo por la API real con la sesión del dueño.
  const lg = await api('POST', '/v1/auth/login', { email: owner.email, password: PASSWORD });
  const tok = lg.json.session_token as string;
  for (const [name, price] of [
    ['Hamburguesa', 800],
    ['Agua', 150],
    ['Arepa', 450],
  ] as const) {
    const r = await api(
      'POST',
      `/v1/organizations/${org}/catalog/products`,
      { name, price, currency: 'USD' },
      tok
    );
    expect(r.status).toBe(201);
  }
});

test('el dueño configura el restaurante, la habilitación y el personal', async ({ browser }) => {
  const p = await login(browser, owner.email, DESKTOP, org);
  await p.goto(`${APP}/o/${org}/negocio`);
  await p.getByRole('radio', { name: /Restaurante/ }).click();
  await p.getByRole('button', { name: 'Guardar configuración' }).click();
  await expect(p.getByText('No se borró ningún dato')).toBeVisible();

  for (let i = 0; i < 4; i++)
    await p.getByRole('button', { name: 'Marcar cumplido' }).first().click();
  await expect(p.getByRole('button', { name: 'Marcar cumplido' })).toHaveCount(0);
  await p.getByRole('button', { name: 'Proveedor habilita' }).click();
  await expect(p.locator('#habilitacion').getByText('Habilitada')).toBeVisible();

  await p.getByLabel('Nueva sucursal').fill('Centro');
  await p.getByRole('button', { name: 'Agregar sucursal' }).click();
  const br = p.getByRole('article', { name: 'Sucursal Centro' });
  await br.getByLabel('Nuevo salón').fill('Salón');
  await br.getByRole('button', { name: 'Agregar salón' }).click();
  await expect(br.getByText('Salones: Salón')).toBeVisible();
  for (const label of ['M1', 'M2']) {
    await br.getByRole('textbox', { name: 'Mesa', exact: true }).fill(label);
    await br.getByRole('combobox', { name: 'Salón', exact: true }).selectOption({ label: 'Salón' });
    await br.getByRole('button', { name: 'Agregar mesa' }).click();
    await expect(br.getByText(label, { exact: true })).toBeVisible();
  }
  await br.getByLabel('Estación (código)').fill('parrilla');
  await br.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Parrilla');
  await br.getByRole('button', { name: 'Agregar estación' }).click();
  await expect(br.getByText('Parrilla (parrilla)')).toBeVisible();

  // Modificadores: término obligatorio + extras.
  await p.getByLabel('Grupo de modificadores').fill('Término');
  await p.getByLabel('Mín.').fill('1');
  await p.getByLabel('Máx.').fill('1');
  await p.getByLabel(/^Opciones/).fill('Medio:0, Bien cocido:0');
  await p.getByRole('button', { name: 'Crear grupo' }).click();
  const burger = p.locator('li.vn-product-row', { hasText: 'Hamburguesa' });
  await burger.getByLabel('Estación').selectOption('parrilla');
  await burger.getByLabel('Ingredientes').fill('Pan, carne de res, lechuga');
  await burger.getByLabel('Modificadores').selectOption({ label: 'Término' });
  await burger.getByRole('button', { name: 'Guardar' }).click();
  await expect(p.getByText('Guardado: Hamburguesa')).toBeVisible();

  const staff = p.getByRole('region', { name: 'Personal del local' });
  for (const [u, role] of [
    [waiter, 'Mesero'],
    [cook, 'Cocina'],
    [cashier, 'Cajero'],
  ] as const) {
    await staff.getByLabel('Persona (miembro del equipo)').selectOption({ label: u.email });
    await staff.getByLabel('Rol en el local').selectOption({ label: role });
    await staff.getByRole('button', { name: 'Asignar' }).click();
    await expect(staff.getByText(`${u.email} — ${role}`)).toBeVisible();
  }
  // QR de la mesa M1 (para el comensal).
  const m1 = br.locator('li.vn-tile', { hasText: 'M1' });
  await m1.getByRole('button', { name: 'Ver QR' }).click();
  await expect(m1.getByRole('img', { name: /QR del menú de la mesa M1/ })).toBeVisible();
  menuUrl = (await m1.getByRole('link', { name: 'Abrir menú' }).getAttribute('href'))!;
  await shot(p, 'negocio-1440');
  await p.context().close();
});

test('mesa → cocina en otro dispositivo → reconexión → cuenta dividida → cierre verificado', async ({
  browser,
}) => {
  // Mesero en el teléfono.
  const w = await login(browser, waiter.email, MOBILE, org);
  await expect(w).toHaveURL(new RegExp(`/o/${org}/sala$`));
  await noHorizontalScroll(w);
  await shot(w, 'sala-390');
  await w.getByRole('button', { name: /^M1/ }).click();
  await w.waitForURL(/\/sala\/[0-9a-f-]{36}$/);
  await w.getByRole('button', { name: /Hamburguesa/ }).click();
  const dlg = w.getByRole('dialog', { name: 'Hamburguesa' });
  await expect(dlg.getByRole('button', { name: 'Agregar' })).toBeDisabled(); // término obligatorio
  await dlg.getByRole('button', { name: 'Medio' }).click();
  await dlg.getByLabel('Nota para cocina').fill('sin cebolla');
  await dlg.getByRole('button', { name: 'Agregar' }).click();
  await expect(w.getByRole('list', { name: 'Sin guardar' })).toBeVisible();
  await w.getByRole('button', { name: 'Enviar a cocina' }).click();
  await expect(w.getByText(/Enviado a cocina \(1 comanda\)/)).toBeVisible();
  await expect(
    w.getByRole('list', { name: 'Líneas guardadas' }).getByText('En cola')
  ).toBeVisible();
  await noHorizontalScroll(w);
  await shot(w, 'pedido-390');
  const orderUrl = w.url();

  // Cocina en una tablet, otro usuario.
  const k = await login(browser, cook.email, TABLET, org);
  await expect(k).toHaveURL(new RegExp(`/o/${org}/cocina$`));
  await expect(k.getByText('En vivo')).toBeVisible({ timeout: 15_000 });
  const card = k.getByRole('listitem', { name: /Comanda \d+, Mesa M1/ });
  await expect(card).toBeVisible();
  await expect(card.getByText('sin cebolla')).toBeVisible();
  await expect(card.getByText('Medio')).toBeVisible();
  await card.getByRole('button', { name: 'Aceptar' }).click();
  await expect(card.getByText('Aceptada', { exact: true })).toBeVisible();
  await shot(k, 'kds-tablet-1024');

  // Corte de red de la cocina: el mesero agrega; al volver, la cocina lo ve una vez.
  await k.context().setOffline(true);
  await w.getByRole('button', { name: /^Agua/ }).click();
  await w.getByRole('button', { name: 'Enviar a cocina' }).click();
  await expect(w.getByText(/Enviado a cocina/)).toBeVisible();
  await k.context().setOffline(false);
  const addition = k.getByRole('listitem', { name: /Agregado \d+, Mesa M1/ });
  await expect(addition).toBeVisible({ timeout: 30_000 });
  await expect(k.getByRole('listitem', { name: /Mesa M1/ })).toHaveCount(2);

  // Preparar y entregar ambas comandas (acción confirmada por el servidor).
  // Cada paso espera a que el servidor confirme el anterior (el botón cambia
  // solo con su respuesta; mientras tanto dice «Enviando…»).
  for (const [c, steps] of [
    [card, ['En preparación', 'Listo', 'Entregado']],
    [addition, ['Aceptar', 'En preparación', 'Listo', 'Entregado']],
  ] as const) {
    for (const action of steps) {
      const b = c.getByRole('button', { name: action, exact: true });
      await expect(b).toBeVisible();
      await b.click();
    }
  }
  await expect(k.getByRole('listitem', { name: /Mesa M1/ })).toHaveCount(0);

  // Pedir la cuenta (mesero) y cobrar dividida (cajero en escritorio).
  await w.reload();
  await w.getByRole('button', { name: 'Pedir la cuenta' }).click();
  await expect(w.getByText('Cuenta pedida').first()).toBeVisible();
  const c = await login(browser, cashier.email, DESKTOP, org);
  await c.goto(orderUrl);
  await c.getByRole('button', { name: 'Abrir cuenta' }).click();
  await expect(c.getByRole('heading', { name: /Cuenta · / })).toBeVisible();
  await c.getByLabel('Partes iguales').fill('2');
  await c.getByRole('button', { name: 'Dividir lo que falta' }).click();
  const parts = c.getByRole('list', { name: 'Partes de la cuenta' }).locator('li');
  await expect(parts).toHaveCount(2);
  await expect(parts.first()).toContainText('US$ 4,75'); // (800 + 150) / 2 = 475 unidades menores
  await shot(c, 'cuenta-1440');

  // Parte 1: el comensal paga por QR en el checkout existente.
  await parts.first().getByRole('button', { name: 'QR para pagar' }).click();
  const payUrl = (await parts.first().getByRole('link').first().getAttribute('href'))!;
  const buyer = await browser.newPage({ viewport: MOBILE });
  await buyer.goto(payUrl);
  await buyer.getByText('Tarjeta de prueba (aprobada)').click();
  await buyer.getByRole('button', { name: /^Pagar/ }).click();
  await expect(buyer.getByText(/Pago completado/)).toBeVisible({ timeout: 20_000 });
  await buyer.close();

  // Parte 2: cobro presencial SIMULADO (marcado como tal).
  await parts.nth(1).getByRole('button', { name: 'Cobro presencial (simulado)' }).click();
  await expect(parts.nth(1).getByText('Esperando tarjeta (simulador)')).toBeVisible();
  await parts.nth(1).getByRole('button', { name: 'Proveedor aprueba' }).click();
  await c.getByRole('button', { name: 'Verificar cobros ahora' }).click();
  await expect(c.getByText('Pagada (verificada)')).toBeVisible({ timeout: 15_000 });
  await w.reload();
  await expect(w.getByText(/Pagado y cerrado/).first()).toBeVisible();
  for (const ctx of [w, k, c]) await ctx.context().close();
});

test('comensal por QR: menú del catálogo, pedido sujeto a aceptación y seguimiento', async ({
  browser,
}) => {
  const g = await browser.newPage({ viewport: MOBILE });
  await g.goto(menuUrl);
  await expect(g.getByRole('heading', { name: 'Mesa M1' })).toBeVisible();
  await expect(g.getByText('Ingredientes: Pan, carne de res, lechuga')).toBeVisible();
  await expect(g.getByText(/Alérgenos: no informado/).first()).toBeVisible();
  await noHorizontalScroll(g);
  await shot(g, 'menu-qr-390');
  await g.getByRole('button', { name: 'Agregar Arepa' }).click();
  await g
    .getByRole('dialog')
    .getByRole('button', { name: /Agregar/ })
    .click();
  await g.getByRole('button', { name: 'Revisar pedido' }).click();
  await expect(g.getByText('Total').first()).toBeVisible();
  await g.getByLabel('Tu nombre (opcional)').fill('Ana');
  await g.getByRole('button', { name: /Confirmar pedido/ }).click();
  await g.waitForURL(/\/p#/);
  await expect(
    g.getByRole('heading', { name: 'Esperando confirmación del personal' })
  ).toBeVisible();
  await g.getByRole('button', { name: 'Llamar al personal' }).click();
  await expect(g.getByText('Avisamos al personal')).toBeVisible();

  const w = await login(browser, waiter.email, MOBILE, org);
  await expect(w.getByText(/Pedidos de clientes por aceptar \(1\)/)).toBeVisible();
  await w.getByRole('button', { name: 'Aceptar y enviar a cocina' }).click();
  await expect(g.getByRole('heading', { name: 'Pedido confirmado' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(g.getByText('En cola')).toBeVisible();
  await shot(g, 'seguimiento-390');
  // El token del QR no expone pedidos ajenos: la vista pública no lista otros pedidos.
  const pub = await (await fetch(`${API}/v1/public/tables/${menuUrl.split('/m/')[1]}`)).text();
  expect(pub).not.toMatch(/tracking|order_id|"orders"/);
  await w.context().close();
  await g.close();
});

test('independiente: «Cobrar» en el teléfono con habilitación y simulador explícito', async ({
  browser,
}) => {
  const solo = newOrg('Taxi E2E');
  const driver = await newUser('taxi');
  member(solo, driver.id, 'owner');
  const p = await login(browser, driver.email, MOBILE, solo);
  await p.goto(`${APP}/o/${solo}/negocio`);
  await p.getByRole('radio', { name: /Independiente/ }).click();
  await p.getByRole('button', { name: 'Guardar configuración' }).click();
  await expect(p.getByText('No se borró ningún dato')).toBeVisible();
  // Sin habilitación no se cobra con tarjeta.
  await p.goto(`${APP}/o/${solo}/cobrar`);
  await expect(p.getByText(/Cobro presencial pendiente de habilitación/)).toBeVisible();
  await expect(p.getByRole('button', { name: 'Acercar tarjeta' })).toBeDisabled();
  await shot(p, 'cobrar-pendiente-390');
  await p.goto(`${APP}/o/${solo}/negocio`);
  for (let i = 0; i < 4; i++)
    await p.getByRole('button', { name: 'Marcar cumplido' }).first().click();
  await p.getByRole('button', { name: 'Proveedor habilita' }).click();
  await expect(p.locator('#habilitacion').getByText('Habilitada')).toBeVisible();

  await p.goto(`${APP}/o/${solo}/cobrar`);
  await p.getByLabel('Importe').fill('25,00');
  await p.getByLabel('Concepto (opcional)').fill('Carrera aeropuerto');
  await p.getByRole('button', { name: 'Acercar tarjeta' }).click();
  await expect(
    p.getByRole('heading', { name: 'Este dispositivo no puede leer tarjetas' })
  ).toBeVisible();
  await expect(p.getByText(/no es un terminal de pago certificado/)).toBeVisible();
  await shot(p, 'cobrar-dispositivo-390');
  await p.getByRole('button', { name: 'Simular cobro (sandbox)' }).click();
  await expect(p.getByText('Simulado · sin tarjeta real')).toBeVisible();
  await expect(p.getByRole('heading', { name: 'Acerque la tarjeta' })).toBeVisible();
  await p.getByRole('button', { name: 'Proveedor aprueba' }).click();
  await expect(p.getByRole('heading', { name: 'Pago aprobado' })).toBeVisible();
  await expect(p.getByText('Simulador sandbox (sin tarjeta real)')).toBeVisible();
  await noHorizontalScroll(p);
  await shot(p, 'cobrar-aprobado-390');

  // Alternativa que funciona hoy: QR / enlace.
  await p.getByRole('button', { name: 'Nuevo cobro' }).click();
  await p.getByLabel('Importe').fill('12,50');
  await p.getByRole('button', { name: 'Cobrar con QR o enlace' }).click();
  await expect(p.getByRole('img', { name: /Código QR del enlace de pago/ })).toBeVisible();
  await p.context().close();
});

test('aislamiento: el personal no entra a otra organización ni ve pagos', async ({ browser }) => {
  const w = await login(browser, waiter.email, DESKTOP, org);
  await w.goto(`${APP}/o/${otherOrg}/sala`);
  await expect(w.getByRole('heading', { name: 'Sin acceso a esta organización' })).toBeVisible();
  // Desde el navegador del mesero (con su sesión): ni la cocina de otra
  // sucursal ni los pagos de la organización.
  const status = (url: string) => w.evaluate(async (u) => (await fetch(u)).status, url);
  expect([403, 404]).toContain(
    await status(`/api/orgs/${org}/v/kitchen/snapshot?branch_id=${randomUUID()}`)
  );
  expect(await status(`/api/orgs/${otherOrg}/v/business-profile`)).toBe(404);
  await w.goto(`${APP}/o/${org}`);
  await expect(w).toHaveURL(new RegExp(`/o/${org}/sala$`));
  await w.context().close();
});

test('KDS en monitor 1920 y sala/negocio en 768', async ({ browser }) => {
  const k = await login(browser, cook.email, { width: 1920, height: 1080 }, org);
  await expect(k.getByText('En vivo')).toBeVisible({ timeout: 15_000 });
  await shot(k, 'kds-monitor-1920');
  await k.context().close();
  const o = await login(browser, owner.email, { width: 768, height: 1024 }, org);
  await o.goto(`${APP}/o/${org}/sala`);
  await noHorizontalScroll(o);
  await shot(o, 'sala-768');
  await o.goto(`${APP}/o/${org}/negocio`);
  await noHorizontalScroll(o);
  await shot(o, 'negocio-768');
  await o.context().close();
});
