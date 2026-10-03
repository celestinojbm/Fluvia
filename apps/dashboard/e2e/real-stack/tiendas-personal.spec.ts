import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Fluvia Personal · Tiendas contra el STACK REAL (API + PostgreSQL + panel +
 * checkout). Requiere `pnpm seed` y `pnpm --filter @fluvia/seeds run seed:tiendas`.
 *
 *   DEMO_APP_URL       panel (por defecto 127.0.0.1:3342)
 *   ADMIN_DATABASE_URL solo para provocar un cambio de precio y restaurarlo
 *   CAPTURE_DIR        si existe, guarda capturas 390 y 1440 de cada pantalla
 *
 * Cubre: búsqueda, variante agotada no seleccionable, favorito persistente,
 * carrito persistente, cambio de precio visible antes de pagar, pedido con
 * entrega, vuelta del checkout SIN marcarlo pagado, anulación que libera,
 * pedido con retiro pagado con la tarjeta Fluvia, reintento sin segundo
 * cobro, actividad, aislamiento entre clientes y ausencia de desbordes.
 */
const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3342';
const ADMIN_DB =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/fluvia';
const CAPTURE = process.env.CAPTURE_DIR ? resolve(process.env.CAPTURE_DIR) : null;

test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.use({ locale: 'es-VE', actionTimeout: 15_000, navigationTimeout: 30_000 });

/** Valores por variables de psql (`:'var'`); la sentencia es un literal fijo. */
const sql = (q: string, vars: Record<string, string>) =>
  execFileSync(
    'psql',
    [
      ADMIN_DB,
      '-Atq',
      '-v',
      'ON_ERROR_STOP=1',
      ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]),
    ],
    { encoding: 'utf8', input: q }
  ).trim();

let ctx: BrowserContext;
let p: Page;
let paidOrderUrl = '';
let paidOrderNumber = '';

async function login(page: Page, email: string, password: string) {
  await page.goto(`${APP}/personal/entrar`);
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await page.waitForURL(`${APP}/personal`);
}

async function noOverflow(page: Page) {
  const extra = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(extra, `desborde horizontal en ${page.url()}`).toBeLessThanOrEqual(1);
}

