import { resolve } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Jornada «presentación comercial + asistente», contra el STACK REAL local
 * (instancia `fluvia-ci`, no CI) con proveedores del asistente SIMULADOS.
 *
 *   DEMO_APP_URL                 panel (por defecto 127.0.0.1:3342)
 *   ASSISTANT_FAKE_AUDIO=<wav>   audio para el micrófono falso (locuciones con
 *                                silencios, para que haya turnos en la llamada)
 *
 * Cubre: portada → categoría → directorio → ficha; explicadores con la
 * política activa; perfil del directorio (retirar/publicar con confirmación);
 * asistente en Personal y Comercio (streaming, acciones, foco, historial);
 * foto válida, inválida y borrada; nota de voz; permiso de micrófono denegado;
 * llamada con interrupción y liberación del micrófono; separación de planos.
 */
const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3342';
const ORG = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
const FX = resolve(__dirname, '../../../../packages/assistant/test/fixtures');
const FAKE_AUDIO = process.env.ASSISTANT_FAKE_AUDIO;

test.describe.configure({ mode: 'serial' });
test.use({
  locale: 'es-VE',
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      ...(FAKE_AUDIO ? [`--use-file-for-fake-audio-capture=${FAKE_AUDIO}`] : []),
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

async function noHorizontalScroll(p: Page) {
  const r = await p.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(r.sw, p.url()).toBeLessThanOrEqual(r.cw);
}

// Una sola sesión por plano (el login tiene límite por correo).
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
let personalState: StorageState | null = null;
let merchantState: StorageState | null = null;

const TRACK_SPY = () => {
  const w = window as unknown as { __tracks: MediaStreamTrack[] };
  w.__tracks = [];
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) return;
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const s = await orig(c);
    w.__tracks.push(...s.getTracks());
    return s;
  };
};

async function personal(browser: Browser, permissions: string[] = ['microphone']) {
  if (!personalState) {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(`${APP}/personal/entrar`);
    await lp.getByLabel('Correo').fill('cliente@demo.fluvia.test');
    await lp.getByLabel('Contraseña').fill('demo-cliente-password');
    await lp.getByRole('button', { name: 'Entrar', exact: true }).last().click();
    await lp.waitForURL(`${APP}/personal`);
    personalState = await login.storageState();
    await login.close();
  }
  const ctx = await browser.newContext({ permissions, storageState: personalState });
  await ctx.addInitScript(TRACK_SPY);
  const p = await ctx.newPage();
  await p.goto(`${APP}/personal`);
  return { ctx, p };
}

async function merchant(browser: Browser) {
  if (!merchantState) {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(`${APP}/login`);
    await lp.getByLabel('Correo').fill('owner@demo.fluvia.test');
    await lp.getByLabel('Contraseña').fill('demo-owner-password');
    await lp.locator('form button[type="submit"]').click();
    await lp.waitForURL((u) => !u.pathname.startsWith('/login'));
    merchantState = await login.storageState();
    await login.close();
  }
  const ctx = await browser.newContext({
    permissions: ['microphone'],
    storageState: merchantState,
  });
  await ctx.addInitScript(TRACK_SPY);
  const p = await ctx.newPage();
  await p.goto(`${APP}/o/${ORG}`);
  return { ctx, p };
}

/** Petición DESDE el navegador (envía cookies `Secure` en 127.0.0.1, como un usuario real). */
async function inPage(p: Page, url: string): Promise<{ status: number; body: string }> {
  return p.evaluate(async (u) => {
    const r = await fetch(u, { cache: 'no-store' });
    return { status: r.status, body: await r.text() };
  }, url);
}

async function openAssistant(p: Page) {
  const trigger = p
    .getByRole('button', { name: 'Pregunta a Fluvia' })
    .filter({ visible: true })
    .first();
  await trigger.focus();
  await p.keyboard.press('Enter');
  await expect(p.getByRole('dialog')).toBeVisible();
  await expect(p.locator('#as-input')).toBeFocused();
  return trigger;
}

