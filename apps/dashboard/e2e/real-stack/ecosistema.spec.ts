import { execFileSync } from 'node:child_process';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Ecosistema Fluvia contra el STACK REAL (API + PostgreSQL + panel + checkout).
 * Requiere `pnpm seed`, `seed:tiendas` y la API con `SANDBOX_SCENARIOS=1`.
 *
 * Los tres usuarios ven el MISMO caso:
 *  1. compra aprobada con confirmación explícita → Personal, Comercio y Operaciones;
 *  2. respuesta perdida: «en confirmación», sin segundo cobro, cerrada solo por
 *     la verificación con la red (desde Comercio);
 *  3. compra en cuotas sandbox con la línea aprobada;
 *  4. devolución que el comercio no puede liquidar: «No procesada», nunca «devuelta»;
 *  5. aislamiento entre clientes y acceso indebido a Operaciones;
 *  6. Operaciones retira una capacidad (Personal deja de ofrecerla) y OTRA
 *     persona la restablece con step-up.
 */
const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3342';
const ADMIN_DB =
  process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/fluvia';
const PROGRAM = 'e744e6eb-95cf-5762-95a7-268a0917e747';
const SHOP_ORG = 'e085a4be-6562-5537-a8a6-e72f6f8aa38b';

test.describe.configure({ mode: 'serial', timeout: 180_000 });
test.use({ locale: 'es-VE', actionTimeout: 15_000, navigationTimeout: 30_000 });

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

let personal: BrowserContext;
let p: Page;
// Una sola sesión por persona del equipo en todo el spec: el login tiene un
// límite antiabuso de 5 intentos por minuto y correo, y no se relaja.
let m: Page;
let owner: Page;
let approvedOrder = '';

async function noOverflow(page: Page) {
  const extra = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(extra, `desborde horizontal en ${page.url()}`).toBeLessThanOrEqual(1);
}

async function staff(browser: Browser, email: string, password: string) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-VE' });
  const m = await c.newPage();
  await m.goto(`${APP}/login`);
  await m.getByLabel('Correo').fill(email);
  await m.getByLabel('Contraseña').fill(password);
  await m.locator('form button[type="submit"]').click();
  await m.waitForURL((u) => !u.pathname.startsWith('/login'));
  return m;
}

/** Del producto al pedido: carrito → revisión (retiro) → pantalla de pago. */
async function orderFromProduct(page: Page, product: RegExp): Promise<string> {
  await page.goto(`${APP}/personal/tiendas/casa-avila`);
  await page.getByRole('link', { name: product }).first().click();
  const variant = page.getByRole('radio', { name: /Arena|Cobalto/ });
  if (await variant.count()) await variant.first().check();
  await page.getByRole('button', { name: 'Añadir al carrito' }).click();
  await expect(page.getByText('Añadido. Puedes seguir comprando en esta tienda.')).toBeVisible();
  await page.goto(`${APP}/personal/carrito/casa-avila?moneda=VES`);
  await page.getByRole('radio', { name: /Retiro en tienda/ }).check();
  await page.getByLabel(/Compartir mi nombre y correo/).check();
  await page.getByRole('button', { name: 'Continuar al pago' }).click();
  await page.waitForURL(/\/pagar$/);
  return page.url().match(/pedidos\/([0-9a-f-]{36})/)![1]!;
}

async function confirmPay(page: Page) {
  await page.getByRole('button', { name: 'Revisar y confirmar' }).click();
  await expect(page.getByRole('heading', { name: 'Confirma el pago' })).toBeVisible();
  await expect(page.getByText(/Sandbox: dinero simulado/)).toBeVisible();
  await page.getByRole('button', { name: /^Confirmar y pagar/ }).click();
  await page.waitForURL(/\/personal\/pedidos\/[0-9a-f-]{36}\?pago=1$/);
}

test.beforeAll(async ({ browser }) => {
  personal = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-VE' });
  p = await personal.newPage();
  await p.goto(`${APP}/personal/entrar`);
  await p.getByLabel('Correo').fill('cliente@demo.fluvia.test');
  await p.getByLabel('Contraseña').fill('demo-cliente-password');
  await p.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await p.waitForURL(`${APP}/personal`);
  m = await staff(browser, 'tiendas@demo.fluvia.test', 'demo-tiendas-password');
  owner = await staff(browser, 'owner@demo.fluvia.test', 'demo-owner-password');
});

