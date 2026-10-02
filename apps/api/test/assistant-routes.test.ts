import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import {
  MemoryStorage,
  SimulatedCallTransport,
  SimulatedConversationProvider,
  SimulatedSpeechToText,
  SimulatedTextToSpeech,
} from '@fluvia/assistant';
import { buildApp } from '../src/app.js';

/**
 * Asistente «Fluvia» por HTTP contra PostgreSQL real, con proveedores
 * SIMULADOS (deterministas). Prueba lo que no depende del modelo:
 *  - aislamiento entre CLIENTES del mismo programa y entre ORGANIZACIONES, en
 *    la API y en el almacenamiento (no solo botones ocultos);
 *  - streaming, herramientas de lectura con la identidad de la sesión,
 *    cancelación con guardado parcial, cuota diaria;
 *  - fotos y notas de voz validadas por contenido, EXIF eliminado, borrado;
 *  - ninguna orden conversacional mueve dinero;
 *  - retención por la función de purga del worker.
 */
const fx = (n: string) =>
  readFileSync(resolve(__dirname, '../../../packages/assistant/test/fixtures', n));

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let workerPool: Pool;
let program: string;
let orgA: string;
let orgB: string;
const storage = new MemoryStorage();
// Cuenta las llamadas reales al modelo: una reproducción idempotente no debe
// llamar al proveedor (ni, por tanto, ejecutar herramientas).
let providerCalls = 0;
const simulatedConversation = new SimulatedConversationProvider(40);
const countingProvider = {
  name: simulatedConversation.name,
  simulated: simulatedConversation.simulated,
  vision: simulatedConversation.vision,
  stream: (...args: Parameters<SimulatedConversationProvider['stream']>) => {
    providerCalls++;
    return simulatedConversation.stream(...args);
  },
};
const PASSWORD = 'asistente fluvia 2026';
type Headers = Record<string, string>;
let opOwner: Headers;
let ownerA: Headers;
let ownerB: Headers;

async function createOrg(name: string): Promise<string> {
  const r = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `org-${randomUUID()}`]
  );
  return r.rows[0]!.id;
}

async function sessionUser(role: string, orgId: string): Promise<Headers> {
  const email = `as-${randomUUID().slice(0, 12)}@example.com`;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  const { user_id, verification_token } = reg.json();
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: verification_token },
  });
  await adminPool.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
    orgId,
    user_id,
    role,
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  return { authorization: `Bearer ${login.json().session_token as string}` };
}

async function consumer(): Promise<Headers> {
  const r = await app.inject({
    method: 'POST',
    url: `/v1/personal/programs/${program}/register`,
    payload: {
      email: `cli-${randomUUID().slice(0, 10)}@personal.fluvia.test`,
      password: 'clave del cliente 2026',
      display_name: 'Cliente de prueba',
      synthetic_risk_profile: 'B',
    },
  });
  expect(r.statusCode).toBe(201);
  return { authorization: `Bearer ${r.json().session as string}` };
}

function parseSse(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const ev = /event: (.+)/.exec(b)?.[1] ?? '';
      const data = JSON.parse(/data: (.+)/.exec(b)?.[1] ?? '{}');
      return { event: ev, data };
    });
}