/** Captura 390 y 1440 sin cambiar de página (solo el viewport). */
async function shot(page: Page, name: string) {
  await noOverflow(page);
  if (!CAPTURE) return;
  mkdirSync(CAPTURE, { recursive: true });
  for (const [w, h] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(250);
    await noOverflow(page);
    await page.screenshot({ path: `${CAPTURE}/${name}-${w}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

async function emptyCart(page: Page) {
  await page.goto(`${APP}/personal/carrito`);
  // Cada clic recarga con el estado del servidor: «Menos» baja, «Quitar» elimina.
  for (let i = 0; i < 40; i++) {
    const ctl = page.getByRole('button', { name: /^(Quitar|Menos)$/ }).first();
    if (!(await ctl.isVisible().catch(() => false))) break;
    await ctl.click();
    await page.waitForLoadState('networkidle');
  }
  await expect(page.getByText('Tu carrito está vacío.')).toBeVisible();
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-VE' });
  p = await ctx.newPage();
  await login(p, 'cliente@demo.fluvia.test', 'demo-cliente-password');
  await emptyCart(p);
});

test.afterAll(async () => {
  await ctx?.close();
});

test('1. Buscar, elegir variante (la agotada no se puede) y añadir', async () => {
  await p.goto(`${APP}/personal/tiendas`);
  await expect(p.getByRole('heading', { name: 'Tiendas', level: 1 })).toBeVisible();
  await shot(p, '01-tiendas');
  await p.getByRole('searchbox').fill('lino');
  await p.getByRole('button', { name: 'Buscar', exact: true }).click();
  await p
    .getByRole('link', { name: /Camisa de lino crudo/ })
    .first()
    .click();
  await expect(p.getByRole('heading', { name: 'Camisa de lino crudo' })).toBeVisible();
  await expect(p.getByRole('button', { name: /Talla L/ })).toBeDisabled();
  await p.getByRole('button', { name: 'Talla M' }).click();
  await expect(p.getByRole('button', { name: 'Talla M' })).toHaveAttribute('aria-pressed', 'true');
  await shot(p, '03-producto');
  await p.getByRole('button', { name: 'Añadir al carrito' }).click();
  await expect(p.getByText('Añadido. Puedes seguir comprando en esta tienda.')).toBeVisible();
});

test('2. Favorito y carrito persisten tras recargar', async () => {
  await p.goto(`${APP}/personal/tiendas/taller-caribe`);
  const fav = p.getByRole('button', { name: 'Favorita: Taller Caribe' }).first();
  const before = await fav.getAttribute('aria-pressed');
  if (before !== 'true') await fav.click();
  await expect(fav).toHaveAttribute('aria-pressed', 'true');
  await p.reload();
  await expect(p.getByRole('button', { name: 'Favorita: Taller Caribe' }).first()).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await shot(p, '02-tienda');
  await p.goto(`${APP}/personal/tiendas?favoritas=1`);
  await expect(p.getByText('Taller Caribe').first()).toBeVisible();
  await p.goto(`${APP}/personal/carrito`);
  await p.reload();
  await expect(p.getByText(/Camisa de lino crudo/).first()).toBeVisible();
});

test('3. Pedido con entrega → checkout → volver NO lo marca pagado → anular', async () => {
  await p.goto(`${APP}/personal/carrito/taller-caribe?moneda=USD`);
  await expect(p.getByRole('heading', { name: 'Revisar pedido' })).toBeVisible();
  const cta = p.getByRole('button', { name: 'Continuar al pago' });
  // Entrega exige dirección.
  await p.getByLabel('Dirección de entrega').fill('Av. de prueba 123, Caracas');
  await p.getByLabel(/Compartir mi nombre y correo/).check();
  await shot(p, '05-revision');
  await cta.click();
  await p.waitForURL(/\/personal\/pedidos\/[0-9a-f-]{36}\/pagar$/);
  const orderUrl = p.url().replace(/\/pagar$/, '');
  // La tarjeta Fluvia es en VES: para USD solo se ofrece otra tarjeta.
  await expect(p.getByText(/Tarjeta Fluvia .* saldo/)).toHaveCount(0);
  await shot(p, '06-pago');
  await p.getByRole('radio', { name: /Otra tarjeta/ }).check();
  await p.getByRole('button', { name: 'Ir al checkout' }).click();
  // /l/<enlace> crea la sesión y redirige a /c/<sesión> (checkout alojado).
  await p.waitForURL(/\/c\/[^/]+/, { waitUntil: 'commit' });
  await expect(p.getByText('Entorno de pruebas — no se mueve dinero real.')).toBeVisible();
  await shot(p, '06b-checkout');
  // Vuelve sin pagar: el estado se lee del servidor.
  await p.goto(`${orderUrl}?pago=1`);
  await expect(p.getByText('Pendiente de pago', { exact: true })).toBeVisible();
  await expect(p.getByText('Pagado', { exact: true })).toHaveCount(0);
  await shot(p, '07-pedido-pendiente');
  await p.getByRole('button', { name: /Anular pedido/ }).click();
  await expect(p.getByText('Anulado', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(p.getByText(/Las existencias reservadas se liberaron/)).toBeVisible();
});

test('4. Cambio de precio visible antes de pagar; retiro pagado con la tarjeta Fluvia', async () => {
  await p.goto(`${APP}/personal/tiendas/casa-avila`);
  await p
    .getByRole('link', { name: /Taza de cerámica esmaltada/ })
    .first()
    .click();
  await p.getByRole('button', { name: 'Más' }).click();
  await p.getByRole('button', { name: 'Añadir al carrito' }).click();
  await expect(p.getByText('Añadido. Puedes seguir comprando en esta tienda.')).toBeVisible();

  // La taza tiene variantes: el cambio se aplica al producto y a todas ellas
  // (una sola sentencia) y se revierte con la inversa.
  const vars = { slug: 'casa-avila', name: 'Taza de cerámica esmaltada%' };
  const bump = (delta: string) =>
    sql(
      `UPDATE catalog_products p SET price = p.price + :'delta'::bigint
         FROM merchant_directory_profiles d
        WHERE d.tenant_id = p.tenant_id AND d.slug = :'slug' AND p.name LIKE :'name'`,
      { ...vars, delta }
    );
  bump('1000');
  try {
    await p.goto(`${APP}/personal/carrito`);
    await expect(p.getByText(/El precio cambió: antes/)).toBeVisible();
    await shot(p, '04-carrito-precio-cambiado');
  } finally {
    bump('-1000');
  }
  await p.reload();
  await expect(p.getByText(/El precio cambió: antes/)).toHaveCount(0);

  await p.goto(`${APP}/personal/carrito/casa-avila?moneda=VES`);
  await p.getByRole('radio', { name: /Retiro en tienda/ }).check();
  await p.getByLabel(/Compartir mi nombre y correo/).check();
  await p.getByRole('button', { name: 'Continuar al pago' }).click();
  await p.waitForURL(/\/pagar$/);
  await p.getByRole('radio', { name: /Tarjeta Fluvia .* saldo/ }).check();
  await p.getByRole('button', { name: 'Pagar', exact: true }).click();
  await p.waitForURL(/\/personal\/pedidos\/[0-9a-f-]{36}\?pago=1$/);
  await expect(p.getByText('Pagado', { exact: true })).toBeVisible();
  paidOrderUrl = p.url().replace(/\?pago=1$/, '');
  paidOrderNumber = (await p.getByRole('heading', { level: 1 }).innerText()).replace(/\D/g, '');
  await shot(p, '08-pedido-pagado');

  // Reintento: volver a la pantalla de pago no ofrece pagar otra vez.
  await p.goto(`${paidOrderUrl}/pagar`);
  await p.waitForURL(paidOrderUrl);
  await expect(p.getByRole('button', { name: 'Pagar', exact: true })).toHaveCount(0);
});

test('5. Actividad e Inicio reflejan el pedido; navegación de 5 destinos', async () => {
  await p.goto(`${APP}/personal/actividad?filtro=pedidos`);
  await expect(p.getByText(/Casa Ávila/).first()).toBeVisible();
  await shot(p, '09-actividad');
  await p.goto(`${APP}/personal`);
  const tabs = p.getByRole('navigation', { name: /principal|secciones/i }).last();
  for (const name of ['Inicio', 'Tiendas', 'Pagar', 'Actividad', 'Cuenta']) {
    await expect(tabs.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await shot(p, '10-inicio');
});

test('5b. El comercio ve el pedido cobrado y lo prepara; el cliente lo ve', async ({ browser }) => {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-VE' });
  const m = await c.newPage();
  await m.goto(`${APP}/login`);
  await m.getByLabel('Correo').fill('tiendas@demo.fluvia.test');
  await m.getByLabel('Contraseña').fill('demo-tiendas-password');
  await m.locator('form button[type="submit"]').click();
  await m.waitForURL((u) => !u.pathname.startsWith('/login'));
  // Tras entrar se llega a la lista de organizaciones; la de la demo de tiendas es la única.
  const href = await m.locator('a[href^="/o/"]').first().getAttribute('href');
  const org = href!.split('/')[2]!;
  await m.goto(`${APP}/o/${org}/tienda`);
  await expect(m.getByRole('heading', { name: 'Tienda en línea', level: 1 })).toBeVisible();
  const number = paidOrderNumber;
  const row = () =>
    m.getByRole('row').filter({
      has: m.getByRole('link', { name: `Venta #${number}`, exact: true }),
    });
  await expect(row().getByText('Cobrada')).toBeVisible();
  await row().getByRole('button', { name: 'Empezar a preparar' }).click();
  await expect(row().getByText('Preparando')).toBeVisible({ timeout: 15_000 });
  await shot(m, '11-comercio-tienda');
  await c.close();
  await p.goto(paidOrderUrl);
  await expect(p.locator('.pm-steps .is-now')).toContainText('En preparación');
});