test.afterAll(async () => {
  await personal?.close();
  await m?.context().close();
  await owner?.context().close();
});

test('1. Compra aprobada: el mismo caso en Personal, Comercio y Operaciones', async () => {
  approvedOrder = await orderFromProduct(p, /Cucharas de madera/);
  // Los métodos y su disponibilidad los decide el servidor.
  await expect(p.getByRole('radio', { name: /Tarjeta Fluvia · saldo propio/ })).toBeEnabled();
  await noOverflow(p);
  await p.getByRole('radio', { name: /Tarjeta Fluvia · saldo propio/ }).check();
  await confirmPay(p);
  await expect(p.getByText('Pagado', { exact: true })).toBeVisible();
  const panel = p.getByRole('region', { name: 'Pago y devoluciones' });
  await expect(panel).toContainText('Tarjeta Fluvia · saldo propio');
  await expect(panel).toContainText(`Ref. ••••${approvedOrder.slice(-4)}`);
  await noOverflow(p);

  // Actividad: una fila por operación (el pedido; no otra «compra con tarjeta»).
  await p.goto(`${APP}/personal/actividad`);
  await expect(p.locator(`a[href="/personal/pedidos/${approvedOrder}"]`)).toHaveCount(1);
  const authId = sql(
    `SELECT a.id FROM card_authorizations a JOIN payment_attempts t ON a.network_ref = 'acq:' || t.id
       JOIN payment_intents i ON i.id = t.intent_id JOIN commerce_orders o ON o.payment_link_id = i.payment_link_id
      WHERE o.id = :'id'`,
    { id: approvedOrder }
  );
  await expect(p.locator(`a[href="/personal/actividad/compra/${authId}"]`)).toHaveCount(0);

  // Comercio: la venta con comprador, retiro, método e intento aprobado.
  await m.goto(`${APP}/o/${SHOP_ORG}/orders/${approvedOrder}`);
  const op = m.getByRole('region', { name: 'Operación' });
  await expect(op).toContainText('Tienda en línea (Fluvia Tiendas)');
  await expect(op).toContainText('María Pérez');
  await expect(op).toContainText('Tarjeta Fluvia');
  await expect(op.getByText('Aprobado')).toBeVisible();

  // Operaciones: misma operación desde el pedido; emisor capturado.
  const o = owner;
  await o.goto(`${APP}/operaciones/${PROGRAM}/operacion/${approvedOrder}`);
  await expect(o.getByRole('heading', { level: 1 })).toContainText('Casa Ávila');
  await expect(o.getByText(`referencia ••••${approvedOrder.slice(-4)}`)).toBeVisible();
  await expect(o.getByRole('region', { name: /Consulta/ })).toContainText('Capturada');
  await expect(o.getByRole('region', { name: /Decisión ejecutada/ })).toContainText('Confirmado');
  await expect(o.getByRole('table').last()).toContainText('attempt:');
  await expect(o.getByRole('table').last()).toContainText('auth:');
});

