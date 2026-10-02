import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Browser, type BrowserContext } from '@playwright/test';

/**
 * Llamada del asistente por WebRTC REAL: navegador (livekit-client) ⇄
 * servidor LiveKit ⇄ agente de voz (apps/voice-agent), con la API emitiendo
 * el token y despachando el agente. Proveedores de voz y conversación de
 * PRUEBA (deterministas, sin secretos): lo que se verifica es el transporte,
 * el audio en ambos sentidos y el producto alrededor, no la inteligencia.
 *
 *   DEMO_APP_URL     panel construido con LIVEKIT_PUBLIC_URL (CSP)
 *   AGENT_HEALTH_URL salud del agente (para comprobar que salió de la sala)
 *   LIVEKIT_SERVER_PID (opcional, local) congela el servidor para un corte real
 *
 * Se omite si el asistente del panel no usa transporte WebRTC.
 */
const APP = process.env.DEMO_APP_URL ?? 'http://127.0.0.1:3342';
const AGENT_HEALTH = process.env.AGENT_HEALTH_URL ?? 'http://127.0.0.1:3346/health';
const FX = resolve(__dirname, '../../../../packages/assistant/test/fixtures');

/**
 * Micrófono falso: «sílabas» (armónicos con modulación de amplitud, para que
 * la supresión de ruido del navegador no lo trate como un tono estacionario)
 * de 1,4 s y silencios de 1,6 s. Chromium repite el archivo en bucle.
 */
function voiceLikeWav(): string {
  const rate = 48_000;
  const on = 1.4;
  const off = 1.6;
  const n = Math.round(rate * (on + off));
  const pcm = Buffer.alloc(44 + n * 2);
  pcm.write('RIFF', 0);
  pcm.writeUInt32LE(36 + n * 2, 4);
  pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(rate, 24);
  pcm.writeUInt32LE(rate * 2, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36);
  pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    if (t < on) {
      const f0 = 150 + 30 * Math.sin(2 * Math.PI * 1.3 * t);
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      v *= 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
      v *= Math.min(1, t / 0.05, (on - t) / 0.05);
    }
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 9000))), 44 + i * 2);
  }
  const file = join(mkdtempSync(join(tmpdir(), 'fluvia-call-')), 'voz.wav');
  writeFileSync(file, pcm);
  return file;
}

