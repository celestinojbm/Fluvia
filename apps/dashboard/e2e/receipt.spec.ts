import { expect, test, type Page } from '@playwright/test';
import { pdfCompactText } from './pdf-text';

/**
 * E2E de navegador del justificante del POS (CI). Dashboard real (`next start`)
 * + API sintética versionada (`e2e/synthetic-api.mjs`). Rutas esenciales a
 * 390/768/1440 px y con teclado:
 *  - justificante de cobro confirmado, parcial, total, pendiente de verificación;
 *  - más de 100 devoluciones: SIN desglose, ni en pantalla ni en papel;
 *  - impresión: controles ocultos, URL sin ids al imprimir (botón y Ctrl+P),
 *    datos desactualizados NO imprimibles (y en papel solo el aviso);
 *  - sesión caducada, cobro no confirmado;
 *  - acceso desde el terminal y desde «Cobros recientes».
 * En todas: sin scroll horizontal y ningún UUID ni URL en el texto visible.
 *
 * `RECEIPT_EVIDENCE_DIR=<dir>` guarda además las capturas saneadas de
 * docs/product/pos-evidence.
 */

const ORG = 'aaaaaaaa-0000-4000-8000-00000000a001';
const API = 'http://127.0.0.1:3999';
const pi = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cs = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LINK = 'ffffffff-0000-4000-8000-000000000001';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WIDTHS = [390, 768, 1440] as const;
const EVIDENCE = process.env.RECEIPT_EVIDENCE_DIR;
const receiptPath = (n: number) => `/o/${ORG}/pos/receipts/${pi(n)}`;

async function mode(m: 'ok' | 'fail' | 'auth' | 'slow') {
  const r = await fetch(`${API}/__mode?receipt=${m}`);
  expect(r.status).toBe(200);
}

test.beforeEach(async ({ context }) => {
  await mode('ok');
  await context.addCookies([
    { name: 'fluvia_session', value: 'synthetic-session', url: 'http://127.0.0.1:3210' },
  ]);
  // window.print real abriría un diálogo: se registra la URL con la que se llamó.
  await context.addInitScript(() => {
    const w = window as unknown as { __prints: string[] };
    w.__prints = [];
    window.print = () => {
      w.__prints.push(location.href);
    };
  });
});

/** Sin scroll horizontal y sin UUID/URL en el texto visible. */
async function assertClean(page: Page, { ids = true } = {}) {
  const r = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    text: document.body.innerText,
  }));
  expect(r.sw, 'scroll horizontal').toBeLessThanOrEqual(r.cw);
  if (ids) {
    expect(r.text).not.toMatch(UUID);
    expect(r.text).not.toMatch(/https?:\/\//);
  }
}

/** Solo para capturas del terminal/recientes, que ya mostraban ids por diseño. */
async function sanitize(page: Page) {
  await page.evaluate(() => {
    const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      n.nodeValue = (n.nodeValue ?? '')
        .replace(re, (m) => `••••${m.slice(-4)}`)
        .replace(/https?:\/\/\S+/g, '••••');
    }
  });
}

async function shot(page: Page, name: string) {
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage: true });
}

async function openReceipt(page: Page, n: number) {
  await page.goto(receiptPath(n));
  await expect(page.getByTestId('pos-receipt-captured')).toBeVisible();
}

