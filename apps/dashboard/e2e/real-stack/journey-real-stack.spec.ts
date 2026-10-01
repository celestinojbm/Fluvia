import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Recorrido DEMO completo contra el STACK REAL del sandbox (local, no CI):
 * PostgreSQL + Redis + API (MockProvider) + checkout + dashboard, seed de demo.
 * Arranque: `scripts/demo/start-local-demo.sh` (o `e2e/real-stack/start.sh`).
 *
 * Escenarios, como un cajero:
 *  1. cobro aprobado — formulario del POS SOLO con teclado (390 px);
 *  2. rechazo con recuperación — el comprador paga con la tarjeta rechazada,
 *     el POS ofrece un checkout nuevo PARA LA MISMA VENTA y se cobra;
 *  3. pago incierto — transferencia asíncrona: «en proceso», el POS NO
 *     ofrece cobrar otra vez (la resolución llega solo por webhook verificado);
 *  4. devolución parcial — desde el terminal, con teclado;
 *  5. justificante — refleja la devolución; y el detalle del pago enlaza al
 *     justificante y de vuelta al POS.
 * En cada pantalla clave: sin scroll horizontal a 390/768/1440 px.
 *
 * Saldo: la devolución consume el saldo `available` que SIEMBRA el seed de
 * demo (releaseSettlement local). Es saldo de DEMO, no una liquidación de
 * producto (ningún camino de producto libera fondos; PEND-007/008 abiertas).
 *
 * `DEMO_EVIDENCE_DIR=<dir>` guarda capturas SANEADAS (ids → ••••1234, URLs
 * fuera) de cada pantalla a los tres anchos.
 */

const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3200';
const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1'; // seed de demo
const EVIDENCE = process.env.DEMO_EVIDENCE_DIR;
const WIDTHS = [390, 768, 1440] as const;

test.describe.configure({ mode: 'serial' });

let ctx: BrowserContext;
let pos: Page;
let approvedPaymentId = '';

async function noHorizontalScroll(page: Page) {
  const r = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(r.sw, 'scroll horizontal').toBeLessThanOrEqual(r.cw);
}

async function sanitize(page: Page) {
  await page.evaluate(() => {
    const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      n.nodeValue = (n.nodeValue ?? '')
        .replace(re, (m) => `••••${m.slice(-4)}`)
        .replace(/https?:\/\/\S+/g, '••••');
    }
    for (const el of Array.from(document.querySelectorAll('input'))) {
      if (/^https?:/.test(el.value)) el.value = '••••';
    }
  });
}

/** Comprueba los tres anchos y, si procede, guarda la captura saneada. */
async function checkScreen(page: Page, name: string) {
  const original = page.viewportSize();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await page.waitForTimeout(150);
    await noHorizontalScroll(page);
    if (EVIDENCE) {
      await sanitize(page);
      await page.screenshot({ path: `${EVIDENCE}/${name}-${width}.png`, fullPage: true });
    }
  }
  if (original) await page.setViewportSize(original);
}

/** Abre el checkout desde el terminal y devuelve la pestaña del comprador. */
async function openBuyer(): Promise<Page> {
  const link = pos.getByRole('link', { name: 'Abrir checkout' });
  await link.focus();
  const [buyer] = await Promise.all([ctx.waitForEvent('page'), pos.keyboard.press('Enter')]);
  await buyer.waitForLoadState();
  return buyer;
}

async function pay(buyer: Page, method: RegExp) {
  await buyer.getByRole('radio', { name: method }).check();
  await buyer.getByRole('button', { name: /^Pagar/ }).click();
}

async function phase(expected: string) {
  await expect(pos.getByTestId('pos-phase')).toHaveAttribute('data-phase', expected, {
    timeout: 30_000,
  });
}

