import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Auditoría del rediseño «Menta» contra el STACK REAL local (instancia
 * `fluvia-ci`, no CI). En cada pantalla rediseñada, a 390 y 1440 px:
 *  - axe-core (WCAG 2.x A/AA, incluido contraste de color) sin infracciones
 *    graves o críticas;
 *  - controles (botones, campos, selectores) con objetivo táctil ≥ 44 px de
 *    alto (enlaces de texto en línea exentos, WCAG 2.5.8);
 *  - foco visible: el primer Tab llega a «Saltar al contenido» o a un control
 *    con contorno.
 */
const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3342';
const CHECKOUT = process.env.DEMO_CHECKOUT_URL ?? 'http://127.0.0.1:3341';
const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const PROGRAM = 'e744e6eb-95cf-5762-95a7-268a0917e747';
const CHECKOUT_PATH = process.env.DESIGN_CHECKOUT_PATH;
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

test.describe.configure({ mode: 'serial' });

async function audit(pg: Page, url: string) {
  for (const width of [390, 1440]) {
    await pg.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await pg.goto(url);
    await pg.waitForLoadState('networkidle');
    await pg.addScriptTag({ content: AXE });
    const result = await pg.evaluate(async () => {
      // @ts-expect-error axe global inyectado
      const r = await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      });
      return r.violations
        .filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical')
        .map(
          (v: { id: string; nodes: { target: string[] }[] }) =>
            `${v.id}: ${v.nodes
              .slice(0, 3)
              .map((n) => n.target.join(' '))
              .join(' | ')}`
        );
    });
    expect(result, `${url} @${width}`).toEqual([]);

    const small = await pg.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select, [role=button]'
        )
      )
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && r.height < 43.5;
        })
        .map(
          (el) =>
            `${el.tagName.toLowerCase()}«${(el.textContent || el.getAttribute('aria-label') || el.getAttribute('name') || '').trim().slice(0, 30)}» ${Math.round(el.getBoundingClientRect().height)}px`
        )
    );
    expect(small, `${url} @${width}: objetivos < 44 px`).toEqual([]);
  }
  await pg.keyboard.press('Tab');
  const focus = await pg.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return {
      text: el.textContent?.trim().slice(0, 40),
      outline: cs.outlineStyle,
      width: cs.outlineWidth,
    };
  });
  expect(focus, `${url}: primer Tab`).not.toBeNull();
  expect(focus!.outline, `${url}: foco visible`).not.toBe('none');
}

test('Personal', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'es-VE' });
  const p = await ctx.newPage();
  await audit(p, `${APP}/personal/entrar`);
  await p.getByLabel('Correo').fill('cliente@demo.fluvia.test');
  await p.getByLabel('Contraseña').fill('demo-cliente-password');
  await p.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await p.waitForURL(`${APP}/personal`);
  for (const r of ['', '/tarjetas', '/movimientos', '/cuotas', '/credito', '/perfil']) {
    await audit(p, `${APP}/personal${r}`);
  }
  await ctx.close();
});

test('Comercios y Operaciones', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'es-VE' });
  const p = await ctx.newPage();
  await audit(p, `${APP}/login`);
  await p.getByLabel('Correo').fill('owner@demo.fluvia.test');
  await p.getByLabel('Contraseña').fill('demo-owner-password');
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  const o = `${APP}/o/${ORG}`;
  for (const r of [
    '',
    '/pos',
    '/sell',
    '/catalog',
    '/orders',
    '/customers',
    '/cash',
    '/refunds',
    '/por-confirmar',
  ]) {
    await audit(p, `${o}${r}`);
  }
  const ops = `${APP}/operaciones/${PROGRAM}`;
  for (const r of [
    '',
    '/clientes',
    '/solicitudes',
    '/tarjetas',
    '/transacciones',
    '/casos',
    '/eventos',
    '/politica',
  ]) {
    await audit(p, `${ops}${r}`);
  }
  await ctx.close();
});