test('2. Respuesta perdida: en confirmación, sin segundo cobro; solo la verificación la cierra', async () => {
  const id = await orderFromProduct(p, /escenario de prueba: respuesta perdida/);
  await p.getByRole('radio', { name: /Tarjeta Fluvia · saldo propio/ }).check();
  await confirmPay(p);
  await expect(p.getByText('En confirmación', { exact: true })).toBeVisible();
  await expect(p.getByText('Pago sin confirmar')).toBeVisible();
  await expect(p.getByText(/No pagues de nuevo/).first()).toBeVisible();
  // Volver a «pagar» no ofrece un segundo cobro.
  await p.goto(`${APP}/personal/pedidos/${id}/pagar`);
  await p.waitForURL(`${APP}/personal/pedidos/${id}`);
  const auths = sql(
    `SELECT count(*) FROM card_authorizations a JOIN payment_attempts t ON a.network_ref = 'acq:' || t.id
       JOIN payment_intents i ON i.id = t.intent_id JOIN commerce_orders o ON o.payment_link_id = i.payment_link_id
      WHERE o.id = :'id' AND a.status <> 'declined'`,
    { id }
  );
  expect(auths).toBe('1');
  // Inicio avisa del pago en confirmación.
  await p.goto(`${APP}/personal`);
  await expect(p.getByText(/pago en confirmación|pagos en confirmación/)).toBeVisible();

  // Comercio: incierto con su siguiente paso; «Verificar con la red» aplica la respuesta.
  await m.goto(`${APP}/o/${SHOP_ORG}/orders/${id}`);
  await expect(m.getByText('Desenlace sin verificar')).toBeVisible();
  await expect(m.getByText('Todavía no se ha verificado.')).toBeVisible();
  await m.getByRole('button', { name: 'Verificar con la red' }).click();
  await expect(m.getByText('Cobro: la red lo confirmó (aplicado)')).toBeVisible();
  await m.waitForLoadState('load');
  await m.reload();
  await expect(m.getByText('Desenlace sin verificar')).toHaveCount(0);

  await p.goto(`${APP}/personal/pedidos/${id}`);
  await expect(p.getByText('Pagado', { exact: true })).toBeVisible();
  const log = sql(
    `SELECT v.triggered_by || '|' || v.verdict || '|' || v.applied FROM uncertain_verifications v
       JOIN payment_attempts t ON t.id = v.subject_id JOIN payment_intents i ON i.id = t.intent_id
       JOIN commerce_orders o ON o.payment_link_id = i.payment_link_id WHERE o.id = :'id'`,
    { id }
  );
  expect(log).toBe('merchant_user|approved|true');
});

test('3. Cuotas sandbox con la línea aprobada: el plan y la deuda son del cliente', async () => {
  const id = await orderFromProduct(p, /Taza de cerámica esmaltada/);
  const inst = p.getByRole('radio', { name: /Tarjeta Fluvia · en cuotas/ });
  await expect(inst).toBeEnabled();
  await inst.check();
  await expect(p.getByText('Número de cuotas')).toBeVisible();
  await expect(p.getByText(/Condiciones del programa de PRUEBA/)).toBeVisible();
  await p.getByRole('button', { name: 'Revisar y confirmar' }).click();
  await expect(p.getByText('Con tu crédito (deuda en cuotas)')).toBeVisible();
  await p.getByRole('button', { name: /^Confirmar y pagar/ }).click();
  await p.waitForURL(/\?pago=1$/);
  await expect(p.getByText('Pagado', { exact: true })).toBeVisible();
  const panel = p.getByRole('region', { name: 'Pago y devoluciones' });
  await expect(panel).toContainText(/Tarjeta Fluvia · \d+ cuotas?/);
  await expect(panel).toContainText('Con tu crédito (deuda)');
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
});

test('4. Devolución sin fondos liquidados del comercio: «No procesada», nunca «Devuelta»', async () => {
  await m.goto(`${APP}/o/${SHOP_ORG}/orders/${approvedOrder}`);
  const intent = sql(
    `SELECT i.id FROM payment_intents i JOIN commerce_orders o ON o.payment_link_id = i.payment_link_id
      WHERE o.id = :'id' AND i.status = 'succeeded'`,
    { id: approvedOrder }
  );
  const status = await m.evaluate(
    async ([org, pi]) => {
      const r = await fetch(`/api/orgs/${org}/refunds`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fluvia-csrf': '1',
          'idempotency-key': `e2e-${Date.now()}`,
        },
        body: JSON.stringify({
          payment_intent_id: pi,
          amount: 1000,
          reason: 'Una pieza llegó rota',
        }),
      });
      return r.status;
    },
    [SHOP_ORG, intent] as const
  );
  expect(status).toBe(201);
  await m.reload();
  await expect(
    m.getByRole('region', { name: 'Operación' }).getByText('No procesada (sin fondos liquidados)')
  ).toBeVisible();
  await p.goto(`${APP}/personal/pedidos/${approvedOrder}`);
  const panel = p.getByRole('region', { name: 'Pago y devoluciones' });
  await expect(panel).toContainText('No procesada');
  await expect(panel).not.toContainText('Devuelto (confirmado)');
  await expect(p.getByText('Pagado', { exact: true })).toBeVisible();
});

