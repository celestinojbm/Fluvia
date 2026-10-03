import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Jornada integral contra el STACK REAL (local, no CI): PostgreSQL, API,
 * worker, checkout y dashboard con el seed de demo (programa Fluvia Personal
 * sintético, proveedores simulados).
 *
 * Recorrido en navegador por las TRES superficies:
 *  Personal: entrar → inicio (saldo propio / garantía / crédito separados) →
 *  ingresar fondos → Operaciones confirma con el «banco» simulado → código de
 *  pago en cuotas con oferta aceptada → checkout del COMERCIO con «Fluvia
 *  Personal» → cuotas y pago de cuota → Operaciones: ficha 360, bloqueo con
 *  step-up → Personal ve la tarjeta bloqueada por Fluvia → comercio «Por
 *  confirmar». Además: cuenta nueva (estados vacíos), sesión caducada y
 *  teclado. En cada pantalla clave: sin scroll horizontal a 390/768/1440.
 *
 * `DEMO_EVIDENCE_DIR=<dir>` guarda capturas SANEADAS (ids, URLs y códigos de
 * pago enmascarados).
 */
const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3342';
const API = process.env.DEMO_API_URL ?? 'http://127.0.0.1:3340';
const CHECKOUT = process.env.DEMO_CHECKOUT_URL ?? 'http://127.0.0.1:3341';
const PROGRAM = 'e744e6eb-95cf-5762-95a7-268a0917e747';
const MERCHANT_ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const MERCHANT = process.env.DEMO_MERCHANT_ID ?? '';
const EVIDENCE = process.env.DEMO_EVIDENCE_DIR;
const WIDTHS = [390, 768, 1440] as const;
const OPS = `${APP}/operaciones/${PROGRAM}`;

test.describe.configure({ mode: 'serial' });

let personal: BrowserContext;
let ops: BrowserContext;
let p: Page;
let o: Page;
let paymentCode = '';

async function noHorizontalScroll(pg: Page) {
  const r = await pg.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(r.sw, 'scroll horizontal').toBeLessThanOrEqual(r.cw);
}

async function sanitize(pg: Page) {
  await pg.evaluate(() => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      n.nodeValue = (n.nodeValue ?? '')
        .replace(uuid, (m) => `••••${m.slice(-4)}`)
        .replace(/fcp_[0-9a-f]{64}/g, 'fcp_••••••••')
        .replace(/https?:\/\/\S+/g, '••••');
    }
    for (const el of Array.from(document.querySelectorAll('input'))) {
      if (/^fcp_/.test(el.value)) el.value = 'fcp_••••••••';
    }
  });
}

async function checkScreen(pg: Page, name: string) {
  const original = pg.viewportSize();
  for (const width of WIDTHS) {
    await pg.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await pg.waitForTimeout(200);
    await noHorizontalScroll(pg);
    if (EVIDENCE) {
      await sanitize(pg);
      await pg.evaluate(() => window.scrollTo(0, 0));
      await pg.screenshot({ path: `${EVIDENCE}/${name}-${width}.png`, fullPage: true });
    }
  }
  if (original) await pg.setViewportSize(original);
}

async function personalLogin(pg: Page, email: string, password: string) {
  await pg.goto(`${APP}/personal/entrar`);
  await pg.getByLabel('Correo').fill(email);
  await pg.getByLabel('Contraseña').fill(password);
  await pg.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await pg.waitForURL(`${APP}/personal`);
}