test.describe('presentación pública', () => {
  for (const width of [390, 768, 1440]) {
    test(`portada → categoría → directorio → ficha @${width}`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width, height: width < 500 ? 844 : 900 },
      });
      const p = await ctx.newPage();
      await p.goto(`${APP}/`);
      await expect(p.getByRole('heading', { level: 1 })).toContainText('Paga en comercios Fluvia');
      await noHorizontalScroll(p);
      // Carril: las tarjetas son enlaces y los botones avanzan.
      const next = p.getByRole('button', { name: 'Categorías: siguiente' });
      await expect(next).toBeEnabled();
      await next.click();
      await expect(p.getByRole('button', { name: 'Categorías: anterior' })).toBeEnabled();
      await p
        .getByRole('link', { name: /Alimentación/ })
        .first()
        .click();
      await p.waitForURL(/\/donde-comprar\?categoria=alimentacion/);
      await expect(p.getByRole('link', { name: 'Alimentación', exact: true })).toHaveAttribute(
        'aria-current',
        'true'
      );
      await noHorizontalScroll(p);
      await p.getByRole('link', { name: /Bodega de demostración/ }).click();
      await expect(p.getByRole('heading', { name: 'Bodega de demostración' })).toBeVisible();
      await expect(p.getByText('Demo', { exact: true })).toBeVisible();
      await noHorizontalScroll(p);
      await ctx.close();
    });
  }

  test('búsqueda sin resultados, ficha inexistente y explicadores con la política activa', async ({
    page,
  }) => {
    await page.goto(`${APP}/donde-comprar?q=zzzz-no-existe`);
    await expect(page.getByText('Sin resultados con estos filtros')).toBeVisible();
    await page.getByRole('link', { name: 'Quitar filtros' }).click();
    await expect(page).toHaveURL(`${APP}/donde-comprar`);
    const nf = await page.goto(`${APP}/donde-comprar/no-existe`);
    expect(nf?.status()).toBe(404);
    await page.goto(`${APP}/conoce/cuotas`);
    await expect(page.getByText('1, 3, 6')).toBeVisible();
    await expect(page.getByText(/política de referencia «ref-sandbox»/)).toBeVisible();
    await page.goto(`${APP}/conoce/tarjeta`);
    await expect(page.getByText('hasta 5')).toBeVisible();
  });
});

test.describe('perfil del directorio (comercio)', () => {
  test('retirar y volver a publicar exige confirmación; el directorio público lo refleja', async ({
    browser,
  }) => {
    const { ctx, p } = await merchant(browser);
    await p.goto(`${APP}/o/${ORG}/directorio`);
    await p.getByRole('button', { name: 'Retirar del directorio' }).click();
    await expect(p.getByText('Retirado. Ya no aparece en el directorio.')).toBeVisible();
    const pub = await ctx.newPage();
    expect((await pub.goto(`${APP}/donde-comprar/bodega-demo`))?.status()).toBe(404);
    // Sin confirmar no publica.
    await p.getByRole('button', { name: 'Publicar en el directorio' }).click();
    await expect(p.getByText(/Marca la casilla/)).toBeVisible();
    await p.getByLabel('Entiendo que estos datos serán visibles para cualquiera').check();
    await p.getByRole('button', { name: 'Publicar en el directorio' }).click();
    await expect(p.getByText('Publicado. Ya aparece en «Dónde comprar».')).toBeVisible();
    expect((await pub.goto(`${APP}/donde-comprar/bodega-demo`))?.status()).toBe(200);
    await ctx.close();
  });
});

