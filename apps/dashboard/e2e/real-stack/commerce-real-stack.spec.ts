import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Plataforma del comercio contra el STACK REAL del sandbox (local, no CI):
 * PostgreSQL + API (MockProvider + cuotas simuladas) + checkout + dashboard,
 * seed de demo (incluye un catálogo minorista sintético).
 *
 * Recorrido principal, como un comercio:
 *  1. Inicio con indicadores y navegación lateral (teclado: saltar contenido).
 *  2. Catálogo: crear producto, editarlo (versión) y verlo en la búsqueda.
 *  3. Nueva venta: carrito (cantidades, quitar), cliente nuevo, revisar,
 *     registrar → «Cobrar ahora» → terminal con la venta → checkout del
 *     comprador con el RESUMEN de compra → aprobado → venta «Cobrada» →
 *     justificante.
 *  4. Rechazo → la venta sigue pendiente → se recupera en el terminal.
 *  5. Transferencia asíncrona → «Cobro en curso · sin confirmar».
 *  6. Pagar en cuotas (simulación): aceptación explícita, plan aprobado, la
 *     venta NO queda cobrada, la tarjeta queda bloqueada; eventos simulados
 *     de cuota pagada/vencida; consulta del comprador.
 *  7. Caja, clientes, equipo, configuración; rol sin permiso; sesión
 *     caducada; organización ajena; navegación móvil con teclado.
 * En cada pantalla clave: sin scroll horizontal a 390/768/1440 px.
 *
 * `DEMO_EVIDENCE_DIR=<dir>` guarda capturas SANEADAS (ids → ••••1234, URLs
 * fuera, sin secretos) a los tres anchos.
 */

const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3200';
const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1'; // seed de demo
const EVIDENCE = process.env.DEMO_EVIDENCE_DIR;
const WIDTHS = [390, 768, 1440] as const;
const O = `${APP}/o/${ORG}`;

test.describe.configure({ mode: 'serial' });

let ctx: BrowserContext;
let page: Page;
const tag = Date.now().toString(36).slice(-5).toUpperCase();

async function noHorizontalScroll(p: Page) {
  const r = await p.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(r.sw, 'scroll horizontal').toBeLessThanOrEqual(r.cw);
  // Tampoco tablas recortadas dentro de su contenedor (salvo regiones
  // desplazables declaradas, como la matriz de roles).
  const clipped = await p.evaluate(() =>
    Array.from(document.querySelectorAll('.fx-table-wrap:not([role="region"])'))
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.querySelector('caption')?.textContent ?? el.className)
  );
  expect(clipped, 'tabla recortada').toEqual([]);
}

async function sanitize(p: Page) {
  await p.evaluate(() => {
    const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      n.nodeValue = (n.nodeValue ?? '')
        .replace(re, (m) => `••••${m.slice(-4)}`)
        .replace(/https?:\/\/\S+/g, '••••');
    }
  });
}

async function checkScreen(p: Page, name: string) {
  const original = p.viewportSize();
  for (const width of WIDTHS) {
    await p.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await p.waitForTimeout(150);
    await noHorizontalScroll(p);
    if (EVIDENCE) {
      await sanitize(p);
      await p.screenshot({ path: `${EVIDENCE}/${name}-${width}.png`, fullPage: true });
    }
  }
  if (original) await p.setViewportSize(original);
}

async function login(p: Page, email: string, password: string) {
  await p.goto(`${APP}/login`);
  await p.getByLabel('Correo').fill(email);
  await p.getByLabel('Contraseña').fill(password);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
}

