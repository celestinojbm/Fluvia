import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Tasas de referencia y moneda de visualización contra el STACK REAL (API +
 * PostgreSQL + panel). La API corre con FX_REFRESH=off: las tasas son FIXTURES
 * (fuente «fixture», rotuladas «Datos de prueba»), con cifras deliberadamente
 * irreales (USD/Bs 500, EUR/Bs 550, USDT/USD 0,998) para que nunca se
 * confundan con una cotización.
 *
 * Comprueba: franja en Personal, Comercio y Operaciones; detalle y
 * calculadora (sentido, intercambio, teclado, foco); cambiar la moneda de
 * visualización (USD · Bs · EUR · USDT) NO cambia el saldo original ni el
 * importe que se cobra; el pedido pagado queda en su moneda y por su total;
 * sin desbordes a 390 y 1440; axe y objetivos ≥ 44 px en la franja.
 *
 * Por seguridad NO corre si la tabla tiene lecturas reales (no borra datos
 * ajenos): úsese contra la base del CI o una base local de pruebas.
 *
 *   ADMIN_DATABASE_URL  sembrar/limpiar las lecturas de prueba
 *   CAPTURE_DIR         si existe, capturas 390/1440 por moneda
 */
const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3342';
const ADMIN_DB =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/fluvia';
const CAPTURE = process.env.CAPTURE_DIR ? resolve(process.env.CAPTURE_DIR) : null;
const PROGRAM = 'e744e6eb-95cf-5762-95a7-268a0917e747';
const MERCHANT_ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.use({ locale: 'es-VE', actionTimeout: 15_000, navigationTimeout: 30_000 });

/** Valores por variables de psql (`:'var'`); la sentencia es un literal fijo. */
const sql = (q: string, vars: Record<string, string> = {}) =>
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

const nbsp = (s: string | null) => (s ?? '').replace(/\u00a0/g, ' ').trim();

let ctx: BrowserContext;
let p: Page;

async function noOverflow(page: Page) {
  const extra = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(extra, `desborde horizontal en ${page.url()}`).toBeLessThanOrEqual(1);
}

async function shot(page: Page, name: string) {
  for (const [w, h] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await noOverflow(page);
    if (CAPTURE) {
      mkdirSync(CAPTURE, { recursive: true });
      await page.screenshot({ path: `${CAPTURE}/${name}-${w}.png`, fullPage: false });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

async function axeStrip(page: Page) {
  await page.addScriptTag({ content: AXE });
  const v = await page.evaluate(async () => {
    // @ts-expect-error axe global inyectado
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    });
    return r.violations
      .filter((x: { impact: string }) => x.impact === 'serious' || x.impact === 'critical')
      .map((x: { id: string; nodes: { target: string[] }[] }) => `${x.id}: ${x.nodes[0]?.target}`);
  });
  expect(v, `axe en ${page.url()}`).toEqual([]);
  const small = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.rt-strip button, .rt-strip select'))
      .filter((el) => el.getBoundingClientRect().height < 43.5)
      .map((el) => el.className)
  );
  expect(small, 'objetivos < 44 px en la franja').toEqual([]);
}

async function setDisplay(page: Page, cur: 'USD' | 'VES' | 'EUR' | 'USDT') {
  // Tras navegar, esperar la hidratación: antes, el <select> aún no es de React.
  await page.waitForLoadState('networkidle');
  await page.locator('.rt-strip select').selectOption(cur);
  await expect(page.locator('.rt-strip select')).toHaveValue(cur);
}

test.beforeAll(async ({ browser }) => {
  const real = sql(`SELECT count(*) FROM fx_rate_readings WHERE source <> 'fixture'`);
  test.skip(real !== '0', 'Hay lecturas reales: esta prueba no borra datos ajenos.');
  sql(`TRUNCATE fx_rate_readings`);
  // Fecha Valor «ayer» en Caracas: aplicable hoy. USDT con hora de fuente actual.
  sql(
    `INSERT INTO fx_rate_readings (source, base, quote, rate, method, value_date, origin) VALUES
       ('fixture', 'USD', 'VES', 500, 'test_fixture', (now() AT TIME ZONE 'America/Caracas')::date - 1, 'e2e:tasas-moneda'),
       ('fixture', 'EUR', 'VES', 550, 'test_fixture', (now() AT TIME ZONE 'America/Caracas')::date - 1, 'e2e:tasas-moneda');
     INSERT INTO fx_rate_readings (source, base, quote, rate, method, source_updated_at, origin) VALUES
       ('fixture', 'USDT', 'USD', 0.998, 'test_fixture', now(), 'e2e:tasas-moneda');`
  );
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
  p = await ctx.newPage();
  await p.goto(`${APP}/personal/entrar`);
  await p.getByLabel('Correo').fill('cliente@demo.fluvia.test');
  await p.getByLabel('Contraseña').fill('demo-cliente-password');
  await p.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await p.waitForURL(`${APP}/personal`);
  // La API guarda la vista 30 s en memoria: espera a que sirva las fixtures.
  await expect
    .poll(
      async () => {
        await p.reload();
        return nbsp(await p.locator('.rt-strip-btn').textContent());
      },
      { timeout: 60_000, intervals: [2_000, 5_000] }
    )
    .toContain('USD 500,00');
});

