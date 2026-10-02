import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Capturas SANEADAS de la jornada «presentación + asistente» a 390/768/1440
 * contra el stack local (`fluvia-ci`). Ids y URLs enmascarados. Comprueba,
 * además, que no hay scroll horizontal ni error de servidor.
 *
 *   PRESENTACION_CAPTURE_DIR=<dir>   (obligatoria)
 *   ASSISTANT_FAKE_AUDIO=<wav>       audio del micrófono falso (llamada)
 */
const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3342';
const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const OUT = process.env.PRESENTACION_CAPTURE_DIR ?? '';
const WIDTHS = [390, 768, 1440] as const;

test.describe.configure({ mode: 'serial' });
test.skip(!OUT, 'PRESENTACION_CAPTURE_DIR no definido');
test.use({
  locale: 'es-VE',
  timezoneId: 'America/Caracas',
  permissions: ['microphone'],
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      ...(process.env.ASSISTANT_FAKE_AUDIO
        ? [`--use-file-for-fake-audio-capture=${process.env.ASSISTANT_FAKE_AUDIO}`]
        : []),
    ],
  },
});

async function sanitize(pg: Page) {
  await pg.evaluate(() => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      n.nodeValue = (n.nodeValue ?? '')
        .replace(uuid, (x) => `••••${x.slice(-4)}`)
        .replace(/https?:\/\/\S+/g, '••••');
    }
  });
}

async function settle(pg: Page) {
  await pg.waitForLoadState('networkidle');
  // Fuerza la carga de imágenes diferidas antes de la captura de página completa.
  await pg.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
  });
  await pg.waitForTimeout(250);
}

async function check(pg: Page, name: string, width: number) {
  const r = await pg.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(r.sw, `${name} @${width}: scroll horizontal`).toBeLessThanOrEqual(r.cw);
}

async function shoot(pg: Page, url: string, name: string, full = true) {
  for (const width of WIDTHS) {
    await pg.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    const res = await pg.goto(url);
    expect(res?.status() ?? 0, `${name} @${width}`).toBeLessThan(500);
    await settle(pg);
    await check(pg, name, width);
    await sanitize(pg);
    await pg.screenshot({
      path: `${OUT}/${name}-${width}.jpg`,
      fullPage: full,
      type: 'jpeg',
      quality: 72,
    });
  }
}

async function shootAssistant(
  pg: Page,
  url: string,
  name: string,
  act: (pg: Page) => Promise<void>
) {
  for (const width of WIDTHS) {
    await pg.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await pg.goto(url);
    await pg.waitForLoadState('networkidle');
    await pg
      .getByRole('button', { name: 'Pregunta a Fluvia' })
      .filter({ visible: true })
      .first()
      .click();
    await pg.getByRole('dialog').waitFor();
    await act(pg);
    await check(pg, name, width);
    await sanitize(pg);
    await pg.screenshot({ path: `${OUT}/${name}-${width}.jpg`, type: 'jpeg', quality: 72 });
  }
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

test('públicas', async ({ page }) => {
  await shoot(page, `${APP}/`, 'a01-portada');
  await shoot(page, `${APP}/donde-comprar`, 'a02-donde-comprar');
  await shoot(page, `${APP}/donde-comprar?categoria=moda`, 'a03-donde-comprar-vacio');
  await shoot(page, `${APP}/donde-comprar/bodega-demo`, 'a04-ficha-comercio');
  await shoot(page, `${APP}/conoce/cuotas`, 'a05-conoce-cuotas');
  await shoot(page, `${APP}/conoce/billetera`, 'a06-conoce-billetera');
  await shoot(page, `${APP}/conoce/tarjeta`, 'a07-conoce-tarjeta');
  await shoot(page, `${APP}/como-funciona`, 'a08-como-funciona');
  await shoot(page, `${APP}/comercios`, 'a09-para-comercios');
  await shoot(page, `${APP}/ayuda`, 'a10-ayuda');
  await shoot(page, `${APP}/creditos`, 'a11-creditos');
});

test('Personal y asistente', async ({ page }) => {
  await page.goto(`${APP}/personal/entrar`);
  await page.getByLabel('Correo').fill('cliente@demo.fluvia.test');
  await page.getByLabel('Contraseña').fill('demo-cliente-password');
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await page.waitForURL(`${APP}/personal`);
  await shoot(page, `${APP}/personal`, 'p01-inicio-descubrir');
  await shootAssistant(page, `${APP}/personal`, 'p02-asistente-chat', async (pg) => {
    await pg.getByRole('button', { name: 'Nueva conversación' }).click();
    await pg.locator('#as-input').fill('¿Cuál es mi saldo?');
    await pg.keyboard.press('Enter');
    await expect(pg.getByText('Respuesta lista.')).toBeAttached({ timeout: 20_000 });
  });
  await shootAssistant(page, `${APP}/personal`, 'p03-asistente-sensible', async (pg) => {
    await pg.getByRole('button', { name: 'Nueva conversación' }).click();
    await pg.locator('#as-input').fill('Apruébame un crédito y transfiere 100 VES');
    await pg.keyboard.press('Enter');
    await expect(pg.getByText('Respuesta lista.')).toBeAttached({ timeout: 20_000 });
  });
  await shootAssistant(page, `${APP}/personal`, 'p04-asistente-voz', async (pg) => {
    await pg.getByRole('button', { name: 'Grabar nota de voz' }).click();
    await pg.waitForTimeout(1200);
    await pg.getByRole('button', { name: 'Detener' }).first().click();
    await pg.getByRole('button', { name: /Transcribir/ }).click();
    await expect(pg.locator('#as-input')).toHaveValue(/Transcripción simulada/);
  });
});

test('Comercio: directorio, inicio y llamada', async ({ page }) => {
  await page.goto(`${APP}/login`);
  await page.getByLabel('Correo').fill('owner@demo.fluvia.test');
  await page.getByLabel('Contraseña').fill('demo-owner-password');
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await shoot(page, `${APP}/o/${ORG}/directorio`, 'c01-directorio-editor');
  await shootAssistant(page, `${APP}/o/${ORG}`, 'c02-asistente-comercio', async (pg) => {
    await pg.getByRole('button', { name: 'Nueva conversación' }).click();
    await pg.locator('#as-input').fill('¿Hay algún cobro por confirmar?');
    await pg.keyboard.press('Enter');
    await expect(pg.getByText('Respuesta lista.')).toBeAttached({ timeout: 20_000 });
  });
  await shootAssistant(page, `${APP}/o/${ORG}`, 'c03-llamada', async (pg) => {
    await pg.getByRole('button', { name: 'Hablar con Fluvia' }).click();
    await pg.getByRole('button', { name: 'Permitir micrófono y conectar' }).click();
    await expect(pg.locator('.as-call-state')).toContainText('Conectada');
    await expect(pg.locator('.as-transcript')).toContainText('Fluvia:', { timeout: 15_000 });
  });
  // Cuelga la última llamada (libera el micrófono).
  await page.getByRole('button', { name: 'Colgar' }).click();
});