for (const width of WIDTHS) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: width < 500 ? 844 : 900 } });

    test('cobro confirmado con venta: datos, sin ids, no fiscal', async ({ page }) => {
      await openReceipt(page, 1);
      await expect(page.getByTestId('pos-receipt-status')).toHaveText('Cobro confirmado');
      await expect(page.getByTestId('pos-receipt-captured')).toContainText('45,50');
      await expect(page.getByTestId('pos-receipt-concept')).toHaveText(
        'Desayuno para dos (sintético)'
      );
      await expect(page.getByTestId('pos-receipt-ref')).toHaveText('00000001');
      await expect(page.getByTestId('pos-receipt-not-fiscal')).toContainText(
        'No es una factura ni un documento fiscal'
      );
      await expect(page.getByText('Sin devoluciones registradas.')).toBeVisible();
      await assertClean(page);
      await shot(page, `30-justificante-cobro-${width}`);
    });

    test('parcial: devuelto = total de la API; cancelada «no devuelta»', async ({ page }) => {
      await openReceipt(page, 2);
      await expect(page.getByTestId('pos-receipt-status')).toHaveText(
        'Cobro confirmado · devolución parcial'
      );
      await expect(page.getByTestId('pos-receipt-refunded')).toContainText('30,00');
      const items = page.getByTestId('pos-receipt-refund');
      await expect(items).toHaveCount(2);
      await expect(items.nth(0)).toHaveAttribute('data-status', 'canceled');
      await expect(items.nth(0)).toContainText('No devuelta (cancelada)');
      await expect(items.nth(1)).toHaveAttribute('data-status', 'succeeded');
      await expect(page.getByText('NOTA INTERNA')).toHaveCount(0);
      await assertClean(page);
      await shot(page, `31-justificante-parcial-${width}`);
    });

    test('indeterminate: pendiente de verificación, no cuenta como devuelta', async ({ page }) => {
      await openReceipt(page, 4);
      await expect(page.getByTestId('pos-receipt-refund')).toContainText(
        'Pendiente de verificación'
      );
      await expect(page.getByTestId('pos-receipt-uncertain')).toContainText(
        'NO las cuenta como devueltas'
      );
      await expect(page.getByTestId('pos-receipt-refunded')).toContainText('0,00');
      await assertClean(page);
      await shot(page, `33-justificante-pendiente-verificacion-${width}`);
    });

    test('más de 100 devoluciones: sin desglose en pantalla ni en papel', async ({ page }) => {
      await openReceipt(page, 7);
      const note = page.getByTestId('pos-receipt-truncated');
      await expect(note).toContainText('NO incluye el desglose');
      await expect(page.locator('#pos-receipt-title')).toHaveText(
        'Justificante de cobro y devoluciones'
      );
      await expect(page.getByTestId('pos-receipt-refund')).toHaveCount(0);
      await expect(page.getByTestId('pos-receipt-uncertain')).toHaveCount(0);
      await expect(page.getByText('Sin devoluciones registradas.')).toHaveCount(0);
      await expect(page.getByTestId('pos-receipt-refunded')).toContainText('10,00');
      await assertClean(page);
      await shot(page, `42-justificante-mas-de-100-${width}`);
      await page.emulateMedia({ media: 'print' });
      await expect(note).toBeVisible();
      await expect(page.getByTestId('pos-receipt-refund')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Imprimir justificante' })).toBeHidden();
      await shot(page, `43-impresion-mas-de-100-${width}`);
    });

    test('teclado: Actualizar con fallo ⇒ desactualizado, sin imprimir (botón ni Ctrl+P); Reintentar ⇒ imprime sin ids', async ({
      page,
    }) => {
      await openReceipt(page, 4);
      await mode('fail');
      let label = '';
      for (let i = 0; i < 15 && label !== 'Actualizar'; i++) {
        await page.keyboard.press('Tab');
        label = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
      }
      expect(label).toBe('Actualizar');
      await page.keyboard.press('Enter');
      const alert = page.locator('[data-kind="stale"]');
      await expect(alert).toBeFocused();
      await expect(alert).toContainText('puede estar desactualizado');
      await expect(page.getByRole('button', { name: 'Imprimir justificante' })).toBeDisabled();
      await page.keyboard.press('Control+p');
      expect(
        await page.evaluate(() => (window as unknown as { __prints: string[] }).__prints)
      ).toEqual([]);
      await assertClean(page);
      await shot(page, `35-lectura-fallida-desactualizado-${width}`);
      // En papel (menú del navegador) solo sale el aviso de NO válido.
      await page.emulateMedia({ media: 'print' });
      await expect(page.getByTestId('pos-receipt-print-stale')).toBeVisible();
      await expect(page.getByTestId('pos-receipt-captured')).toBeHidden();
      await shot(page, `44-impresion-desactualizado-${width}`);
      await page.emulateMedia({ media: 'screen' });

      await mode('ok');
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Reintentar' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Imprimir justificante' })).toBeEnabled();
      await page.keyboard.press('Control+p');
      const prints = await page.evaluate(
        () => (window as unknown as { __prints: string[] }).__prints
      );
      expect(prints).toHaveLength(1);
      expect(new URL(prints[0]!).pathname).toBe('/');
      expect(page.url()).toContain(`/pos/receipts/${pi(4)}`);
    });

    test('botón Imprimir: URL sin ids durante print(); vista de impresión sin controles', async ({
      page,
    }) => {
      await openReceipt(page, 2);
      await page.getByRole('button', { name: 'Imprimir justificante' }).click();
      const prints = await page.evaluate(
        () => (window as unknown as { __prints: string[] }).__prints
      );
      expect(prints).toHaveLength(1);
      expect(prints[0]).not.toMatch(UUID);
      expect(page.url()).toMatch(UUID);
      await expect(page.getByTestId('pos-receipt-print-hint')).toContainText(
        'la controla el navegador'
      );
      await page.emulateMedia({ media: 'print' });
      for (const sel of ['.no-print', '.dash-head']) {
        for (const el of await page.locator(sel).all()) await expect(el).toBeHidden();
      }
      await assertClean(page);
      await shot(page, `38-impresion-${width}`);
    });
  });
}