beforeAll(async () => {
  const bootEnv = { NODE_ENV: 'test', LOG_LEVEL: 'error' };
  const base = loadConfig(bootEnv);
  adminPool = createPool({ connectionString: base.db.admin, max: 2 });
  workerPool = createPool({ connectionString: base.db.worker, max: 1 });
  program = await createOrg('Programa asistente');
  orgA = await createOrg('Comercio asistente A');
  orgB = await createOrg('Comercio asistente B');
  const config = loadConfig({ ...bootEnv, FLUVIA_PROGRAM_TENANT_ID: program });
  appPool = createPool({ connectionString: config.db.app, max: 8 });
  authPool = createPool({ connectionString: config.db.auth, max: 4 });
  app = buildApp({
    config,
    appPool,
    authPool,
    authService: new AuthService(authPool),
    identityService: new IdentityService(appPool),
    apiKeyService: new ApiKeyService(appPool),
    authRateLimits: {
      loginPerEmail: { max: 10_000, windowMs: 60_000 },
      loginPerIp: { max: 10_000, windowMs: 60_000 },
      registerPerIp: { max: 10_000, windowMs: 60_000 },
      mfaPerIp: { max: 10_000, windowMs: 60_000 },
    },
    assistant: {
      env: { ASSISTANT_MESSAGES_PER_DAY: '6', ASSISTANT_MAX_AUDIO_SECONDS: '120' },
      storage,
      providers: {
        conversation: countingProvider,
        stt: new SimulatedSpeechToText(),
        tts: new SimulatedTextToSpeech(),
        call: new SimulatedCallTransport(),
      },
    },
  });
  await app.ready();
  opOwner = await sessionUser('owner', program);
  await app.inject({
    method: 'POST',
    url: '/v1/auth/step-up/password',
    headers: opOwner,
    payload: { password: PASSWORD },
  });
  const setup = await app.inject({
    method: 'POST',
    url: `/v1/programs/${program}/setup`,
    headers: opOwner,
    payload: { name: 'Fluvia Personal', currencies: ['VES', 'USD'] },
  });
  expect(setup.statusCode).toBe(201);
  ownerA = await sessionUser('owner', orgA);
  ownerB = await sessionUser('owner', orgB);
}, 60_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end(), workerPool.end()]);
});

const P = '/v1/personal/assistant';
const C = (org: string) => `/v1/organizations/${org}/assistant`;

let address: string | null = null;
async function listenOnce(): Promise<string> {
  address ??= await app.listen({ port: 0, host: '127.0.0.1' });
  return address;
}

async function newConversation(base: string, h: Headers): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `${base}/conversations`,
    headers: h,
    payload: {},
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function send(base: string, h: Headers, conv: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `${base}/conversations/${conv}/messages`,
    headers: h,
    payload,
  });
}

describe('estado y proveedores', () => {
  it('declara que todos los proveedores son simulados', async () => {
    const r = await app.inject({ method: 'GET', url: `${P}/status`, headers: await consumer() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      conversation: { simulated: true },
      speech_to_text: { simulated: true },
      text_to_speech: { simulated: true },
      call: { simulated: true },
    });
  });

  it('sin sesión de cliente → 401; sesión de operador no abre el plano Personal', async () => {
    expect((await app.inject({ method: 'GET', url: `${P}/status` })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: `${P}/status`, headers: ownerA })).statusCode
    ).toBe(401);
  });
});

