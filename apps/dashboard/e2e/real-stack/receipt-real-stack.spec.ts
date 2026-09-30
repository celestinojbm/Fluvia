import { writeFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Verificación del justificante contra el STACK REAL del sandbox (local, no CI):
 * PostgreSQL + Redis + API (`apps/api/e2e/refund-timeout-server.ts`, MockProvider)
 * + checkout + dashboard, con el seed de demo. Arranque: `e2e/real-stack/start.sh`.
 *
 * Recorrido desde el POS, como un cajero:
 *  (a) venta COP → checkout alojado → el comprador paga (tok_approve) → aprobado;
 *  (b) devolución parcial CONFIRMADA (el MockProvider aprueba);
 *  (c) devolución parcial con timeout del proveedor ⇒ `indeterminate`;
 *  (d) 100 devoluciones más (API real, 1 unidad cada una): la lista supera la
 *      ventana de 100 de la API (las MÁS RECIENTES) y la `indeterminate` de (c)
 *      queda fuera: el justificante no debe mostrar desglose ni en pantalla
 *      ni en papel.
 * Tras cada paso se abre el justificante y su TEXTO se compara con las
 * lecturas REALES de la API (`payment_intents/:id`, `refunds?payment_intent_id=`)
 * hechas con la misma sesión. Nada de stub.
 *
 * COP se muestra con exponente 0 (regla de visualización existente, PEND-008):
 * los dígitos del importe mostrado son las unidades menores de la API.
 */

const APP = 'http://127.0.0.1:3200';
const API = 'http://127.0.0.1:3000';
const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1'; // seed de demo
const FLAG = process.env.FLUVIA_E2E_REFUND_TIMEOUT_FLAG;
const EVIDENCE = process.env.RECEIPT_EVIDENCE_DIR;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test.describe.configure({ mode: 'serial' });

let ctx: BrowserContext;
let pos: Page;
let paymentId = '';
const log: Array<Record<string, unknown>> = [];

const digits = (s: string | null) => Number((s ?? '').replace(/[^\d]/g, ''));

async function apiRead(path: string): Promise<Record<string, unknown>> {
  const cookie = (await ctx.cookies()).find((c) => c.name === 'fluvia_session');
  const res = await fetch(`${API}/v1/organizations/${ORG}${path}`, {
    headers: { authorization: `Bearer ${cookie!.value}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const STATUS_ES: Record<string, string> = {
  succeeded: 'Cobro confirmado',
  partially_refunded: 'Cobro confirmado · devolución parcial',
  refunded: 'Cobro confirmado · devuelto por completo',
};
const REFUND_ES: Record<string, string> = {
  created: 'En curso',
  processing: 'En curso',
  indeterminate: 'Pendiente de verificación',
  succeeded: 'Devuelta',
  failed: 'No devuelta (rechazada)',
  canceled: 'No devuelta (cancelada)',
};

/** Abre el justificante y compara su texto con las lecturas reales de la API. */
async function checkReceipt(step: string) {
  const intent = await apiRead(`/payment_intents/${paymentId}`);
  const list = (await apiRead(`/refunds?payment_intent_id=${paymentId}&limit=100`)) as {
    data: Array<{ amount: number; status: string; created_at: string }>;
  };
  const page = await ctx.newPage();
  await page.goto(`${APP}/o/${ORG}/pos/receipts/${paymentId}`);
  await expect(page.getByTestId('pos-receipt-captured')).toBeVisible();

  const shown = {
    captured: digits(await page.getByTestId('pos-receipt-captured').textContent()),
    refunded: digits(await page.getByTestId('pos-receipt-refunded').textContent()),
    status: (await page.getByTestId('pos-receipt-status').textContent())?.trim(),
    refunds: await page.getByTestId('pos-receipt-refund').evaluateAll((els) =>
      els.map((e) => ({
        status: (e as HTMLElement).dataset.status,
        text: e.textContent ?? '',
        amount: Number(
          (e.querySelector('.pos-refund-amount')?.textContent ?? '').replace(/[^\d]/g, '')
        ),
      }))
    ),
    body: await page.locator('body').innerText(),
  };
  const expected = {
    captured: intent.amount_captured,
    refunded: intent.amount_refunded,
    status: STATUS_ES[String(intent.status)],
    refunds: [...list.data]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((r) => ({ status: r.status, amount: r.amount })),
  };
  expect(shown.captured).toBe(expected.captured);
  expect(shown.refunded).toBe(expected.refunded);
  expect(shown.status).toBe(expected.status);
  expect(shown.refunds.map(({ status, amount }) => ({ status, amount }))).toEqual(expected.refunds);
  for (const r of shown.refunds) expect(r.text).toContain(REFUND_ES[r.status!]);
  expect(shown.body).not.toMatch(UUID);
  expect(shown.body).toContain('No es una factura ni un documento fiscal');
  log.push({ step, api: { ...expected }, receipt: { ...shown, body: undefined } });
  return { page, intent, list, shown };
}

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ locale: 'es-CO', timezoneId: 'America/Bogota' });
  pos = await ctx.newPage();
  await pos.goto(`${APP}/login`);
  await pos.getByLabel('Correo').fill('owner@demo.fluvia.test');
  await pos.getByLabel('Contraseña').fill('demo-owner-password');
  await pos.locator('form button[type="submit"]').click();
  await pos.waitForURL((u) => !u.pathname.startsWith('/login'));
});

test.afterAll(async () => {
  if (EVIDENCE)
    writeFileSync(`${EVIDENCE}/real-stack-comparison.json`, JSON.stringify(log, null, 2));
  await ctx?.close();
});

test('(a) cobro confirmado desde el POS: el justificante coincide con la API', async () => {
  await pos.goto(`${APP}/o/${ORG}/pos`);
  await pos.getByLabel('Importe', { exact: true }).fill('50000');
  await expect(pos.getByLabel('Moneda')).toHaveValue('COP');
  await pos.getByLabel('Concepto (opcional)').fill('Verificación justificante (sintético)');
  await pos.getByRole('button', { name: /^Cobrar / }).click();

  const [buyer] = await Promise.all([
    ctx.waitForEvent('page'),
    pos.getByRole('link', { name: 'Abrir checkout' }).click(),
  ]);
  await buyer.waitForLoadState();
  await buyer.locator('button.pay[type="submit"]').click(); // tok_approve por defecto
  // El desenlace se verifica en el POS (lectura real), no en la pantalla del comprador.
  await expect(pos.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'succeeded', {
    timeout: 30_000,
  });
  await buyer.close();

  await expect(pos.getByTestId('pos-phase')).toHaveAttribute('data-phase', 'succeeded', {
    timeout: 30_000,
  });
  const href = await pos.getByTestId('pos-receipt-link').getAttribute('href');
  paymentId = href!.split('/').pop()!.split('?')[0]!;
  expect(paymentId).toMatch(UUID);

  const { page, intent } = await checkReceipt('a-cobro-confirmado');
  expect(intent.status).toBe('succeeded');
  expect(intent.amount_captured).toBe(50000);
  await expect(page.getByTestId('pos-receipt-concept')).toHaveText(
    'Verificación justificante (sintético)'
  );
  await expect(page.getByText('Sin devoluciones registradas.')).toBeVisible();
  await page.close();
});

async function refundFromPos(amount: string) {
  await pos.bringToFront();
  await pos.getByRole('button', { name: 'Devolver…' }).click();
  await pos.getByRole('radio', { name: 'Una parte' }).check();
  await pos.getByLabel('Importe a devolver').fill(amount);
  await pos.getByRole('button', { name: 'Revisar devolución' }).click();
  await pos.getByRole('button', { name: /^Devolver / }).click();
}

test('(b) devolución parcial confirmada: el justificante la refleja tal cual', async () => {
  await refundFromPos('12000');
  await expect(pos.getByTestId('pos-refund-result')).toHaveAttribute('data-status', 'succeeded', {
    timeout: 30_000,
  });
  const { page, intent, list } = await checkReceipt('b-parcial-confirmada');
  expect(intent.status).toBe('partially_refunded');
  expect(intent.amount_refunded).toBe(12000);
  expect(list.data.map((r) => r.status)).toEqual(['succeeded']);
  await expect(page.getByTestId('pos-receipt-uncertain')).toHaveCount(0);
  if (EVIDENCE) {
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: `${EVIDENCE}/50-real-parcial-confirmada-${width}.png`,
        fullPage: true,
      });
    }
  }
  await page.close();
});

test('(c) devolución indeterminate: pendiente de verificación, no suma como devuelta', async () => {
  test.skip(!FLAG, 'requiere FLUVIA_E2E_REFUND_TIMEOUT_FLAG (mismo valor que la API)');
  // Cierra el resultado anterior antes de registrar otra.
  const close = pos.getByRole('button', { name: 'Cerrar' });
  if (await close.isVisible()) await close.click();
  writeFileSync(FLAG!, 'once');
  await refundFromPos('8000');
  await expect(pos.getByTestId('pos-refund-result')).toHaveAttribute(
    'data-status',
    'indeterminate',
    { timeout: 30_000 }
  );
  const { page, intent, list, shown } = await checkReceipt('c-indeterminate');
  // La API: sigue en 12000 devuelto; la nueva queda indeterminate.
  expect(intent.amount_refunded).toBe(12000);
  expect(list.data.map((r) => r.status).sort()).toEqual(['indeterminate', 'succeeded']);
  expect(shown.refunded).toBe(12000);
  await expect(page.getByTestId('pos-receipt-uncertain')).toContainText(
    'NO las cuenta como devueltas'
  );
  if (EVIDENCE) {
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: `${EVIDENCE}/51-real-indeterminate-${width}.png`,
        fullPage: true,
      });
    }
  }
  await page.close();
});

test('(d) más de 100 devoluciones reales: sin desglose, total de la API', async () => {
  test.skip(!FLAG, 'depende de (c)');
  const cookie = (await ctx.cookies()).find((c) => c.name === 'fluvia_session')!;
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${API}/v1/organizations/${ORG}/refunds`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cookie.value}`,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({ payment_intent_id: paymentId, amount: 1 }),
    });
    expect(res.status).toBe(201);
  }
  const intent = await apiRead(`/payment_intents/${paymentId}`);
  const window100 = (await apiRead(`/refunds?payment_intent_id=${paymentId}&limit=100`)) as {
    data: Array<{ status: string }>;
  };
  // La API real: 100 en la ventana, ninguna es la indeterminate antigua.
  expect(window100.data).toHaveLength(100);
  expect(window100.data.some((r) => r.status === 'indeterminate')).toBe(false);
  expect(intent.amount_refunded).toBe(12000 + 100);

  const page = await ctx.newPage();
  await page.goto(`${APP}/o/${ORG}/pos/receipts/${paymentId}`);
  const note = page.getByTestId('pos-receipt-truncated');
  await expect(note).toContainText('NO incluye el desglose');
  await expect(page.getByTestId('pos-receipt-refund')).toHaveCount(0);
  expect(digits(await page.getByTestId('pos-receipt-refunded').textContent())).toBe(12100);
  expect(await page.locator('body').innerText()).not.toMatch(UUID);
  log.push({
    step: 'd-mas-de-100',
    api: { amount_refunded: intent.amount_refunded, window: window100.data.length },
    receipt: { breakdownItems: 0, truncatedNote: true },
  });
  if (EVIDENCE) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: `${EVIDENCE}/52-real-mas-de-100-${width}.png`,
        fullPage: true,
      });
    }
  }
  await page.emulateMedia({ media: 'print' });
  await expect(note).toBeVisible();
  await expect(page.getByTestId('pos-receipt-refund')).toHaveCount(0);
  if (EVIDENCE) {
    await page.screenshot({
      path: `${EVIDENCE}/53-real-impresion-mas-de-100-1440.png`,
      fullPage: true,
    });
  }
  await page.close();
});