test('6. Otro cliente no ve un pedido ajeno', async ({ browser }) => {
  expect(paidOrderUrl).toMatch(/pedidos\/[0-9a-f-]{36}$/);
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-VE' });
  const other = await c.newPage();
  await other.goto(`${APP}/personal/entrar?modo=crear`);
  await other.getByLabel('Nombre').fill('Cliente ajeno E2E');
  await other.getByLabel('Correo').fill(`ajeno-${Date.now()}@personal.fluvia.test`);
  await other.getByLabel('Contraseña').fill('una clave larga de prueba');
  await other.getByRole('button', { name: 'Crear cuenta' }).last().click();
  await other.waitForURL(`${APP}/personal`);
  await other.goto(paidOrderUrl);
  await expect(other.getByRole('heading', { name: 'No encontramos esto' })).toBeVisible();
  await expect(other.getByText('Casa Ávila')).toHaveCount(0);
  await c.close();
});

test('7. Enlace profundo sin sesión: «Entrar» devuelve a la misma pantalla', async ({
  browser,
}) => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-VE' });
  const page = await c.newPage();
  await page.goto(`${APP}/personal/tiendas/casa-avila?coleccion=Mesa`);
  await page.waitForURL(/\/personal\/entrar\?next=/);
  expect(new URL(page.url()).searchParams.get('next')).toBe(
    '/personal/tiendas/casa-avila?coleccion=Mesa'
  );
  await page.getByLabel('Correo').fill('cliente@demo.fluvia.test');
  await page.getByLabel('Contraseña').fill('demo-cliente-password');
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await page.waitForURL(`${APP}/personal/tiendas/casa-avila?coleccion=Mesa`);
  await expect(page.getByRole('heading', { name: 'Casa Ávila' })).toBeVisible();
  // Un «next» externo se ignora.
  await c.clearCookies();
  await page.goto(`${APP}/personal/entrar?next=//evil.example/personal`);
  await page.getByLabel('Correo').fill('cliente@demo.fluvia.test');
  await page.getByLabel('Contraseña').fill('demo-cliente-password');
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await page.waitForURL(`${APP}/personal`);
  await c.close();
});