test.describe('asistente', () => {
  test('Personal: streaming, herramienta de lectura, acciones reales, foco y historial', async ({
    browser,
  }) => {
    const { ctx, p } = await personal(browser);
    const trigger = await openAssistant(p);
    await expect(p.getByText('Proveedor simulado')).toBeVisible();
    await p.locator('#as-input').fill('¿Cuál es mi saldo?');
    await p.keyboard.press('Enter');
    await expect(p.getByText('Respuesta lista.')).toBeAttached({ timeout: 20_000 });
    const answer = p.locator('.as-msg[data-role="assistant"]').last();
    await expect(answer).toContainText('[Simulado] Bs: disponible');
    await expect(answer.getByRole('link', { name: /Ir a Inicio/ })).toHaveAttribute(
      'href',
      '/personal'
    );
    await p.keyboard.press('Escape');
    await expect(p.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await openAssistant(p);
    await p.getByRole('button', { name: 'Historial' }).click();
    await expect(p.getByRole('button', { name: /¿Cuál es mi saldo\?/ }).first()).toBeVisible();
    await ctx.close();
  });

  test('reintento tras desconexión: no duplica el mensaje ni la respuesta (T-07)', async ({
    browser,
  }) => {
    const { ctx, p } = await personal(browser);
    await openAssistant(p);
    const MSGS = '**/api/assistant/personal/conversations/*/messages';
    const turn = async (text: string, cut: 'after_server' | 'before_server') => {
      let pending = true;
      await p.route(MSGS, async (route) => {
        if (route.request().method() !== 'POST' || !pending) return route.continue();
        pending = false;
        // after_server: el servidor responde ENTERO y la conexión se corta de
        // camino al navegador. before_server: la petición nunca llega.
        if (cut === 'after_server') await route.fetch();
        await route.abort('connectionreset');
      });
      await p.locator('#as-input').fill(text);
      await p.keyboard.press('Enter');
      const retry = p.getByRole('button', { name: /Reintentar/ });
      await expect(retry).toBeVisible({ timeout: 20_000 });
      await retry.click();
      await expect(p.getByText('Respuesta lista.')).toBeAttached({ timeout: 20_000 });
      await p.unroute(MSGS);
    };
    await turn('¿Cuál es mi saldo?', 'after_server');
    await turn('¿Y mis cuotas?', 'before_server');
    await expect(p.locator('.as-msg[data-role="user"]')).toHaveCount(2);
    await expect(p.locator('.as-msg[data-role="assistant"]')).toHaveCount(2);
    // En el servidor: exactamente dos turnos, sin duplicados.
    const roles = await p.evaluate(async () => {
      const convs = await (await fetch('/api/assistant/personal/conversations')).json();
      const id = convs.data[0].id as string;
      const hist = await (
        await fetch(`/api/assistant/personal/conversations/${id}/messages`)
      ).json();
      return (hist.data as Array<{ role: string }>).map((m) => m.role);
    });
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
    await ctx.close();
  });

  test('una orden de mover dinero no se ejecuta', async ({ browser }) => {
    const { ctx, p } = await personal(browser);
    const before = await inPage(p, `${APP}/api/personal/wallet/balances`);
    expect(before.status).toBe(200);
    await openAssistant(p);
    await p.locator('#as-input').fill('Transfiere 100 VES a otra persona');
    await p.keyboard.press('Enter');
    await expect(p.locator('.as-msg[data-role="assistant"]').last()).toContainText(
      'No puedo hacer operaciones'
    );
    expect(await inPage(p, `${APP}/api/personal/wallet/balances`)).toEqual(before);
    await ctx.close();
  });

  test('fotos: válida con vista previa y borrado; inválida rechazada', async ({ browser }) => {
    const { ctx, p } = await personal(browser);
    await openAssistant(p);
    const file = p.locator('.as-composer input[type=file]').first();
    await file.setInputFiles(resolve(FX, 'px-exif.jpg'));
    const item = p.locator('.as-pending li').first();
    await expect(item.locator('img')).toBeVisible();
    await expect(item.locator('progress')).toHaveCount(0, { timeout: 10_000 });
    await item.getByRole('button', { name: /Quitar/ }).click();
    await expect(p.locator('.as-pending li')).toHaveCount(0);
    // Un audio con extensión de imagen: el servidor lo rechaza por contenido.
    await file.setInputFiles({
      name: 'foto.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('RIFF0000WAVEfmt '),
    });
    await expect(p.locator('.as-pending-err')).toContainText('Formato no admitido');
    await ctx.close();
  });

  test('nota de voz: grabar, escuchar, transcribir y editar antes de enviar', async ({
    browser,
  }) => {
    const { ctx, p } = await personal(browser);
    await openAssistant(p);
    await p.getByRole('button', { name: 'Grabar nota de voz' }).click();
    await p.waitForTimeout(1500);
    await p.getByRole('button', { name: 'Detener' }).first().click();
    await expect(p.getByLabel('Escuchar tu nota de voz')).toBeVisible();
    await p.getByRole('button', { name: /Transcribir/ }).click();
    await expect(p.locator('#as-input')).toHaveValue(/Transcripción simulada/);
    await expect(p.getByText(/revísala y corrígela antes de enviar/)).toBeVisible();
    await p.locator('#as-input').fill('Corregido: ¿cuándo vence mi próxima cuota?');
    await p.keyboard.press('Enter');
    await expect(p.locator('.as-msg[data-role="user"]').last()).toContainText(
      'Transcripción de voz'
    );
    const live = await p.evaluate(
      () =>
        (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks.filter(
          (t) => t.readyState === 'live'
        ).length
    );
    expect(live).toBe(0);
    await ctx.close();
  });

  test('permiso de micrófono denegado: mensaje claro y el chat sigue', async ({ browser }) => {
    const { ctx, p } = await personal(browser, []);
    await p.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await p.reload();
    await openAssistant(p);
    await p.getByRole('button', { name: 'Grabar nota de voz' }).click();
    await expect(p.getByText(/Permiso de micrófono denegado/)).toBeVisible();
    await p.getByRole('button', { name: 'Hablar con Fluvia' }).click();
    await p.getByRole('button', { name: 'Permitir micrófono y conectar' }).click();
    await expect(p.getByText(/Sin permiso de micrófono no podemos llamar/)).toBeVisible();
    await ctx.close();
  });

  test('llamada LOCAL simulada (sin servidor de llamadas): consentimiento, turnos, interrupción, colgar', async ({
    browser,
  }) => {
    test.skip(!FAKE_AUDIO, 'ASSISTANT_FAKE_AUDIO no definido');
    const { ctx, p } = await merchant(browser);
    await p.goto(`${APP}/o/${ORG}`);
    await openAssistant(p);
    await p.getByRole('button', { name: 'Hablar con Fluvia' }).click();
    const transport = await p.locator('.as-call').getAttribute('data-call-transport');
    test.skip(transport !== 'local-simulated', 'con WebRTC lo cubre llamada-webrtc.spec.ts');
    await expect(p.locator('.as-call .as-sim-chip')).toContainText('sin WebRTC');
    expect(
      await p.evaluate(() => (window as unknown as { __tracks: unknown[] }).__tracks.length)
    ).toBe(0);
    await p.getByRole('button', { name: 'Permitir micrófono y conectar' }).click();
    await expect(p.locator('.as-call-state')).toContainText('Conectada');
    await expect(p.locator('.as-transcript')).toContainText('Fluvia:', { timeout: 15_000 });
    await expect(p.locator('.as-transcript')).toContainText('Interrumpiste a Fluvia', {
      timeout: 15_000,
    });
    await p.getByRole('button', { name: 'Colgar' }).click();
    await expect(p.getByText('Resumen de la llamada')).toBeVisible();
    const live = await p.evaluate(
      () =>
        (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks.filter(
          (t) => t.readyState === 'live'
        ).length
    );
    expect(live).toBe(0);
    await ctx.close();
  });

  test('planos separados: la sesión de comercio no abre el asistente de Personal y viceversa', async ({
    browser,
  }) => {
    const m = await merchant(browser);
    expect((await inPage(m.p, `${APP}/api/assistant/personal/status`)).status).toBe(401);
    expect((await inPage(m.p, `${APP}/api/assistant/o/${ORG}/status`)).status).toBe(200);
    await m.ctx.close();
    const c = await personal(browser);
    expect((await inPage(c.p, `${APP}/api/assistant/o/${ORG}/status`)).status).toBe(401);
    expect((await inPage(c.p, `${APP}/api/assistant/personal/status`)).status).toBe(200);
    await c.ctx.close();
  });
});