/** Arma un carrito en «Nueva venta» y registra la venta; devuelve su número. */
async function createSale(items: Array<[RegExp, number]>): Promise<number> {
  await page.goto(`${O}/sell`);
  for (const [name, times] of items) {
    for (let i = 0; i < times; i++) {
      await page.getByRole('button', { name }).first().click();
    }
  }
  await page.getByRole('button', { name: 'Revisar venta' }).click();
  await page.getByRole('button', { name: 'Confirmar venta' }).click();
  const title = page.getByText(/^Venta #\d+ registrada$/);
  await expect(title).toBeVisible({ timeout: 15_000 });
  return Number((await title.textContent())!.match(/#(\d+)/)![1]);
}

async function openBuyerFromTerminal(): Promise<Page> {
  await page.getByRole('button', { name: 'Abrir checkout del cliente' }).click();
  const link = page.getByRole('link', { name: 'Abrir checkout' });
  await expect(link).toBeVisible({ timeout: 15_000 });
  const [buyer] = await Promise.all([ctx.waitForEvent('page'), link.click()]);
  await buyer.waitForLoadState();
  await buyer.setViewportSize({ width: 390, height: 844 });
  return buyer;
}

async function phase(expected: string) {
  await expect(page.getByTestId('pos-phase')).toHaveAttribute('data-phase', expected, {
    timeout: 30_000,
  });
}

test.beforeAll(async ({ browser }) => {
  if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
  ctx = await browser.newContext({
    locale: 'es-CO',
    timezoneId: 'America/Caracas',
    viewport: { width: 1440, height: 900 },
  });
  page = await ctx.newPage();
  await login(page, 'owner@demo.fluvia.test', 'demo-owner-password');
});

test.afterAll(async () => {
  await ctx?.close();
});

test('1. inicio: navegación lateral, saltar al contenido e indicadores honestos', async () => {
  await page.goto(O);
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await expect(nav.getByRole('link', { name: 'Inicio' })).toHaveAttribute('aria-current', 'page');
  // Teclado: el primer Tab enfoca «Saltar al contenido».
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused();
  // Cada indicador declara su significado y su fuente.
  const confirmed = page.getByRole('region', { name: 'Cobros confirmados' });
  await expect(confirmed).toContainText('NO es saldo disponible');
  await expect(confirmed).toContainText('Fuente:');
  await expect(page.getByRole('region', { name: 'Cuotas aprobadas (simulación)' })).toContainText(
    'no son cobros'
  );
  await checkScreen(page, '01-inicio');
});

test('2. navegación móvil: el cajón se abre y se cierra con teclado', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(O);
  const toggle = page.getByRole('button', { name: 'Abrir menú' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Cerrar menú' })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible();
  if (EVIDENCE) {
    await sanitize(page);
    await page.screenshot({ path: `${EVIDENCE}/02-menu-movil-390.png` });
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Abrir menú' })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('3. catálogo: crear y editar un producto (con versión)', async () => {
  await page.goto(`${O}/catalog`);
  await checkScreen(page, '03-catalogo');
  await page.getByRole('link', { name: 'Nuevo producto' }).click();
  // Validación: sin nombre ni precio no se crea nada.
  await page.getByRole('button', { name: 'Crear producto' }).click();
  await expect(page.getByText('Escribe el nombre del producto.')).toBeVisible();
  await checkScreen(page, '04-producto-validacion');
  await page.getByLabel('Nombre', { exact: true }).fill(`Galletas demo ${tag}`);
  await page.getByLabel('Precio', { exact: true }).fill('3500');
  await page.getByLabel('SKU (opcional)').fill(`GAL-${tag}`);
  await page.getByLabel('Categoría', { exact: true }).selectOption({ label: 'Abarrotes' });
  await page.getByRole('button', { name: 'Crear producto' }).click();
  await page.waitForURL(/\/catalog\/[0-9a-f-]{36}\?created=1/);
  await expect(page.getByText('Producto creado.')).toBeVisible();
  await page.getByLabel('Precio', { exact: true }).fill('3900');
  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(page.getByText(/Cambios guardados \(versión 2\)/)).toBeVisible();
  await checkScreen(page, '05-producto-editado');
  await page.goto(`${O}/catalog?q=GAL-${tag}`);
  await expect(page.getByRole('link', { name: `Galletas demo ${tag}` })).toBeVisible();
  await page.goto(`${O}/catalog?q=no-existe-${tag}`);
  await expect(page.getByText('Sin coincidencias')).toBeVisible();
});

let firstSale = 0;

test('4. nueva venta: carrito, cliente nuevo, revisión y registro', async () => {
  await page.goto(`${O}/sell`);
  await checkScreen(page, '06-venta-vacia');
  await page.getByRole('button', { name: /Añadir Café molido 500 g/ }).click();
  await page.getByRole('button', { name: /Añadir Café molido 500 g/ }).click();
  await page.getByRole('button', { name: /Añadir Arroz 1 kg/ }).click();
  await page.getByRole('button', { name: /Añadir Jabón de manos/ }).click();
  // Quitar una línea y ajustar una cantidad con teclado.
  await page.getByRole('button', { name: 'Quitar Jabón de manos' }).click();
  const arrozQty = page.getByRole('group', { name: 'Cantidad de Arroz 1 kg' });
  await arrozQty.getByRole('button', { name: 'Sumar uno' }).focus();
  await page.keyboard.press('Enter');
  // 2 × 18.500 + 2 × 4.800 = 46.600
  await expect(page.locator('.fx-cart-total output')).toHaveText(/46\.600/);
  // Producto no disponible del seed: no se ofrece.
  await expect(page.getByRole('button', { name: /Añadir Refresco 2 L/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cliente nuevo' }).click();
  await page.getByLabel('Nombre del cliente').fill(`Cliente demo ${tag}`);
  await page.getByRole('button', { name: 'Crear y asignar' }).click();
  await expect(page.getByRole('button', { name: 'Quitar cliente' })).toBeVisible();
  await checkScreen(page, '07-venta-carrito');
  await page.getByRole('button', { name: 'Revisar venta' }).click();
  await expect(page.getByRole('heading', { name: 'Revisar la venta' })).toBeFocused();
  await checkScreen(page, '08-venta-revisar');
  await page.getByRole('button', { name: 'Confirmar venta' }).click();
  const title = page.getByText(/^Venta #\d+ registrada$/);
  await expect(title).toBeVisible({ timeout: 15_000 });
  firstSale = Number((await title.textContent())!.match(/#(\d+)/)![1]);
  await checkScreen(page, '09-venta-registrada');
});

test('5. cobro aprobado: terminal → checkout con resumen → venta cobrada → justificante', async () => {
  await page.getByRole('link', { name: 'Cobrar ahora' }).click();
  await page.waitForURL(/\/pos\?link=/);
  await expect(
    page.getByRole('heading', { name: new RegExp(`Venta #${firstSale}`) })
  ).toBeVisible();
  await expect(page.getByText('Venta lista para cobrar')).toBeVisible();
  await checkScreen(page, '10-terminal-lista');
  const buyer = await openBuyerFromTerminal();
  const summary = buyer.getByRole('region', { name: 'Resumen de tu compra' });
  await expect(summary).toContainText('Café molido 500 g');
  await expect(summary).toContainText('46.600');
  await checkScreen(buyer, '11-checkout-resumen');
  await buyer.getByRole('radio', { name: /aprobada/ }).check();
  await buyer.getByRole('button', { name: /^Pagar/ }).click();
  await expect(buyer.getByText(/Pago completado/)).toBeVisible({ timeout: 30_000 });
  await expect(buyer.getByRole('region', { name: 'Comprobante de compra' })).toBeVisible();
  await checkScreen(buyer, '12-checkout-comprobante');
  await buyer.close();
  await phase('succeeded');
  await checkScreen(page, '13-terminal-aprobado');

  await page.goto(`${O}/orders?q=%23${firstSale}`);
  await expect(page.locator('.fx-status', { hasText: 'Cobrada' }).first()).toBeVisible();
  await page.getByRole('link', { name: `Venta #${firstSale}` }).click();
  await expect(page.getByRole('heading', { name: `Venta #${firstSale}` })).toBeVisible();
  await expect(page.locator('.fx-table tfoot')).toContainText('46.600');
  await checkScreen(page, '14-venta-detalle-cobrada');
  await page.getByRole('link', { name: 'Ver justificante' }).click();
  await expect(page.getByText(/no es una factura/i).first()).toBeVisible();
});

test('6. rechazo: la venta sigue pendiente y se recupera en el terminal', async () => {
  const n = await createSale([[/Añadir Cuaderno 100 hojas/, 1]]);
  await page.getByRole('link', { name: 'Cobrar ahora' }).click();
  const buyer = await openBuyerFromTerminal();
  await buyer.getByRole('radio', { name: /rechazada/ }).check();
  await buyer.getByRole('button', { name: /^Pagar/ }).click();
  await expect(buyer.getByText(/El pago fue rechazado/)).toBeVisible({ timeout: 30_000 });
  await buyer.close();
  await phase('failed');
  await page.goto(`${O}/orders?q=%23${n}`);
  await page.getByRole('link', { name: `Venta #${n}` }).click();
  await expect(page.getByText('El último intento de cobro fue rechazado')).toBeVisible();
  await checkScreen(page, '15-venta-rechazada');
  await page.getByRole('link', { name: 'Cobrar de nuevo' }).click();
  // Sigue el último checkout (rechazado) y ofrece uno nuevo para la MISMA venta.
  await phase('failed');
  const reopen = page.getByRole('button', { name: 'Abrir checkout nuevo' });
  await reopen.click();
  const link = page.getByRole('link', { name: 'Abrir checkout' });
  await expect(link).toBeVisible({ timeout: 15_000 });
  const [buyer2] = await Promise.all([ctx.waitForEvent('page'), link.click()]);
  await buyer2.waitForLoadState();
  await buyer2.getByRole('radio', { name: /aprobada/ }).check();
  await buyer2.getByRole('button', { name: /^Pagar/ }).click();
  await expect(buyer2.getByText(/Pago completado/)).toBeVisible({ timeout: 30_000 });
  await buyer2.close();
  await phase('succeeded');
  await page.goto(`${O}/orders?q=%23${n}`);
  await expect(page.locator('.fx-status', { hasText: 'Cobrada' }).first()).toBeVisible();
});

test('7. transferencia asíncrona: cobro en curso, sin ofrecer cobrar otra vez', async () => {
  const n = await createSale([[/Añadir Bolígrafos x3/, 2]]);
  await page.getByRole('link', { name: 'Cobrar ahora' }).click();
  const buyer = await openBuyerFromTerminal();
  await buyer.getByRole('radio', { name: /Transferencia/ }).check();
  await buyer.getByRole('button', { name: /^Pagar/ }).click();
  await expect(buyer.getByText(/se está procesando/)).toBeVisible({ timeout: 30_000 });
  await buyer.close();
  await phase('processing');
  await page.goto(`${O}/orders?q=%23${n}`);
  await page.getByRole('link', { name: `Venta #${n}` }).click();
  await expect(page.getByText('Cobro en curso o sin confirmar')).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: /^Cobrar/ })).toHaveCount(0);
  await checkScreen(page, '16-venta-cobro-en-curso');
});

test('8. pagar en cuotas (simulación): aceptación explícita y la venta NO queda cobrada', async () => {
  const n = await createSale([
    [/Añadir Detergente 1 kg/, 1],
    [/Añadir Aceite vegetal 1 L/, 1],
  ]);
  await page.getByRole('link', { name: 'Cobrar ahora' }).click();
  const buyer = await openBuyerFromTerminal();
  const inst = buyer.getByRole('region', { name: /Pagar en cuotas/ });
  await expect(inst).toContainText('no hay financiación ni crédito real');
  await inst.getByRole('button', { name: 'Ver opción de cuotas' }).click();
  await inst.getByRole('radio', { name: /3 cuotas/ }).check();
  await expect(inst.getByText('Importe inicial (hoy)')).toBeVisible();
  // 28.200 / 3 = 9.400 exactas.
  await expect(inst.locator('.schedule')).toContainText('9.400');
  await inst.getByRole('button', { name: 'Confirmar plan en cuotas' }).click();
  await expect(inst.getByText('Debes aceptar explícitamente para continuar.')).toBeVisible();
  await checkScreen(buyer, '17-cuotas-eleccion');
  await inst.getByRole('checkbox').check();
  await inst.getByRole('button', { name: 'Confirmar plan en cuotas' }).click();
  const plan = buyer.getByRole('region', { name: 'Tu plan de cuotas (simulación)' });
  await expect(plan).toContainText('Plan aprobado por el proveedor simulado.', { timeout: 15_000 });
  await expect(plan).toContainText('la compra no queda pagada');
  await expect(buyer.getByRole('button', { name: /^Pagar$/ })).toHaveCount(0);
  await checkScreen(buyer, '18-cuotas-aprobado-comprador');
  const planHref = await plan.getByRole('link', { name: 'Consultar mi plan' }).getAttribute('href');

  // El comercio: la venta NO está cobrada; el plan es visible y simulable.
  await page.goto(`${O}/orders?q=%23${n}`);
  await expect(page.locator('.fx-status', { hasText: 'Pendiente de cobro' }).first()).toBeVisible();
  await expect(
    page.locator('.fx-status', { hasText: 'Cuotas · aprobado (simulación)' }).first()
  ).toBeVisible();
  await page.getByRole('link', { name: `Venta #${n}` }).click();
  await expect(page.getByText('Plan de cuotas activo (simulación)')).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: /^Cobrar/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Ver el plan' }).click();
  await checkScreen(page, '19-cuotas-plan-comercio');
  await page.getByRole('button', { name: 'Simular pago de la cuota 1' }).click();
  await expect(page.locator('.fx-status', { hasText: 'Pagada (simulada)' }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Simular cuota 2 vencida' }).click();
  await expect(page.locator('.fx-status', { hasText: 'Vencida (simulada)' }).first()).toBeVisible({
    timeout: 15_000,
  });
  await checkScreen(page, '20-cuotas-cuota-vencida');

  // El comprador consulta su plan con SU secreto (fragmento de la URL).
  const buyerPlan = await ctx.newPage();
  await buyerPlan.setViewportSize({ width: 390, height: 844 });
  await buyerPlan.goto(new URL(planHref!, buyer.url()).toString());
  await expect(buyerPlan.locator('.schedule li[data-status="overdue_simulated"]')).toHaveCount(1);
  await expect(buyerPlan.locator('.schedule li[data-status="paid_simulated"]')).toHaveCount(1);
  await expect(buyerPlan.getByText(/^Cuota vencida \(simulada\)/)).toBeVisible();
  await checkScreen(buyerPlan, '21-cuotas-consulta-comprador');
  await buyerPlan.close();
  await buyer.close();
});

test('9. caja, clientes, equipo y configuración', async () => {
  await page.goto(`${O}/cash`);
  await expect(page.getByText('No es un arqueo')).toBeVisible();
  await expect(page.getByText('Ventas del POS')).toBeVisible();
  await checkScreen(page, '22-caja');
  await page.goto(`${O}/customers?q=${encodeURIComponent(`Cliente demo ${tag}`)}`);
  await page.getByRole('link', { name: `Cliente demo ${tag}` }).click();
  await expect(page.getByRole('link', { name: `Venta #${firstSale}` })).toBeVisible();
  await checkScreen(page, '23-cliente-ficha');
  await page.goto(`${O}/team`);
  await expect(page.getByText('Invitaciones y cambios de rol: aún no disponibles')).toBeVisible();
  await checkScreen(page, '24-equipo');
  await page.goto(`${O}/settings`);
  await expect(page.getByText('No conectados')).toBeVisible();
  await checkScreen(page, '25-configuracion');
  await page.goto(O);
  await expect(page.getByRole('region', { name: 'Cobros confirmados' })).not.toContainText(
    'Sin movimientos'
  );
  await checkScreen(page, '26-inicio-con-actividad');
});

test('10. rol sin permiso, organización ajena y sesión caducada', async ({ browser }) => {
  const dev = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await dev.newPage();
  await login(p, 'dev@demo.fluvia.test', 'demo-dev-password');
  await p.goto(`${O}/sell`);
  await expect(p.getByText(/Tu rol no puede registrar ventas/)).toBeVisible();
  await p.goto(`${O}/catalog`);
  await expect(p.getByRole('link', { name: 'Nuevo producto' })).toHaveCount(0);
  await checkScreen(p, '27-rol-sin-permiso');
  await p.goto(`${APP}/o/00000000-0000-4000-8000-000000000000`);
  await expect(p.getByText('Sin acceso a esta organización')).toBeVisible();
  // Sesión caducada: cookie con un token que el servidor ya no reconoce.
  await dev.addCookies([
    { name: 'fluvia_session', value: 'fluvia_sess_caducada', url: APP, httpOnly: true },
  ]);
  await p.goto(O);
  await expect(p.getByRole('heading', { name: 'Tu sesión caducó' })).toBeVisible();
  await checkScreen(p, '28-sesion-caducada');
  await dev.close();
});