for (const width of [390, 1440] as const) {
  test.describe(`estados (${width}px)`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('sesión caducada al actualizar ⇒ datos retirados', async ({ page }) => {
      await openReceipt(page, 2);
      await mode('auth');
      await page.getByRole('button', { name: 'Actualizar' }).click();
      const alert = page.locator('[data-kind="auth"]');
      await expect(alert).toBeFocused();
      await expect(alert.getByRole('link', { name: 'Vuelve a iniciar sesión' })).toHaveAttribute(
        'href',
        '/login'
      );
      await expect(page.getByTestId('pos-receipt-captured')).toHaveCount(0);
      await assertClean(page);
      await shot(page, `36-sesion-caducada-${width}`);
    });

    test('cobro no confirmado ⇒ sin justificante', async ({ page }) => {
      await page.goto(receiptPath(6));
      await expect(page.locator('[data-kind="not_charged"]')).toContainText('no está confirmado');
      await expect(page.getByRole('button', { name: 'Imprimir justificante' })).toHaveCount(0);
      await assertClean(page);
      await shot(page, `37-sin-justificante-no-confirmado-${width}`);
    });

    test('total y en curso', async ({ page }) => {
      await openReceipt(page, 3);
      await expect(page.getByTestId('pos-receipt-status')).toHaveText(
        'Cobro confirmado · devuelto por completo'
      );
      await shot(page, `32-justificante-devuelto-total-${width}`);
      await openReceipt(page, 5);
      await expect(page.getByTestId('pos-receipt-open')).toContainText('Aún no cuentan');
      await shot(page, `34-justificante-devolucion-en-curso-${width}`);
    });

    test('cargando: aria-busy y estado anunciado', async ({ page }) => {
      await mode('slow');
      await page.goto(receiptPath(1));
      const loading = page.getByRole('status').filter({ hasText: 'Cargando justificante' });
      await expect(loading).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(1);
      await assertClean(page);
      await shot(page, `39-cargando-${width}`);
    });
  });
}

test.describe('pie de página impreso (PDF real de Chromium)', () => {
  // Plantillas de Chromium: <span class="url"> = URL del documento al imprimir.
  const pdfOpts = {
    format: 'A4' as const,
    displayHeaderFooter: true,
    headerTemplate: '<div style="font-size:8px"><span class="title"></span></div>',
    footerTemplate: '<div style="font-size:8px"><span class="url"></span></div>',
    margin: { top: '15mm', bottom: '15mm' },
  };

  test('menú del navegador (sin control de la app): el pie lleva ids', async ({ page }) => {
    await openReceipt(page, 2);
    const text = pdfCompactText(await page.pdf(pdfOpts));
    expect(text).toContain('Importecobrado');
    // Chromium toma la URL al INICIAR la impresión, antes de `beforeprint`:
    // cambiarla en ese evento no la saca del pie. Si esto deja de fallar
    // (cambio de Chromium), revisar docs/product/pos-sandbox.md.
    expect(text).toMatch(UUID);
  });

  test('botón / Ctrl+P (URL sustituida ANTES de imprimir): pie sin ids', async ({ page }) => {
    await openReceipt(page, 2);
    // Mismo orden que el botón: hide() y después la impresión.
    await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
    expect(new URL(page.url()).pathname).toBe('/');
    const text = pdfCompactText(await page.pdf(pdfOpts));
    expect(text).toContain('Importecobrado');
    expect(text).toContain('http://127.0.0.1:3210/');
    expect(text).not.toMatch(UUID);
    // `afterprint` (lo dispara Chromium al terminar) restaura la URL.
    await expect(page).toHaveURL(new RegExp(`/pos/receipts/${pi(2)}$`));
    await expect(page.getByTestId('pos-receipt-captured')).toBeVisible();
  });
});

test.describe('acceso', () => {
  for (const width of [390, 1440] as const) {
    test(`terminal (${width}px): «Ver justificante» con teclado abre el justificante`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/o/${ORG}/pos?session=${cs(1)}&link=${LINK}`);
      const link = page.getByTestId('pos-receipt-link');
      await expect(link).toHaveAttribute('href', receiptPath(1));
      await assertClean(page, { ids: false });
      if (EVIDENCE) {
        await link.scrollIntoViewIfNeeded();
        await sanitize(page);
        await shot(page, `40-terminal-ver-justificante-${width}`);
      }
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/pos/receipts/${pi(1)}$`));
      await expect(page.getByTestId('pos-receipt-captured')).toBeVisible();
    });
  }

  test('«Cobros recientes»: justificante solo en cobros confirmados', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/o/${ORG}/pos`);
    const links = page.getByTestId('pos-recent-receipt');
    await expect(links.first()).toBeVisible();
    const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    // 7 cobros sintéticos, 1 rechazado (pi 6) ⇒ 6 justificantes.
    expect(hrefs.sort()).toEqual([1, 2, 3, 4, 5, 7].map(receiptPath).sort());
    await assertClean(page, { ids: false });
    if (EVIDENCE) {
      await sanitize(page);
      await shot(page, '41-cobros-recientes-justificante-1440');
    }
  });
});