test('Comercios · gestión y técnicas', async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ locale: 'es-VE' });
  const p = await ctx.newPage();
  await p.goto(`${APP}/login`);
  await p.getByLabel('Correo').fill('owner@demo.fluvia.test');
  await p.getByLabel('Contraseña').fill('demo-owner-password');
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  const o = `${APP}/o/${ORG}`;
  const extra = [
    process.env.DESIGN_RECEIPT_PAYMENT ? `/payments/${process.env.DESIGN_RECEIPT_PAYMENT}` : null,
    '/payments',
    '/installments',
    process.env.DESIGN_PLAN_ID ? `/installments/${process.env.DESIGN_PLAN_ID}` : null,
    '/reconciliation',
    process.env.DESIGN_REPORT_ID ? `/reconciliation/${process.env.DESIGN_REPORT_ID}` : null,
    '/payouts',
    '/checkout-sessions',
    '/payment-links',
    '/webhook-events',
    '/webhook-endpoints',
    '/disputes',
    '/api-keys',
    '/cases',
    '/activity',
    '/merchants',
    '/team',
    '/settings',
  ].filter((r): r is string => r !== null);
  for (const r of extra) await audit(p, `${o}${r}`);
  await audit(p, `${APP}/onboarding?orgId=${ORG}`);
  await ctx.close();
});

test('Checkout', async ({ browser }) => {
  test.skip(!CHECKOUT_PATH, 'sin checkout abierto');
  const ctx = await browser.newContext({ locale: 'es-VE' });
  await audit(await ctx.newPage(), `${CHECKOUT}${CHECKOUT_PATH}`);
  await ctx.close();
});

test('Presentación pública', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ locale: 'es-VE' });
  const p = await ctx.newPage();
  for (const r of [
    '/',
    '/donde-comprar',
    '/donde-comprar?categoria=moda',
    '/donde-comprar/bodega-demo',
    '/conoce/billetera',
    '/conoce/tarjeta',
    '/conoce/cuotas',
    '/como-funciona',
    '/comercios',
    '/ayuda',
    '/creditos',
  ]) {
    await audit(p, `${APP}${r}`);
  }
  await ctx.close();
});

test('Asistente abierto (Personal y Comercio) y directorio del comercio', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ locale: 'es-VE' });
  const p = await ctx.newPage();
  await p.goto(`${APP}/personal/entrar`);
  await p.getByLabel('Correo').fill('cliente@demo.fluvia.test');
  await p.getByLabel('Contraseña').fill('demo-cliente-password');
  await p.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await p.waitForURL(`${APP}/personal`);
  await p.goto(`${APP}/login`);
  await p.getByLabel('Correo').fill('owner@demo.fluvia.test');
  await p.getByLabel('Contraseña').fill('demo-owner-password');
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  await audit(p, `${APP}/o/${ORG}/directorio`);
  for (const [url, width] of [
    [`${APP}/personal`, 390],
    [`${APP}/personal`, 1440],
    [`${APP}/o/${ORG}`, 390],
    [`${APP}/o/${ORG}`, 1440],
  ] as const) {
    await p.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await p.goto(url);
    await p
      .getByRole('button', { name: 'Pregunta a Fluvia' })
      .filter({ visible: true })
      .first()
      .click();
    await p.getByRole('dialog').waitFor();
    await p.waitForTimeout(400);
    await p.addScriptTag({ content: AXE });
    const v = await p.evaluate(async () => {
      // @ts-expect-error axe global inyectado
      const r = await window.axe.run(document.querySelector('[role=dialog]'), {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      });
      return r.violations
        .filter((x: { impact: string }) => x.impact === 'serious' || x.impact === 'critical')
        .map((x: { id: string }) => x.id);
    });
    expect(v, `asistente ${url} @${width}`).toEqual([]);
  }
  await ctx.close();
});
