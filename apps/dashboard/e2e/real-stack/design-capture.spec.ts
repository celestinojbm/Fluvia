import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Capturas comparables (antes/después) del rediseño, contra el STACK REAL
 * local (instancia `fluvia-ci`, no CI). Mismas rutas, mismos anchos, mismos
 * datos de seed. Además de capturar, comprueba en cada pantalla y ancho:
 * sin scroll horizontal y sin error de servidor.
 *
 *   DESIGN_CAPTURE_DIR=<dir>          carpeta de salida (obligatoria)
 *   DESIGN_RECEIPT_PAYMENT=<uuid>     pago con justificante (opcional)
 *   DESIGN_CHECKOUT_PATH=/c/<id>      checkout abierto (opcional)
 *   DESIGN_PLAN_ID=<uuid>             plan de cuotas del comercio (opcional)
 *   DESIGN_REPORT_ID=<uuid>           reporte de liquidación (opcional)
 *   DESIGN_ONLY=gestion               solo las pantallas de gestión/técnicas
 *
 * Capturas SANEADAS: ids, URLs y códigos de pago enmascarados.
 */
const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3342';
const CHECKOUT = process.env.DEMO_CHECKOUT_URL ?? 'http://127.0.0.1:3341';
const PROGRAM = 'e744e6eb-95cf-5762-95a7-268a0917e747';
const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const OUT = process.env.DESIGN_CAPTURE_DIR ?? '';
const RECEIPT = process.env.DESIGN_RECEIPT_PAYMENT;
const CHECKOUT_PATH = process.env.DESIGN_CHECKOUT_PATH;
const WIDTHS = [390, 768, 1440] as const;
const PLAN = process.env.DESIGN_PLAN_ID;
const REPORT = process.env.DESIGN_REPORT_ID;
const ONLY = process.env.DESIGN_ONLY;

test.describe.configure({ mode: 'serial' });
test.skip(!OUT, 'DESIGN_CAPTURE_DIR no definido');

let personal: BrowserContext;
let merchant: BrowserContext;
let p: Page;
let m: Page;

async function sanitize(pg: Page) {
  await pg.evaluate(() => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      n.nodeValue = (n.nodeValue ?? '')
        .replace(uuid, (x) => `••••${x.slice(-4)}`)
        .replace(/fcp_[0-9a-f]{64}/g, 'fcp_••••••••')
        .replace(/https?:\/\/\S+/g, '••••');
    }
  });
}

async function shoot(pg: Page, url: string, name: string) {
  for (const width of WIDTHS) {
    await pg.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    const res = await pg.goto(url);
    expect(res?.status() ?? 0, `${name} @${width}`).toBeLessThan(500);
    await pg.waitForLoadState('networkidle');
    const r = await pg.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(r.sw, `${name} @${width}: scroll horizontal`).toBeLessThanOrEqual(r.cw);
    await sanitize(pg);
    await pg.screenshot({
      path: `${OUT}/${name}-${width}.jpg`,
      fullPage: true,
      type: 'jpeg',
      quality: 72,
    });
  }
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const opts = { locale: 'es-VE', timezoneId: 'America/Caracas' };
  personal = await browser.newContext(opts);
  merchant = await browser.newContext(opts);
  p = await personal.newPage();
  m = await merchant.newPage();
  await p.goto(`${APP}/personal/entrar`);
  await p.getByLabel('Correo').fill('cliente@demo.fluvia.test');
  await p.getByLabel('Contraseña').fill('demo-cliente-password');
  await p.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await p.waitForURL(`${APP}/personal`);
  await m.goto(`${APP}/login`);
  await m.getByLabel('Correo').fill('owner@demo.fluvia.test');
  await m.getByLabel('Contraseña').fill('demo-owner-password');
  await m.locator('form button[type="submit"]').click();
  await m.waitForURL((u) => !u.pathname.startsWith('/login'));
});

test.afterAll(async () => {
  await personal?.close();
  await merchant?.close();
});