/** Venta nueva desde el formulario del POS, SOLO con teclado. */
async function chargeWithKeyboard(amount: string, concept: string) {
  await pos.getByLabel('Importe', { exact: true }).focus();
  await pos.keyboard.type(amount);
  await pos.keyboard.press('Tab'); // moneda (la del comercio por defecto)
  await expect(pos.getByLabel('Moneda')).toBeFocused();
  await pos.keyboard.press('Tab');
  await expect(pos.getByLabel('Concepto (opcional)')).toBeFocused();
  await pos.keyboard.type(concept);
  await pos.keyboard.press('Enter'); // envía el formulario
  await expect(pos.getByRole('link', { name: 'Abrir checkout' })).toBeVisible({
    timeout: 15_000,
  });
}

async function newSale() {
  const next = pos.getByRole('button', { name: 'Nuevo cobro' });
  if (await next.isVisible()) {
    await next.focus();
    await pos.keyboard.press('Enter');
  }
  await expect(pos.getByLabel('Importe', { exact: true })).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
  ctx = await browser.newContext({
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    viewport: { width: 390, height: 844 },
  });
  pos = await ctx.newPage();
  await pos.goto(`${APP}/login`);
  await pos.getByLabel('Correo').fill('owner@demo.fluvia.test');
  await pos.getByLabel('Contraseña').fill('demo-owner-password');
  await pos.locator('form button[type="submit"]').click();
  await pos.waitForURL((u) => !u.pathname.startsWith('/login'));
});

test.afterAll(async () => {
  await ctx?.close();
});

