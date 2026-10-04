import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Capturas comparables (antes/después) de las TRES superficies del ecosistema
 * contra el stack real de una instancia de demo. Mismas rutas, anchos y datos.
 *
 *   DEMO_APP_URL            panel de la instancia
 *   ECO_CAPTURE_DIR         carpeta de salida (obligatoria)
 *   ECO_UNPAID / ECO_PAID   pedidos de `ecosistema-data.mjs`
 *   ECO_AUTH                autorización del pedido pagado (Operaciones)
 *   ECO_ONLY                lista separada por comas de claves de pantalla
 *
 * Cada pantalla se comprueba: sin desborde horizontal, sin error de servidor.
 * Una ruta que no existe en esa versión (404) se registra y no se captura.
 * Capturas SANEADAS: ids, códigos de pago y URLs enmascarados.
 */
const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3342';
const OUT = process.env.ECO_CAPTURE_DIR ?? '';
const UNPAID = process.env.ECO_UNPAID ?? '';
const PAID = process.env.ECO_PAID ?? '';
const AUTH = process.env.ECO_AUTH ?? '';
const ONLY = (process.env.ECO_ONLY ?? '').split(',').filter(Boolean);
const PROGRAM = 'e744e6eb-95cf-5762-95a7-268a0917e747';
const SHOP_ORG = 'e085a4be-6562-5537-a8a6-e72f6f8aa38b';
const WIDTHS = [390, 768, 1440] as const;

test.describe.configure({ mode: 'serial', timeout: 300_000 });
test.skip(!OUT, 'ECO_CAPTURE_DIR no definido');
test.use({ locale: 'es-VE' });

const report: Array<{ key: string; path: string; status: string }> = [];

async function sanitize(pg: Page) {
  await pg.evaluate(() => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      n.nodeValue = (n.nodeValue ?? '')
        .replace(uuid, (x) => `••••${x.slice(-4)}`)
        .replace(/fcp_[0-9a-f]{20,}/g, 'fcp_••••••••')
        .replace(/https?:\/\/\S+/g, '••••');
    }
  });
}

async function capture(pg: Page, key: string, path: string) {
  if (ONLY.length && !ONLY.includes(key)) return;
  const res = await pg.goto(`${APP}${path}`, { waitUntil: 'networkidle' });
  const status = res?.status() ?? 0;
  if (status === 404) {
    report.push({ key, path, status: 'no existe en esta versión' });
    return;
  }
  expect(status, `${path} → ${status}`).toBeLessThan(500);
  mkdirSync(OUT, { recursive: true });
  for (const w of WIDTHS) {
    await pg.setViewportSize({ width: w, height: w === 390 ? 844 : w === 768 ? 1024 : 900 });
    await pg.evaluate(() => window.scrollTo(0, 0));
    await pg.waitForTimeout(300);
    const extra = await pg.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(extra, `desborde horizontal en ${key} a ${w}px`).toBeLessThanOrEqual(1);
    await sanitize(pg);
    await pg.screenshot({ path: `${OUT}/${key}-${w}.png`, fullPage: true });
  }
  report.push({ key, path, status: 'capturada' });
}

async function personal(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-VE' });
  const p = await ctx.newPage();
  await p.goto(`${APP}/personal/entrar`);
  await p.getByLabel('Correo').fill('cliente@demo.fluvia.test');
  await p.getByLabel('Contraseña').fill('demo-cliente-password');
  await p.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await p.waitForURL(`${APP}/personal`);
  return p;
}

async function staff(browser: Browser, email: string, password: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-VE' });
  const m = await ctx.newPage();
  await m.goto(`${APP}/login`);
  await m.getByLabel('Correo').fill(email);
  await m.getByLabel('Contraseña').fill(password);
  await m.locator('form button[type="submit"]').click();
  await m.waitForURL((u) => !u.pathname.startsWith('/login'));
  return m;
}

test('Personal', async ({ browser }) => {
  const p = await personal(browser);
  await capture(p, 'p01-inicio', '/personal');
  await capture(p, 'p02-saldos', '/personal/saldos');
  await capture(p, 'p03-tarjeta', '/personal/tarjetas');
  await capture(p, 'p04-actividad', '/personal/actividad');
  await capture(p, 'p05-credito', '/personal/credito');
  await capture(p, 'p06-cuotas', '/personal/cuotas');
  await capture(p, 'p07-tiendas', '/personal/tiendas');
  await capture(p, 'p08-tienda', '/personal/tiendas/casa-avila');
  if (UNPAID) await capture(p, 'p09-pagar', `/personal/pedidos/${UNPAID}/pagar`);
  if (PAID) await capture(p, 'p10-pedido-pagado', `/personal/pedidos/${PAID}`);
  if (AUTH) await capture(p, 'p11-compra-tarjeta', `/personal/actividad/compra/${AUTH}`);
});

test('Comercio', async ({ browser }) => {
  const m = await staff(browser, 'tiendas@demo.fluvia.test', 'demo-tiendas-password');
  await capture(m, 'c01-inicio', `/o/${SHOP_ORG}`);
  await capture(m, 'c02-tienda-pedidos', `/o/${SHOP_ORG}/tienda`);
  await capture(m, 'c03-pedidos', `/o/${SHOP_ORG}/orders`);
  if (PAID) await capture(m, 'c04-pedido', `/o/${SHOP_ORG}/orders/${PAID}`);
});

test('Operaciones', async ({ browser }) => {
  const o = await staff(browser, 'owner@demo.fluvia.test', 'demo-owner-password');
  await capture(o, 'o01-inicio', `/operaciones/${PROGRAM}`);
  await capture(o, 'o02-transacciones', `/operaciones/${PROGRAM}/transacciones`);
  await capture(o, 'o03-casos', `/operaciones/${PROGRAM}/casos`);
  if (AUTH) await capture(o, 'o04-caso', `/operaciones/${PROGRAM}/operacion/${AUTH}`);
  await capture(o, 'o05-capacidades', `/operaciones/${PROGRAM}/capacidades`);
});

test.afterAll(() => {
  if (OUT) writeFileSync(`${OUT}/informe.json`, JSON.stringify(report, null, 2));
});