test.afterAll(async () => {
  await ctx?.close();
  // Solo había fixtures (lo exige el guard de beforeAll).
  sql(`TRUNCATE fx_rate_readings`);
});

test('1. Franja: tasas de prueba rotuladas, detalle y calculadora con teclado', async () => {
  const strip = p.locator('.rt-strip');
  await expect(strip).toContainText('USD 500,00');
  await expect(strip).toContainText('EUR 550,00');
  // 0,998 × 500, referencia cruzada (con «≈»: no es BCV ni cotización directa).
  await expect(strip).toContainText(/USDT\s≈\s?499,00/);
  await expect(strip.locator('.rt-src')).toHaveText('BCV'); // visible desde 481 px
  await expect(strip.locator('.rt-flag-test')).toHaveText('Prueba');

  // Teclado: el botón de la franja abre el detalle; Escape cierra y devuelve el foco.
  await p.locator('.rt-strip-btn').focus();
  await p.keyboard.press('Enter');
  const dlg = p.getByRole('dialog', { name: 'Tasas de referencia' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText('Datos de prueba').first()).toBeVisible();
  await expect(dlg).toContainText('Cotización directa USDT/Bs: no se muestra');
  await expect(dlg).toContainText('No es un precio P2P ni ejecutable');

  const calc = dlg.locator('.rt-calc');
  await calc.getByLabel('Importe').fill('1.234,50');
  await calc.getByLabel('De', { exact: true }).selectOption('USD');
  await calc.getByLabel('A', { exact: true }).selectOption('VES');
  await expect(calc.locator('output')).toHaveText(/^Bs\s617\.250,00$/);
  await expect(calc).toContainText('1 USD = 500,00000000 Bs');
  await calc.getByRole('button', { name: 'Invertir monedas' }).click();
  await expect(calc.locator('output')).toHaveText(/^US\$\s2,47$/); // 1.234,50 / 500
  await calc.getByLabel('A', { exact: true }).selectOption('USDT');
  await calc.getByLabel('Importe').fill('499');
  await calc.getByLabel('De', { exact: true }).selectOption('VES');
  await expect(calc.locator('output')).toHaveText(/^1,00\sUSDT$/);
  await calc.getByRole('button', { name: 'Copiar resultado' }).click();
  await expect(calc.getByRole('button', { name: 'Copiado' })).toBeVisible();
  expect(await p.evaluate(() => navigator.clipboard.readText())).toMatch(/^1,00\sUSDT$/);
  await calc.getByLabel('Importe').fill('12,3,4');
  await expect(calc.getByRole('alert')).toContainText('importe válido');
  if (CAPTURE) {
    mkdirSync(CAPTURE, { recursive: true });
    await p.screenshot({ path: `${CAPTURE}/fixture-detalle-calculadora-390.png` });
  }
  await p.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(p.locator('.rt-strip-btn')).toBeFocused();
  await axeStrip(p);
});

test('2. Cambiar la moneda de visualización no cambia saldos (Inicio)', async () => {
  await p.goto(`${APP}/personal?moneda=VES`);
  const hero = p.locator('.pm-hero');
  // Original: el saldo en bolívares tal como lo da la API (protagonista con Bs).
  await setDisplay(p, 'VES');
  const original = nbsp(await hero.locator('.pm-hero-amount').textContent());
  expect(original).toMatch(/^Bs\s[\d.]+,\d\d$/);
  await expect(hero.locator('.rt-conv-tag')).toHaveCount(0);
  await shot(p, 'fixture-inicio-Bs');

  for (const cur of ['USD', 'EUR', 'USDT'] as const) {
    await setDisplay(p, cur);
    await expect(hero.locator('.rt-conv-tag').first()).toHaveText('Equivalente estimado');
    // El original sigue visible e idéntico debajo.
    await expect(hero.locator('.rt-conv-sub').first()).toContainText(`Saldo original: ${original}`);
    await expect(hero.locator('.rt-conv-sub').first()).toContainText('Datos de prueba');
    await shot(p, `fixture-inicio-${cur}`);
  }
  // Persistencia por dispositivo: recargar conserva la elección (cookie).
  await p.reload();
  await expect(p.locator('.rt-strip select')).toHaveValue('USDT');
  await setDisplay(p, 'VES');
  await expect(hero.locator('.pm-hero-amount')).toHaveText(original.replace(/ /g, '\u00a0'));
  // Garantía y crédito siguen aparte (nunca sumados en una cifra).
  await expect(hero.getByText('Garantía bloqueada')).toBeVisible();
  await expect(hero.getByText('Crédito disponible')).toBeVisible();
});

test('3. Compra: el importe cobrado no cambia con la moneda de visualización', async () => {
  // Pedido de retiro en Casa Ávila (en Bs), pagado con el saldo de la tarjeta.
  // Producto sin límite de existencias: no consume las que usan otras pruebas.
  await p.goto(`${APP}/personal/tiendas/casa-avila`);
  await p
    .getByRole('link', { name: /Cucharas de madera de samán/ })
    .first()
    .click();
  await setDisplay(p, 'USD');
  await expect(p.locator('.pm-pdp-price .rt-eq')).toContainText('equivalente estimado');
  await p.getByRole('button', { name: 'Añadir al carrito' }).click();
  await expect(p.getByText('Añadido. Puedes seguir comprando en esta tienda.')).toBeVisible();
  await p.goto(`${APP}/personal/carrito/casa-avila?moneda=VES`);
  await p.waitForLoadState('networkidle');
  await p.getByRole('radio', { name: /Retiro en tienda/ }).check();
  await p.getByLabel(/Compartir mi nombre y correo/).check();
  await p.getByRole('button', { name: 'Continuar al pago' }).click();
  await p.waitForURL(/\/pagar$/);

  const charge = p.getByTestId('charge-line');
  const charged: string[] = [];
  for (const cur of ['USD', 'VES', 'EUR', 'USDT'] as const) {
    await setDisplay(p, cur);
    charged.push(nbsp(await charge.locator('strong').textContent()));
    await expect(charge).toContainText('en bolívares (Bs)');
  }
  expect(new Set(charged).size, `importe cobrado ${charged.join(' | ')}`).toBe(1);
  expect(charged[0]).toMatch(/^Bs\s[\d.]+,\d\d$/);
  await shot(p, 'fixture-pagar-USDT');

  // Paga con USDT como moneda de visualización: se cobra en Bs, por el total.
  await p.getByRole('radio', { name: /Tarjeta Fluvia · saldo propio/ }).check();
  await p.getByRole('button', { name: 'Revisar y confirmar' }).click();
  // El botón de confirmación dice el importe en Bs, el que se cobra.
  await expect(p.getByRole('button', { name: /^Confirmar y pagar Bs/ })).toBeVisible();
  await p.getByRole('button', { name: /^Confirmar y pagar/ }).click();
  await p.waitForURL(/\/personal\/pedidos\/[0-9a-f-]{36}\?pago=1$/);
  const orderId = p.url().match(/pedidos\/([0-9a-f-]{36})/)![1]!;
  const row = sql(`SELECT o.currency || '|' || o.total FROM commerce_orders o WHERE o.id = :'id'`, {
    id: orderId,
  });
  const minor = charged[0]!.replace(/[^\d]/g, '');
  expect(row).toBe(`VES|${Number(minor)}`);
});

test('4. Comercio y Operaciones: franja compartida y equivalencias sin sumar monedas', async ({
  browser,
}) => {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-VE' });
  const m = await c.newPage();
  await m.goto(`${APP}/login`);
  await m.getByLabel('Correo').fill('owner@demo.fluvia.test');
  await m.getByLabel('Contraseña').fill('demo-owner-password');
  await m.locator('form button[type="submit"]').click();
  await m.waitForURL((u) => !u.pathname.startsWith('/login'));

  await m.goto(`${APP}/operaciones/${PROGRAM}`);
  await expect(m.locator('.rt-strip')).toContainText('USD 500,00');
  await setDisplay(m, 'USD');
  await expect(m.locator('.ox-table .rt-eq').first()).toContainText('≈');
  await axeStrip(m);
  for (const cur of ['USD', 'VES', 'EUR', 'USDT'] as const) {
    await setDisplay(m, cur);
    await shot(m, `fixture-operaciones-${cur}`);
  }

  await m.goto(`${APP}/o/${MERCHANT_ORG}`);
  await expect(m.locator('.rt-strip')).toContainText('USD 500,00');
  await axeStrip(m);
  await shot(m, 'fixture-comercio');
  await c.close();
});