const FAKE_AUDIO = voiceLikeWav();

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
      `--use-file-for-fake-audio-capture=${FAKE_AUDIO}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

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

async function personal(browser: Browser): Promise<BrowserContext> {
  const login = await browser.newContext();
  const lp = await login.newPage();
  await lp.goto(`${APP}/personal/entrar`);
  await lp.getByLabel('Correo').fill('cliente@demo.fluvia.test');
  await lp.getByLabel('Contraseña').fill('demo-cliente-password');
  await lp.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await lp.waitForURL(`${APP}/personal`);
  const state = await login.storageState();
  await login.close();
  const ctx = await browser.newContext({ permissions: ['microphone'], storageState: state });
  await ctx.addInitScript(TRACK_SPY);
  return ctx;
}

const liveTracks = (p: import('@playwright/test').Page) =>
  p.evaluate(
    () =>
      (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks.filter(
        (t) => t.readyState === 'live'
      ).length
  );

test('llamada WebRTC: agente de prueba, turnos, audio real, interrupción, reconexión, foto, colgar', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const ctx = await personal(browser);
  const p = await ctx.newPage();
  await p.goto(`${APP}/personal`);
  await p
    .getByRole('button', { name: 'Pregunta a Fluvia' })
    .filter({ visible: true })
    .first()
    .click();
  await p.getByRole('button', { name: 'Hablar con Fluvia' }).click();
  const panel = p.locator('.as-call');
  const transport = await panel.getAttribute('data-call-transport');
  test.skip(transport !== 'webrtc', `transporte ${transport}: el panel no usa WebRTC`);

  // Consentimiento: nada de micrófono antes de aceptar.
  expect(await liveTracks(p)).toBe(0);
  await p.getByRole('button', { name: 'Permitir micrófono y conectar' }).click();
  await expect(panel).toHaveAttribute('data-call-state', 'connected', { timeout: 20_000 });
  const transcript = p.locator('.as-transcript');
  await expect(transcript).toContainText('Conectada por WebRTC con el agente de PRUEBA', {
    timeout: 15_000,
  });
  await expect(panel.locator('.as-sim-chip')).toHaveText('Agente de prueba');
  expect(await liveTracks(p)).toBeGreaterThan(0);

  // Turno: voz por WebRTC → transcripción del agente → conversación → voz del agente.
  await expect(transcript).toContainText('Transcripción de prueba del agente', { timeout: 20_000 });
  await expect(transcript.locator('li[data-who="fluvia"]').first()).toBeVisible({
    timeout: 20_000,
  });
  // El audio del agente LLEGA al navegador por WebRTC (energía medida en la pista remota).
  await expect(panel).toHaveAttribute('data-agent-audio', 'received', { timeout: 20_000 });
  // La persona vuelve a hablar mientras el agente habla: interrupción.
  await expect(transcript).toContainText('Interrumpiste a Fluvia', { timeout: 30_000 });

  // Silenciar: la pista local deja de enviar.
  await p.getByRole('button', { name: 'Silenciar' }).click();
  await expect(p.getByRole('button', { name: 'Activar micrófono' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await p.getByRole('button', { name: 'Activar micrófono' }).click();

  // Reconexión: el cliente cierra de verdad su señalización con el servidor
  // y se recupera (reanudación y reconexión completa). Requiere la
  // construcción de prueba (NEXT_PUBLIC_FLUVIA_E2E_HOOKS=1).
  for (const scenario of ['resume-reconnect', 'full-reconnect'] as const) {
    const recovered = await transcript.getByText('Conexión recuperada').count();
    const hooked = await p.evaluate(async (sc) => {
      const r = (
        window as unknown as { __fluviaCallRoom?: { simulateScenario(s: string): Promise<void> } }
      ).__fluviaCallRoom;
      if (!r) return false;
      await r.simulateScenario(sc);
      return true;
    }, scenario);
    expect(hooked, 'construcción sin NEXT_PUBLIC_FLUVIA_E2E_HOOKS=1').toBe(true);
    await expect
      .poll(() => transcript.getByText('Conexión recuperada').count(), { timeout: 30_000 })
      .toBeGreaterThan(recovered);
    await expect(panel).toHaveAttribute('data-call-state', 'connected');
  }
  // Corte REAL (solo local, opcional): se congela el proceso del servidor
  // LiveKit; señalización y medios dejan de responder de verdad.
  const lkPid = Number(process.env.LIVEKIT_SERVER_PID ?? 0);
  if (lkPid) {
    const recovered = await transcript.getByText('Conexión recuperada').count();
    process.kill(lkPid, 'SIGSTOP');
    try {
      await expect(panel).toHaveAttribute('data-call-state', 'reconnecting', { timeout: 70_000 });
    } finally {
      process.kill(lkPid, 'SIGCONT');
    }
    await expect
      .poll(() => transcript.getByText('Conexión recuperada').count(), { timeout: 45_000 })
      .toBeGreaterThan(recovered);
    await expect(panel).toHaveAttribute('data-call-state', 'connected');
  }
  // Tras reconectar, la llamada sigue: hay turnos nuevos.
  const turnsBefore = await transcript.getByText('Transcripción de prueba del agente').count();
  await expect
    .poll(() => transcript.getByText('Transcripción de prueba del agente').count(), {
      timeout: 20_000,
    })
    .toBeGreaterThan(turnsBefore);

  // Foto voluntaria durante la llamada: subida autenticada y respuesta en la misma conversación.
  const before = await transcript.locator('li[data-who="fluvia"]').count();
  await panel.locator('input[type=file]').setInputFiles(resolve(FX, 'px-plain.jpg'));
  await expect(transcript).toContainText('(Foto enviada)');
  await expect
    .poll(() => transcript.locator('li[data-who="fluvia"]').count(), { timeout: 30_000 })
    .toBeGreaterThan(before);

  // Colgar: micrófono liberado, agente fuera de la sala.
  await p.getByRole('button', { name: 'Colgar' }).click();
  await expect(p.getByText('Resumen de la llamada')).toBeVisible();
  await expect.poll(() => liveTracks(p), { timeout: 5_000 }).toBe(0);
  await expect
    .poll(
      async () => ((await (await fetch(AGENT_HEALTH)).json()) as { sessions: number }).sessions,
      { timeout: 15_000 }
    )
    .toBe(0);

  // Continuidad: los turnos de la llamada quedan en la conversación del chat.
  await p.getByRole('button', { name: 'Volver al chat' }).click();
  await expect(p.locator('.as-msgs, [aria-label="Conversación"]').first()).toContainText(
    'Transcripción de prueba del agente'
  );
  await ctx.close();
});