async function opsLogin(pg: Page, email: string, password: string) {
  await pg.goto(`${APP}/login`);
  await pg.getByLabel('Correo').fill(email);
  await pg.getByLabel('Contraseña').fill(password);
  await pg.locator('form button[type="submit"]').click();
  await pg.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test.beforeAll(async ({ browser }) => {
  if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
  const opts = {
    locale: 'es-VE',
    timezoneId: 'America/Caracas',
    viewport: { width: 1440, height: 900 },
  };
  personal = await browser.newContext(opts);
  ops = await browser.newContext(opts);
  p = await personal.newPage();
  o = await ops.newPage();
  await personalLogin(p, 'cliente@demo.fluvia.test', 'demo-cliente-password');
  await opsLogin(o, 'owner@demo.fluvia.test', 'demo-owner-password');
});

test.afterAll(async () => {
  await personal?.close();
  await ops?.close();
});

test('1. Personal · inicio separa saldo propio, garantía y crédito; teclado', async () => {
  // Inicio rediseñado (jornada Personal móvil): tres cifras SEPARADAS, nunca sumadas.
  const own = p.getByRole('region', { name: 'Saldo propio disponible' });
  await expect(own).toBeVisible();
  await expect(own.getByText('Garantía bloqueada')).toBeVisible();
  await expect(own.getByText('Crédito disponible')).toBeVisible();
  await expect(p.getByText('El crédito no es saldo propio', { exact: false })).toBeVisible();
  // Teclado: el primer Tab llega a «Saltar al contenido».
  await p.keyboard.press('Tab');
  await expect(p.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused();
  await checkScreen(p, '10-personal-inicio');
});

test('2. Personal · ingreso: instrucción pendiente hasta que el banco (simulado) confirma', async () => {
  await p.goto(`${APP}/personal/movimientos?accion=ingresar`);
  await p.getByLabel('Importe en Bs').fill('1500,00');
  await p.getByRole('button', { name: 'Crear instrucción de ingreso' }).click();
  await expect(p.getByText(/Instrucción creada\. Referencia/)).toBeVisible();
  await p.waitForTimeout(1800);
  await expect(p.getByRole('heading', { name: 'Ingresos por confirmar' })).toBeVisible();
  await checkScreen(p, '11-personal-movimientos');

  // Operaciones: ficha 360 del cliente → simular confirmación del banco.
  await o.goto(`${OPS}/clientes?q=cliente@demo`);
  await o.getByRole('link', { name: /María Pérez/ }).click();
  await expect(o.getByRole('heading', { name: /María Pérez/ })).toBeVisible();
  await o.getByRole('button', { name: 'Simular confirmación del banco' }).first().click();
  await o.getByRole('button', { name: 'Confirmar' }).click();
  await expect(o.getByText('Evento del banco simulado e ingerido.')).toBeVisible();
  await p.reload();
  await expect(p.getByRole('heading', { name: 'Ingresos por confirmar' })).toHaveCount(0);
});

test('3. Personal · crédito y garantía explicados', async () => {
  await p.goto(`${APP}/personal/credito`);
  await expect(p.getByRole('heading', { name: 'Tu crédito' })).toBeVisible();
  await expect(p.getByText(/Pendiente de validación comercial/)).toBeVisible();
  await expect(p.getByText('Puedes liberar', { exact: true })).toBeVisible();
  await checkScreen(p, '12-personal-credito');
});

test('4. Personal · código de pago en cuotas con oferta aceptada', async () => {
  await p.goto(`${APP}/personal/tarjetas?accion=pagar`);
  await expect(p.getByText(/•••• •••• •••• \d{4}/)).toBeVisible();
  await p.getByRole('button', { name: 'En cuotas' }).click();
  await p.getByLabel('Número de cuotas').selectOption('3');
  await p.getByLabel(/Importe aproximado/).fill('800,00');
  await p.getByRole('button', { name: 'Ver calendario' }).click();
  await expect(p.getByText(/Inicial con tu saldo/)).toBeVisible();
  const generate = p.getByRole('button', { name: 'Generar código de pago' });
  await expect(generate).toBeDisabled();
  await p.getByLabel(/Acepto pagar la inicial/).check();
  await generate.click();
  paymentCode = (await p.getByTestId('payment-code').textContent())!.trim();
  expect(paymentCode).toMatch(/^fcp_[0-9a-f]{64}$/);
  await checkScreen(p, '13-personal-tarjeta-codigo');
});

test('5. Comercio · checkout con «Fluvia Personal» cobra la compra', async ({ request }) => {
  // Venta del comercio por su API (sesión del dueño) → sesión de checkout.
  // Sesión del dueño del comercio ya abierta en el contexto de operación.
  const token = (await ops.cookies()).find((c) => c.name === 'fluvia_session')!.value;
  const merchants = await request.get(`${API}/v1/organizations/${MERCHANT_ORG}/merchants`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const merchantId =
    MERCHANT ||
    (await merchants.json()).merchants?.[0]?.id ||
    (await merchants.json()).data?.[0]?.id;
  const link = await request.post(`${API}/v1/organizations/${MERCHANT_ORG}/payment_links`, {
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': `e2e-${Date.now()}` },
    data: {
      merchant_id: merchantId,
      amount: 80000,
      currency: 'VES',
      description: 'Compra en cuotas (E2E)',
      single_charge: true,
    },
  });
  expect(link.status()).toBe(201);
  const session = await request.post(`${API}/v1/payment_links/${(await link.json()).id}/sessions`);
  const s = await session.json();
  const buyer = await personal.newPage();
  await buyer.setViewportSize({ width: 390, height: 844 });
  await buyer.goto(`${CHECKOUT}/c/${s.checkout_session_id}#${encodeURIComponent(s.client_secret)}`);
  await buyer.getByLabel('Fluvia Personal (saldo o cuotas)').check();
  await buyer.getByLabel('Código de pago de Fluvia Personal').fill(paymentCode);
  if (EVIDENCE) {
    for (const width of WIDTHS) {
      await buyer.setViewportSize({ width, height: width < 500 ? 844 : 900 });
      await noHorizontalScroll(buyer);
      await sanitize(buyer);
      await buyer.screenshot({
        path: `${EVIDENCE}/14-checkout-fluvia-personal-${width}.png`,
        fullPage: true,
      });
    }
    await buyer.getByLabel('Código de pago de Fluvia Personal').fill(paymentCode);
  }
  await buyer.locator('button.pay').click();
  await expect(buyer.getByText(/aprobado|completad|pagad|exitos/i).first()).toBeVisible({
    timeout: 20_000,
  });
  await buyer.close();
});

test('6. Personal · cuotas: plan del comercio y pago de una cuota', async () => {
  await p.goto(`${APP}/personal/cuotas`);
  await expect(p.getByRole('heading', { name: 'Planes en curso' })).toBeVisible();
  await expect(p.getByRole('heading', { name: 'Demo Store' }).first()).toBeVisible();
  await checkScreen(p, '15-personal-cuotas');
  await p.getByLabel('Importe a pagar con tu saldo').fill('200,00');
  await p.getByRole('button', { name: 'Pagar cuotas' }).click();
  await expect(p.getByText(/Pago aplicado a tus cuotas/)).toBeVisible();
});

test('7. Operaciones · resumen, 360 y bloqueo de tarjeta con step-up', async () => {
  await o.goto(OPS);
  await expect(o.getByRole('heading', { name: 'Fluvia Personal' })).toBeVisible();
  await expect(o.getByText('Dinero y riesgo por moneda (ledger)')).toBeVisible();
  await checkScreen(o, '20-ops-resumen');
  await o.goto(`${OPS}/clientes?q=cliente@demo`);
  await checkScreen(o, '21-ops-clientes');
  await o.getByRole('link', { name: /María Pérez/ }).click();
  await checkScreen(o, '22-ops-cliente-360');
  await o.getByRole('button', { name: 'Bloquear' }).first().click();
  await o.getByLabel('Motivo (queda en la auditoría)').fill('Revisión preventiva (E2E)');
  await o.getByRole('button', { name: 'Confirmar' }).click();
  // El servidor exige step-up: el modal pide la contraseña y reintenta.
  const dialog = o.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/contraseña/i).fill('demo-owner-password');
  await dialog.locator('button[type="submit"]').click();
  await expect(o.getByText('Tarjeta bloqueada.')).toBeVisible({ timeout: 15_000 });
});

test('8. Personal · ve la tarjeta bloqueada por Fluvia y no puede desbloquearla', async () => {
  await p.goto(`${APP}/personal/tarjetas`);
  await expect(p.getByText('Bloqueada por Fluvia: escribe a soporte.')).toBeVisible();
  await expect(p.getByRole('button', { name: 'Desbloquear' })).toHaveCount(0);
});

test('9. Operaciones · casos, eventos, transacciones y política', async () => {
  for (const [path, name] of [
    ['casos', '23-ops-casos'],
    ['eventos', '24-ops-eventos'],
    ['transacciones', '25-ops-transacciones'],
    ['politica', '26-ops-politica'],
    ['solicitudes?estado=todas', '27-ops-solicitudes'],
    ['tarjetas', '28-ops-tarjetas'],
  ] as const) {
    await o.goto(`${OPS}/${path}`);
    await expect(o.locator('main h1')).toBeVisible();
    await checkScreen(o, name);
  }
  await o.goto(`${OPS}/eventos`);
  await o.getByRole('button', { name: 'Conciliar ahora' }).click();
  await o.getByRole('button', { name: 'Confirmar' }).click();
  await expect(o.getByText(/Conciliación ejecutada/)).toBeVisible();
});

test('10. Comercio · «Por confirmar» explica los inciertos', async () => {
  await o.goto(`${APP}/o/${MERCHANT_ORG}/por-confirmar`);
  await expect(o.getByRole('heading', { name: 'Por confirmar' })).toBeVisible();
  await checkScreen(o, '30-comercio-por-confirmar');
});

test('11. Personal · cuenta nueva con estados vacíos y sesión caducada', async ({ browser }) => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await c.newPage();
  await pg.goto(`${APP}/personal/entrar?modo=crear`);
  await pg.getByLabel('Nombre').fill('Cliente nuevo E2E');
  await pg.getByLabel('Correo').fill(`e2e-${Date.now()}@personal.fluvia.test`);
  await pg.getByLabel('Contraseña').fill('una clave larga de prueba');
  await pg.getByRole('button', { name: 'Crear cuenta' }).last().click();
  await pg.waitForURL(`${APP}/personal`);
  await expect(pg.getByText('Sin cuotas pendientes')).toBeVisible();
  await expect(pg.getByText('Pide tu tarjeta', { exact: true })).toBeVisible();
  await checkScreen(pg, '16-personal-cuenta-nueva');
  // Sesión caducada/revocada: pantalla propia.
  await c.addCookies([{ name: 'fluvia_personal', value: 'fluvia_csess_revocada', url: APP }]);
  await pg.goto(`${APP}/personal`);
  await expect(pg.getByRole('heading', { name: 'Tu sesión caducó' })).toBeVisible();
  await checkScreen(pg, '17-personal-sesion-caducada');
  await c.close();
});

test('12. Operaciones · desbloquea la tarjeta (deja el demo re-ejecutable)', async () => {
  await o.goto(`${OPS}/tarjetas?estado=blocked`);
  await o.getByRole('button', { name: 'Desbloquear' }).first().click();
  await o.getByLabel('Motivo (queda en la auditoría)').fill('Revisión terminada (E2E)');
  await o.getByRole('button', { name: 'Confirmar' }).click();
  const dialog = o.getByRole('dialog');
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByLabel(/contraseña/i).fill('demo-owner-password');
    await dialog.locator('button[type="submit"]').click();
  }
  await expect(o.getByText('Desbloqueada.')).toBeVisible({ timeout: 15_000 });
});