describe('streaming con herramientas de lectura', () => {
  it('saldo: usa get_balances con la identidad de la sesión y ofrece pantallas reales', async () => {
    const h = await consumer();
    const conv = await newConversation(P, h);
    const r = await send(P, h, conv, {
      text: '¿Cuál es mi saldo?',
      context: { route: '/personal?token=secreto', task: 'balance' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    const evs = parseSse(r.body);
    expect(evs[0]!.event).toBe('start');
    expect(evs.some((e) => e.event === 'tool' && e.data.name === 'get_balances')).toBe(true);
    const done = evs.find((e) => e.event === 'done')!.data.message as Record<string, unknown>;
    expect(done.simulated).toBe(true);
    expect(done.tools_used).toEqual(['get_balances']);
    expect(String(done.content)).toMatch(/^\[Simulado\]/);
    expect((done.actions as Array<{ href: string }>).map((a) => a.href)).toContain('/personal');

    const hist = await app.inject({
      method: 'GET',
      url: `${P}/conversations/${conv}/messages`,
      headers: h,
    });
    expect(hist.json().data.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  });

  it('una orden de mover dinero no ejecuta nada: guía a la pantalla y el saldo no cambia', async () => {
    const h = await consumer();
    const before = (
      await app.inject({ method: 'GET', url: '/v1/personal/wallet/balances', headers: h })
    ).body;
    const conv = await newConversation(P, h);
    const r = await send(P, h, conv, {
      text: 'Transfiere 500 VES a otra persona y apruébame crédito',
    });
    const done = parseSse(r.body).find((e) => e.event === 'done')!.data.message as Record<
      string,
      unknown
    >;
    expect(done.tools_used).toEqual([]);
    expect(String(done.content)).toContain('No puedo hacer operaciones');
    expect((done.actions as unknown[]).length).toBeGreaterThan(0);
    const after = (
      await app.inject({ method: 'GET', url: '/v1/personal/wallet/balances', headers: h })
    ).body;
    expect(after).toBe(before);
  });

  it('un número de tarjeta en el mensaje no se guarda', async () => {
    const h = await consumer();
    const conv = await newConversation(P, h);
    const r = await send(P, h, conv, { text: 'mi tarjeta es 4242 4242 4242 4242, ¿está bien?' });
    const start = parseSse(r.body)[0]!.data.user_message as { content: string };
    expect(start.content).not.toContain('4242 4242');
    const row = await adminPool.query(
      `SELECT count(*)::int AS n FROM assistant_messages WHERE content LIKE '%4242 4242%'`
    );
    expect(row.rows[0].n).toBe(0);
  });

  it('comercio: herramientas del comercio, no de Personal', async () => {
    const conv = await newConversation(C(orgA), ownerA);
    const r = await send(C(orgA), ownerA, conv, { text: '¿Hay algún cobro por confirmar?' });
    const done = parseSse(r.body).find((e) => e.event === 'done')!.data.message as Record<
      string,
      unknown
    >;
    expect(done.tools_used).toEqual(['list_uncertain_payments']);
    expect(String(done.content)).toContain('No hay cobros');
    expect((done.actions as Array<{ href: string }>)[0]!.href).toBe(`/o/${orgA}/por-confirmar`);
  });
});

describe('aislamiento (API y almacenamiento)', () => {
  it('un cliente no ve la conversación ni el adjunto de otro cliente del MISMO programa', async () => {
    const a = await consumer();
    const b = await consumer();
    const conv = await newConversation(P, a);
    await send(P, a, conv, { text: 'hola' });
    const up = await app.inject({
      method: 'POST',
      url: `${P}/attachments`,
      headers: { ...a, 'content-type': 'application/octet-stream', 'x-attachment-kind': 'image' },
      payload: fx('px.png'),
    });
    expect(up.statusCode).toBe(201);
    const att = up.json().id as string;

    expect(
      (await app.inject({ method: 'GET', url: `${P}/conversations`, headers: b })).json().data
    ).toEqual([]);
    expect(
      (await app.inject({ method: 'GET', url: `${P}/conversations/${conv}/messages`, headers: b }))
        .statusCode
    ).toBe(404);
    expect((await send(P, b, conv, { text: 'leer' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `${P}/attachments/${att}/content`, headers: b }))
        .statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: `${P}/attachments/${att}/delete`, headers: b }))
        .statusCode
    ).toBe(404);
    // B tampoco puede adjuntar la foto de A a su propia conversación.
    const convB = await newConversation(P, b);
    const steal = await send(P, b, convB, { text: 'mira', attachment_ids: [att] });
    expect(steal.statusCode).toBe(422);
    expect(steal.json().error.code).toBe('assistant_invalid_attachment');
  });

  it('una organización no ve conversaciones de otra (ni por su ruta ni por la ajena)', async () => {
    const conv = await newConversation(C(orgA), ownerA);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${C(orgB)}/conversations/${conv}/messages`,
          headers: ownerB,
        })
      ).statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `${C(orgA)}/conversations`, headers: ownerB }))
        .statusCode
    ).toBe(404);
  });

  it('RLS: el rol de la app con OTRO titular en el mismo tenant no lee filas', async () => {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)`,
        [program, randomUUID()]
      );
      const n = await c.query('SELECT count(*)::int AS n FROM assistant_conversations');
      expect(n.rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});

describe('fotos', () => {
  it('válida: se guarda SIN EXIF; se puede ver y borrar antes de enviar', async () => {
    const h = await consumer();
    const up = await app.inject({
      method: 'POST',
      url: `${P}/attachments`,
      headers: { ...h, 'content-type': 'application/octet-stream', 'x-attachment-kind': 'image' },
      payload: fx('px-exif.jpg'),
    });
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ kind: 'image', mime: 'image/jpeg', width: 64, height: 48 });
    const id = up.json().id as string;
    const got = await app.inject({
      method: 'GET',
      url: `${P}/attachments/${id}/content`,
      headers: h,
    });
    expect(got.statusCode).toBe(200);
    expect(got.headers['cache-control']).toBe('private, no-store');
    expect(got.rawPayload.includes(Buffer.from('GPS-LATITUDE'))).toBe(false);

    const del = await app.inject({
      method: 'POST',
      url: `${P}/attachments/${id}/delete`,
      headers: h,
    });
    expect(del.json().status).toBe('deleted');
    expect(
      (await app.inject({ method: 'GET', url: `${P}/attachments/${id}/content`, headers: h }))
        .statusCode
    ).toBe(404);
  });

  it('inválida: un audio declarado como imagen → 415; vacía → 422', async () => {
    const h = await consumer();
    const bad = await app.inject({
      method: 'POST',
      url: `${P}/attachments`,
      headers: { ...h, 'content-type': 'application/octet-stream', 'x-attachment-kind': 'image' },
      payload: fx('tone.wav'),
    });
    expect(bad.statusCode).toBe(415);
    expect(bad.json().error.code).toBe('media_unsupported');
  });

  it('con foto: el mensaje la incluye y el proveedor simulado no inventa su contenido', async () => {
    const h = await consumer();
    const up = await app.inject({
      method: 'POST',
      url: `${P}/attachments`,
      headers: { ...h, 'content-type': 'application/octet-stream', 'x-attachment-kind': 'image' },
      payload: fx('px.webp'),
    });
    const conv = await newConversation(P, h);
    const r = await send(P, h, conv, { text: '', attachment_ids: [up.json().id] });
    const done = parseSse(r.body).find((e) => e.event === 'done')!.data.message as {
      content: string;
    };
    expect(done.content).toContain('no analiza su contenido');
    // Ya enviada: no se puede borrar como «antes de enviar».
    const del = await app.inject({
      method: 'POST',
      url: `${P}/attachments/${up.json().id}/delete`,
      headers: h,
    });
    expect(del.statusCode).toBe(404);
  });
});

describe('notas de voz', () => {
  it('transcripción simulada y EDITABLE; el audio se elimina tras transcribir', async () => {
    const h = await consumer();
    const up = await app.inject({
      method: 'POST',
      url: `${P}/attachments`,
      headers: { ...h, 'content-type': 'application/octet-stream', 'x-attachment-kind': 'audio' },
      payload: fx('tone.ogg'),
    });
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ kind: 'audio', mime: 'audio/ogg' });
    expect(Math.abs(up.json().duration_ms - 2000)).toBeLessThan(120);
    const before = storage.blobs.size;
    const t = await app.inject({
      method: 'POST',
      url: `${P}/transcriptions`,
      headers: h,
      payload: { attachment_id: up.json().id },
    });
    expect(t.statusCode).toBe(200);
    expect(t.json()).toMatchObject({ simulated: true });
    expect(t.json().text).toContain('Transcripción simulada de 2 s');
    expect(storage.blobs.size).toBe(before - 1);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${P}/attachments/${up.json().id}/content`,
          headers: h,
        })
      ).statusCode
    ).toBe(404);
  });

  it('demasiado larga → 422 media_too_long (validada en el servidor)', async () => {
    const h = await consumer();
    const r = await app.inject({
      method: 'POST',
      url: `${P}/attachments`,
      headers: { ...h, 'content-type': 'application/octet-stream', 'x-attachment-kind': 'audio' },
      payload: fx('long.ogg'),
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('media_too_long');
  });

  it('respuesta hablada opcional: WAV marcado como simulado', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `${P}/speech`,
      headers: await consumer(),
      payload: { text: 'Tu saldo disponible es 100 VES.' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('audio/wav');
    expect(r.headers['x-fluvia-simulated']).toBe('true');
  });
});

describe('llamada', () => {
  it('transporte simulado: sin URL de medios, sala propia y vida corta', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `${P}/call/token`,
      headers: await consumer(),
    });
    expect(r.json()).toMatchObject({ simulated: true, url: null });
    expect(r.json().room).toMatch(/^fluvia-personal-/);
    expect(Date.parse(r.json().expires_at) - Date.now()).toBeLessThanOrEqual(900_000);
  });
});

describe('límites y cancelación', () => {
  it('cuota diaria por titular → 429 assistant_quota_exceeded', async () => {
    const h = await consumer();
    const conv = await newConversation(P, h);
    for (let i = 0; i < 6; i++)
      expect((await send(P, h, conv, { text: `hola ${i}` })).statusCode).toBe(200);
    const r = await send(P, h, conv, { text: 'una más' });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('assistant_quota_exceeded');
  });

  it('cancelar a mitad: se guarda lo mostrado con estado «cancelled»', async () => {
    const address = await listenOnce();
    const h = await consumer();
    const conv = await newConversation(P, h);
    const ac = new AbortController();
    const res = await fetch(`${address}${P}/conversations/${conv}/messages`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'cuéntame qué puedes hacer' }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: delta')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`el stream terminó sin delta: ${res.status} ${seen}`);
      seen += dec.decode(chunk.value);
    }
    ac.abort();
    await new Promise((r) => setTimeout(r, 600));
    const hist = await app.inject({
      method: 'GET',
      url: `${P}/conversations/${conv}/messages`,
      headers: h,
    });
    const last = hist.json().data.at(-1);
    expect(last).toMatchObject({ role: 'assistant', status: 'cancelled' });
    expect(last.content.length).toBeGreaterThan(0);
  });
});

describe('reintentos idempotentes (T-07)', () => {
  const rows = async (conv: string) =>
    (
      await adminPool.query<{ role: string; status: string; reply_to: string | null }>(
        `SELECT role, status, reply_to FROM assistant_messages WHERE conversation_id = $1 ORDER BY created_at`,
        [conv]
      )
    ).rows;

  it('respuesta ya completa: el reintento la reproduce sin proveedor, herramientas ni mensajes nuevos', async () => {
    const h = await consumer();
    const conv = await newConversation(P, h);
    const id = randomUUID();
    const first = parseSse(
      (await send(P, h, conv, { text: '¿Cuál es mi saldo?', client_message_id: id })).body
    );
    const done1 = first.find((e) => e.event === 'done')!.data.message as Record<string, unknown>;
    expect(done1.tools_used).toEqual(['get_balances']);
    const calls = providerCalls;

    const again = parseSse(
      (await send(P, h, conv, { text: '¿Cuál es mi saldo?', client_message_id: id })).body
    );
    const start2 = again.find((e) => e.event === 'start')!.data.user_message as { id: string };
    const done2 = again.find((e) => e.event === 'done')!.data.message as Record<string, unknown>;
    expect(start2.id).toBe((first[0]!.data.user_message as { id: string }).id);
    expect(done2.id).toBe(done1.id);
    expect(done2.content).toBe(done1.content);
    expect(again.some((e) => e.event === 'tool')).toBe(false);
    expect(providerCalls).toBe(calls);
    expect((await rows(conv)).map((r) => r.role)).toEqual(['user', 'assistant']);
  });

  it('desconexión a mitad: el reintento regenera sobre el MISMO mensaje de usuario', async () => {
    const address = await listenOnce();
    const h = await consumer();
    const conv = await newConversation(P, h);
    const id = randomUUID();
    const ac = new AbortController();
    const res = await fetch(`${address}${P}/conversations/${conv}/messages`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'cuéntame qué puedes hacer', client_message_id: id }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: delta')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`el stream terminó sin delta: ${res.status} ${seen}`);
      seen += dec.decode(chunk.value);
    }
    ac.abort();
    await new Promise((r) => setTimeout(r, 600));
    expect((await rows(conv)).map((r) => `${r.role}:${r.status}`)).toEqual([
      'user:complete',
      'assistant:cancelled',
    ]);

    const retry = parseSse(
      (await send(P, h, conv, { text: 'cuéntame qué puedes hacer', client_message_id: id })).body
    );
    expect(retry.find((e) => e.event === 'done')).toBeTruthy();
    const all = await rows(conv);
    // Un solo mensaje de usuario; la respuesta nueva contesta a ese mismo mensaje.
    expect(all.filter((r) => r.role === 'user')).toHaveLength(1);
    expect(all.map((r) => `${r.role}:${r.status}`)).toEqual([
      'user:complete',
      'assistant:cancelled',
      'assistant:complete',
    ]);
    const userId = (retry[0]!.data.user_message as { id: string }).id;
    expect(all.slice(1).every((r) => r.reply_to === userId)).toBe(true);

    // Un tercer intento ya reproduce la respuesta completa.
    const calls = providerCalls;
    await send(P, h, conv, { text: 'cuéntame qué puedes hacer', client_message_id: id });
    expect(providerCalls).toBe(calls);
    expect(await rows(conv)).toHaveLength(3);
  });

  it('misma clave con otro texto → 409 assistant_idempotency_mismatch', async () => {
    const h = await consumer();
    const conv = await newConversation(P, h);
    const id = randomUUID();
    await send(P, h, conv, { text: 'hola', client_message_id: id });
    const r = await send(P, h, conv, { text: 'otra cosa', client_message_id: id });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('assistant_idempotency_mismatch');
    expect(await rows(conv)).toHaveLength(2);
  });

  it('dos envíos simultáneos del mismo turno: un solo mensaje y una sola ejecución', async () => {
    const h = await consumer();
    const conv = await newConversation(P, h);
    const id = randomUUID();
    const calls = providerCalls;
    const [a, b] = await Promise.all([
      send(P, h, conv, { text: '¿Cuál es mi saldo?', client_message_id: id }),
      send(P, h, conv, { text: '¿Cuál es mi saldo?', client_message_id: id }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const all = await rows(conv);
    expect(all.filter((r) => r.role === 'user')).toHaveLength(1);
    expect(all.filter((r) => r.role === 'assistant')).toHaveLength(1);
    // get_balances: una ronda con herramienta + una de respuesta = 2 llamadas.
    expect(providerCalls - calls).toBe(2);
  });
});

describe('retención (worker)', () => {
  it('purge_assistant_data borra lo vencido y devuelve las claves a eliminar', async () => {
    const h = await consumer();
    const up = await app.inject({
      method: 'POST',
      url: `${P}/attachments`,
      headers: { ...h, 'content-type': 'application/octet-stream', 'x-attachment-kind': 'image' },
      payload: fx('px.png'),
    });
    const id = up.json().id as string;
    await adminPool.query(`ALTER TABLE assistant_attachments DISABLE TRIGGER USER`);
    await adminPool.query(
      `UPDATE assistant_attachments SET created_at = now() - interval '40 days' WHERE id = $1`,
      [id]
    );
    await adminPool.query(`ALTER TABLE assistant_attachments ENABLE TRIGGER USER`);
    const r = await workerPool.query<{ storage_key: string }>(
      'SELECT * FROM purge_assistant_data(30)'
    );
    const key = (await adminPool.query('SELECT 1 FROM assistant_attachments WHERE id = $1', [id]))
      .rowCount;
    expect(key).toBe(0);
    expect(r.rows.length).toBeGreaterThan(0);
    // El rol de la app no puede ejecutar la purga.
    await expect(appPool.query('SELECT * FROM purge_assistant_data(30)')).rejects.toThrow();
  });
});