test('Comercios · gestión y pantallas técnicas', async () => {
  const o = `${APP}/o/${ORG}`;
  if (RECEIPT) await shoot(m, `${o}/payments/${RECEIPT}`, 'g01-pago-detalle');
  await shoot(m, `${o}/installments`, 'g02-cuotas-comercio');
  if (PLAN) await shoot(m, `${o}/installments/${PLAN}`, 'g03-cuotas-plan');
  await shoot(m, `${o}/reconciliation`, 'g04-conciliacion');
  if (REPORT) await shoot(m, `${o}/reconciliation/${REPORT}`, 'g05-conciliacion-reporte');
  await shoot(m, `${APP}/onboarding?orgId=${ORG}`, 'g06-onboarding');
  const tech: Array<[string, string]> = [
    ['payouts', 't01-payouts'],
    ['checkout-sessions', 't02-sesiones-checkout'],
    ['payment-links', 't03-enlaces-de-pago'],
    ['webhook-events', 't04-eventos-webhook'],
    ['webhook-endpoints', 't05-endpoints-webhook'],
    ['disputes', 't06-disputas'],
    ['api-keys', 't07-api-keys'],
    ['cases', 't08-casos-comercio'],
    ['activity', 't09-operacion-avanzada'],
    ['merchants', 't10-comercios'],
    ['team', 't11-equipo'],
    ['settings', 't12-configuracion'],
  ];
  for (const [r, name] of tech) await shoot(m, `${o}/${r}`, name);
});

test('públicas: entrar (comercio y Personal)', async ({ browser }) => {
  test.skip(ONLY === 'gestion', 'DESIGN_ONLY=gestion');
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await shoot(pg, `${APP}/login`, 'a01-login-comercio');
  await shoot(pg, `${APP}/personal/entrar`, 'a02-personal-entrar');
  await ctx.close();
});

test('Personal', async () => {
  test.skip(ONLY === 'gestion', 'DESIGN_ONLY=gestion');
  await shoot(p, `${APP}/personal`, 'p01-personal-inicio');
  await shoot(p, `${APP}/personal/tarjetas`, 'p02-personal-tarjeta');
  await shoot(p, `${APP}/personal/movimientos`, 'p03-personal-movimientos');
  await shoot(p, `${APP}/personal/movimientos?accion=ingresar`, 'p04-personal-ingresar');
  await shoot(p, `${APP}/personal/cuotas`, 'p05-personal-cuotas');
  await shoot(p, `${APP}/personal/credito`, 'p06-personal-credito');
  await shoot(p, `${APP}/personal/perfil`, 'p07-personal-perfil');
});

test('Comercios', async () => {
  test.skip(ONLY === 'gestion', 'DESIGN_ONLY=gestion');
  const o = `${APP}/o/${ORG}`;
  await shoot(m, o, 'c01-comercio-dashboard');
  await shoot(m, `${o}/pos`, 'c02-comercio-pos');
  await shoot(m, `${o}/sell`, 'c03-comercio-vender');
  await shoot(m, `${o}/catalog`, 'c04-comercio-catalogo');
  await shoot(m, `${o}/orders`, 'c05-comercio-ventas');
  await shoot(m, `${o}/customers`, 'c06-comercio-clientes');
  await shoot(m, `${o}/payments`, 'c07-comercio-pagos');
  await shoot(m, `${o}/refunds`, 'c08-comercio-devoluciones');
  await shoot(m, `${o}/cash`, 'c09-comercio-caja');
  await shoot(m, `${o}/por-confirmar`, 'c10-comercio-por-confirmar');
  if (RECEIPT) await shoot(m, `${o}/pos/receipts/${RECEIPT}`, 'c11-comercio-justificante');
});

test('Operaciones', async () => {
  test.skip(ONLY === 'gestion', 'DESIGN_ONLY=gestion');
  const o = `${APP}/operaciones/${PROGRAM}`;
  await shoot(m, o, 'o01-ops-resumen');
  await shoot(m, `${o}/clientes`, 'o02-ops-clientes');
  await m.goto(`${o}/clientes`);
  const href = await m.locator('a[href*="/clientes/"]').first().getAttribute('href');
  if (href) await shoot(m, `${APP}${href}`, 'o03-ops-cliente-360');
  await shoot(m, `${o}/solicitudes`, 'o04-ops-solicitudes');
  await shoot(m, `${o}/tarjetas`, 'o05-ops-tarjetas');
  await shoot(m, `${o}/transacciones`, 'o06-ops-transacciones');
  await shoot(m, `${o}/casos`, 'o07-ops-casos');
  await shoot(m, `${o}/eventos`, 'o08-ops-eventos');
  await shoot(m, `${o}/politica`, 'o09-ops-politica');
});

test('Checkout', async ({ browser }) => {
  test.skip(ONLY === 'gestion', 'DESIGN_ONLY=gestion');
  test.skip(!CHECKOUT_PATH, 'sin checkout abierto');
  const ctx = await browser.newContext({ locale: 'es-VE' });
  const pg = await ctx.newPage();
  await shoot(pg, `${CHECKOUT}${CHECKOUT_PATH}`, 'k01-checkout');
  await ctx.close();
});