test('5. Aislamiento entre clientes y acceso indebido a Operaciones', async ({ browser }) => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-VE' });
  const other = await c.newPage();
  await other.goto(`${APP}/personal/entrar?modo=crear`);
  await other.getByLabel('Nombre').fill('Otra Persona E2E');
  await other.getByLabel('Correo').fill(`ajena-${Date.now()}@personal.fluvia.test`);
  await other.getByLabel('Contraseña').fill('una clave larga de prueba');
  await other.getByRole('button', { name: 'Crear cuenta' }).last().click();
  await other.waitForURL(`${APP}/personal`);
  await other.goto(`${APP}/personal/pedidos/${approvedOrder}`);
  await expect(other.getByRole('heading', { name: 'No encontramos esto' })).toBeVisible();
  await c.close();

  await m.goto(`${APP}/operaciones/${PROGRAM}/operacion/${approvedOrder}`);
  await expect(m.getByRole('heading', { name: 'Sin acceso' })).toBeVisible();
  await expect(m.getByText('Casa Ávila · pedido')).toHaveCount(0);
});

test('6. Operaciones retira una capacidad: Personal deja de ofrecerla; otra persona la restablece', async ({
  browser,
}) => {
  const ops = await staff(browser, 'ops@demo.fluvia.test', 'demo-ops-password');
  await ops.goto(`${APP}/operaciones/${PROGRAM}/capacidades`);
  const row = ops
    .getByRole('region', { name: /Venezuela/ })
    .getByRole('row', { name: /Pagar en cuotas Fluvia/ });
  // Una corrida local interrumpida puede dejar la retirada abierta: entonces
  // ya no hay botón «Retirar» y se pasa directamente a comprobarla.
  if (await row.getByRole('button', { name: 'Retirar' }).count()) {
    ops.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: 'Retirar' }).click();
    await row.getByLabel(/Motivo/).fill('Pausa preventiva del financiador (E2E)');
    await row.getByRole('button', { name: 'Confirmar' }).click();
    await expect(ops.getByText(/Retirada\. Personal y Comercio dejan de ofrecerla/)).toBeVisible();
  }
  await expect(row).toContainText('No ofrecido');
  await ops.context().close();

  try {
    const id = await orderFromProduct(p, /Velas de cera de abeja/);
    const inst = p.getByRole('radio', { name: /Tarjeta Fluvia · en cuotas/ });
    await expect(inst).toBeDisabled();
    await expect(p.getByText('No se ofrece en este mercado en este momento.')).toBeVisible();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    // Restablece OTRA persona, con step-up.
    await owner.goto(`${APP}/operaciones/${PROGRAM}/capacidades`);
    const hist = owner.getByRole('region', { name: 'Historial de retiradas' });
    await hist.getByRole('button', { name: 'Restablecer (otra persona)' }).first().click();
    await hist.getByLabel(/Motivo/).fill('Revisado por una segunda persona (E2E)');
    await hist.getByRole('button', { name: 'Confirmar' }).click();
    const pw = owner.locator('#stepup-password');
    const asked = await pw
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (asked) {
      await pw.fill('demo-owner-password');
      await pw.press('Enter');
    }
    await expect(owner.getByText('Restablecida.')).toBeVisible({ timeout: 15_000 });
  }
  await p.reload();
  await expect(p.getByRole('radio', { name: /Tarjeta Fluvia · en cuotas/ })).toBeEnabled();
});

test('7. Texto al 200 % y movimiento reducido: sin desborde en Saldos, pedido y pago', async ({
  browser,
}) => {
  const c = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'es-VE',
    reducedMotion: 'reduce',
    storageState: await personal.storageState(),
  });
  const page = await c.newPage();
  const unpaid = await orderFromProduct(page, /Velas de cera de abeja/);
  for (const path of [
    '/personal/saldos',
    `/personal/pedidos/${approvedOrder}`,
    `/personal/pedidos/${unpaid}/pagar`,
  ]) {
    await page.goto(`${APP}${path}`);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await page.waitForTimeout(200);
    await noOverflow(page);
    const animated = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll<HTMLElement>('*')).filter((el) => {
          const cs = getComputedStyle(el);
          return (
            (cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01) ||
            parseFloat(cs.transitionDuration) > 0.01
          );
        }).length
    );
    expect(animated, `${path}: animaciones con movimiento reducido`).toBe(0);
  }
  await c.close();
});