test('0. inicio → cobrar por la navegación lateral', async () => {
  await pos.goto(`${APP}/o/${ORG}`);
  // La barra del recorrido quedó sustituida por la navegación de la plataforma
  // (en móvil, dentro del cajón «Abrir menú»).
  await pos.getByRole('button', { name: 'Abrir menú' }).click();
  const nav = pos.getByRole('navigation', { name: 'Navegación principal' });
  await expect(nav.getByRole('link', { name: 'Inicio' })).toHaveAttribute('aria-current', 'page');
  await pos.keyboard.press('Escape');
  await checkScreen(pos, '01-panel');
  await pos.getByRole('button', { name: 'Abrir menú' }).click();
  await nav.getByRole('link', { name: 'Cobrar (terminal)' }).focus();
  await pos.keyboard.press('Enter');
  await pos.waitForURL(/\/pos/);
  await pos.getByRole('button', { name: 'Abrir menú' }).click();
  await expect(nav.getByRole('link', { name: 'Cobrar (terminal)' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await pos.keyboard.press('Escape');
  await checkScreen(pos, '02-pos-nueva-venta');
});

test('1. cobro aprobado (teclado a 390 px)', async () => {
  await chargeWithKeyboard('45500', 'Demo · café y pan (sintético)');
  await checkScreen(pos, '03-pos-presentar-checkout');
  const buyer = await openBuyer();
  await buyer.setViewportSize({ width: 390, height: 844 });
  await checkScreen(buyer, '04-checkout-comprador');
  await pay(buyer, /aprobada/);
  await expect(buyer.getByText(/Pago completado/)).toBeVisible({ timeout: 30_000 });
  await checkScreen(buyer, '05-checkout-pagado');
  await buyer.close();
  await phase('succeeded');
  await checkScreen(pos, '06-pos-aprobado');
  const href = await pos.getByTestId('pos-receipt-link').getAttribute('href');
  approvedPaymentId = href!.split('/').pop()!.split('?')[0]!;
});

test('4. devolución parcial desde el terminal (teclado)', async () => {
  await pos.getByRole('button', { name: 'Devolver…' }).focus();
  await pos.keyboard.press('Enter');
  const partial = pos.getByRole('radio', { name: 'Una parte' });
  await partial.focus();
  await pos.keyboard.press('Space');
  await expect(partial).toBeChecked();
  await pos.getByLabel('Importe a devolver').fill('12000');
  await pos.getByRole('button', { name: 'Revisar devolución' }).focus();
  await pos.keyboard.press('Enter');
  const confirm = pos.getByRole('button', { name: /^Devolver / });
  await expect(confirm).toBeVisible();
  await checkScreen(pos, '07-devolucion-confirmar');
  await confirm.focus();
  await pos.keyboard.press('Enter');
  await expect(pos.getByTestId('pos-refund-result')).toHaveAttribute('data-status', 'succeeded', {
    timeout: 30_000,
  });
  await checkScreen(pos, '08-devolucion-parcial-hecha');
});

test('5. justificante y continuidad detalle ↔ POS ↔ justificante', async () => {
  await pos.getByTestId('pos-receipt-link').focus();
  await pos.keyboard.press('Enter');
  await pos.waitForURL(/\/pos\/receipts\//);
  const page = pos;
  await expect(page.getByTestId('pos-receipt-status')).toHaveText(
    'Cobro confirmado · devolución parcial',
    { timeout: 20_000 }
  );
  await expect(page.getByTestId('pos-receipt-refunded')).toContainText('12.000');
  await expect(page.getByTestId('pos-receipt-not-fiscal')).toBeVisible();
  await checkScreen(page, '09-justificante-parcial');

  // Pagos → detalle: estados legibles, justificante y vuelta al POS.
  await page.goto(`${APP}/o/${ORG}/payments/${approvedPaymentId}`);
  await expect(page.getByText('Devuelto en parte').first()).toHaveAttribute(
    'data-status',
    'partially_refunded'
  );
  await expect(page.getByTestId('payment-receipt-link')).toBeVisible();
  await checkScreen(page, '10-detalle-del-pago');
  await page.getByTestId('payment-pos-link').focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/pos\?session=/);
  await expect(page.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'succeeded', {
    timeout: 20_000,
  });
  await pos.goto(`${APP}/o/${ORG}/pos`);
});

test('2. rechazo con recuperación para la MISMA venta', async () => {
  await newSale();
  await chargeWithKeyboard('30000', 'Demo · rechazo y recuperación (sintético)');
  let buyer = await openBuyer();
  await pay(buyer, /rechazada/);
  await expect(buyer.getByText(/rechaz/i).last()).toBeVisible({ timeout: 30_000 });
  await checkScreen(buyer, '11-checkout-rechazado');
  await buyer.close();
  await phase('failed');
  await expect(pos.getByTestId('pos-recovery')).toBeVisible();
  await checkScreen(pos, '12-pos-rechazado-recuperar');
  await pos.getByRole('button', { name: 'Abrir checkout nuevo' }).focus();
  await pos.keyboard.press('Enter');
  buyer = await openBuyer();
  await pay(buyer, /aprobada/);
  await expect(buyer.getByText(/Pago completado/)).toBeVisible({ timeout: 30_000 });
  await buyer.close();
  await phase('succeeded');
  await checkScreen(pos, '13-pos-recuperado-aprobado');
});

test('3. pago incierto: en proceso, sin cobrar otra vez', async () => {
  await newSale();
  await chargeWithKeyboard('18000', 'Demo · transferencia asíncrona (sintético)');
  const buyer = await openBuyer();
  await pay(buyer, /asíncrona/);
  await buyer.waitForTimeout(1500);
  await checkScreen(buyer, '14-checkout-pendiente');
  await buyer.close();
  await phase('processing');
  await expect(pos.getByTestId('pos-processing-block')).toBeVisible();
  await expect(pos.getByRole('button', { name: 'Abrir checkout nuevo' })).toHaveCount(0);
  await checkScreen(pos, '15-pos-pago-en-proceso');
});

test('6. cobros recientes: los cuatro desenlaces, en lenguaje del comercio', async () => {
  await pos.goto(`${APP}/o/${ORG}/pos`);
  const list = pos.locator('.pos-recent-list');
  await expect(list.getByText('Pago en proceso').first()).toBeVisible();
  await expect(list.getByText(/Pago: Devuelto en parte/).first()).toBeVisible();
  // Ningún estado interno crudo a la vista (siguen en data-status/title).
  const text = await list.innerText();
  expect(text).not.toMatch(/\b(succeeded|completed|partially_refunded|processing)\b/);
  await checkScreen(pos, '16-cobros-recientes');
});
