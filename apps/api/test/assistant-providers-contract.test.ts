import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { MemoryStorage } from '@fluvia/assistant';
import { buildApp } from '../src/app.js';

/**
 * Proveedores REALES del asistente (adaptadores Anthropic y de voz compatible
 * con OpenAI), configurados por VARIABLES DE ENTORNO como en producción y
 * probados por HTTP contra servidores LOCALES que implementan sus protocolos
 * y VALIDAN lo que reciben (cabeceras, esquema, multipart, imagen sin EXIF).
 *
 * Lo que esto NO prueba: el comportamiento, la calidad ni la disponibilidad
 * de los servicios reales (no hay claves del producto en este entorno). Los
 * servidores de contrato reproducen los formatos documentados; si el
 * proveedor real cambia su contrato, esta prueba no lo detecta.
 */
const fx = (n: string) =>
  readFileSync(resolve(__dirname, '../../../packages/assistant/test/fixtures', n));

const ANT_KEY = 'ant-clave-contrato-solo-prueba';
const SP_KEY = 'voz-clave-contrato-solo-prueba';
const MODEL = 'modelo-de-contrato';
const READ_TOOLS = [
  'find_merchants',
  'get_balances',
  'get_credit_status',
  'list_upcoming_installments',
  'list_cards',
  'list_recent_activity',
  'suggest_actions',
];

interface Seen {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> | null;
  form?: { file: { size: number; type: string; name: string }; fields: Record<string, string> };
}
const anthropicSeen: Seen[] = [];
const speechSeen: Seen[] = [];

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((ok) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
  });

const sseBlock = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Servidor que implementa /v1/messages (streaming) y rechaza peticiones mal formadas. */
function anthropicContract(): Server {
  return createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      /* body null */
    }
    anthropicSeen.push({ path: req.url ?? '', headers: req.headers, body });
    const bad = (msg: string) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: msg } })
      );
    };
    if (req.method !== 'POST' || req.url !== '/v1/messages') return bad('ruta');
    if (req.headers['x-api-key'] !== ANT_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"type":"error","error":{"type":"authentication_error"}}');
    }
    if (req.headers['anthropic-version'] !== '2023-06-01') return bad('anthropic-version');
    if (!body || body.model !== MODEL || body.stream !== true) return bad('model/stream');
    if (typeof body.max_tokens !== 'number' || typeof body.system !== 'string')
      return bad('campos');
    const tools = body.tools as Array<Record<string, unknown>>;
    if (!Array.isArray(tools) || tools.some((t) => !t.name || !t.description || !t.input_schema))
      return bad('tools');
    const msgs = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    if (!Array.isArray(msgs) || msgs.length === 0 || msgs[0]!.role !== 'user')
      return bad('messages');
    for (let i = 1; i < msgs.length; i++)
      if (msgs[i]!.role === msgs[i - 1]!.role) return bad('roles alternos');

    const last = msgs[msgs.length - 1]!;
    const text = last.content
      .filter((c) => c.type === 'text')
      .map((c) => String(c.text))
      .join(' ');
    if (text.includes('provoca 429')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseBlock('message_start', { type: 'message_start', message: { id: 'msg_1' } }));
    const say = (t: string, stop = 'end_turn') => {
      res.write(
        sseBlock('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
      );
      // Texto en dos trozos: el adaptador debe concatenar deltas.
      const mid = Math.floor(t.length / 2);
      for (const part of [t.slice(0, mid), t.slice(mid)])
        res.write(
          sseBlock('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: part },
          })
        );
      res.write(sseBlock('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(sseBlock('message_delta', { type: 'message_delta', delta: { stop_reason: stop } }));
      res.write(sseBlock('message_stop', { type: 'message_stop' }));
      res.end();
    };
    if (text.includes('provoca sobrecarga')) {
      res.write(sseBlock('error', { type: 'error', error: { type: 'overloaded_error' } }));
      return res.end();
    }
    const toolResult = last.content.find((c) => c.type === 'tool_result');
    if (toolResult) {
      const parsed = JSON.parse(String(toolResult.content)) as { summary?: string };
      return say(`Según tus datos: ${parsed.summary ?? '(sin resumen)'}`);
    }
    const image = last.content.find((c) => c.type === 'image');
    if (image) {
      const src = image.source as { type: string; media_type: string; data: string };
      const bytes = Buffer.from(src.data, 'base64');
      return say(`Veo una imagen ${src.media_type} de ${bytes.length} bytes.`);
    }
    // Pide una herramienta, con el JSON de entrada troceado.
    res.write(
      sseBlock('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_contrato', name: 'get_balances', input: {} },
      })
    );
    for (const part of ['{', '}'])
      res.write(
        sseBlock('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: part },
        })
      );
    res.write(sseBlock('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(
      sseBlock('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } })
    );
    res.write(sseBlock('message_stop', { type: 'message_stop' }));
    res.end();
  });
}

function wav(seconds: number, rate = 24_000): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 8000), 44 + i * 2);
  return b;
}
const TTS_WAV = wav(0.8);

/** Servidor que implementa /audio/transcriptions (multipart) y /audio/speech (WAV). */
function speechContract(): Server {
  return createServer(async (req, res) => {
    const raw = await readBody(req);
    const seen: Seen = { path: req.url ?? '', headers: req.headers, body: null };
    speechSeen.push(seen);
    const bad = (status: number, msg: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: msg } }));
    };
    if (req.headers.authorization !== `Bearer ${SP_KEY}`) return bad(401, 'clave');
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      const ct = String(req.headers['content-type'] ?? '');
      if (!ct.startsWith('multipart/form-data')) return bad(400, 'multipart');
      const form = await new Response(raw, { headers: { 'content-type': ct } }).formData();
      const file = form.get('file');
      if (!(file instanceof Blob) || file.size === 0) return bad(400, 'file');
      seen.form = {
        file: { size: file.size, type: file.type, name: (file as File).name },
        fields: { model: String(form.get('model')), language: String(form.get('language')) },
      };
      if (seen.form.fields.model !== 'stt-contrato') return bad(400, 'model');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ text: `  Texto transcrito de ${file.size} bytes.  ` }));
    }
    if (req.method === 'POST' && req.url === '/v1/audio/speech') {
      const body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      seen.body = body;
      if (body.model !== 'tts-contrato' || body.voice !== 'voz-contrato') return bad(400, 'model');
      if (typeof body.input !== 'string' || body.input.length > 4096) return bad(400, 'input');
      if (body.response_format !== 'wav') return bad(400, 'formato');
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(TTS_WAV);
    }
    return bad(404, 'ruta');
  });
}

const listen = (s: Server) =>
  new Promise<string>((ok) =>
    s.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(s.address() as AddressInfo).port}`))
  );

let app: FastifyInstance;
let appPool: Pool;
let authPool: Pool;
let adminPool: Pool;
let program: string;
const servers: Server[] = [];

function parseSse(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => ({
      event: /event: (.+)/.exec(b)?.[1] ?? '',
      data: JSON.parse(/data: (.+)/.exec(b)?.[1] ?? '{}') as Record<string, unknown>,
    }));
}

beforeAll(async () => {
  const ant = anthropicContract();
  const sp = speechContract();
  servers.push(ant, sp);
  const [antUrl, spUrl] = await Promise.all([listen(ant), listen(sp)]);
  const bootEnv = { NODE_ENV: 'test', LOG_LEVEL: 'error' };
  const base = loadConfig(bootEnv);
  adminPool = createPool({ connectionString: base.db.admin, max: 2 });
  const r = await adminPool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    ['Programa contrato', `org-${randomUUID()}`]
  );
  program = r.rows[0]!.id;
  const config = loadConfig({ ...bootEnv, FLUVIA_PROGRAM_TENANT_ID: program });
  appPool = createPool({ connectionString: config.db.app, max: 6 });
  authPool = createPool({ connectionString: config.db.auth, max: 3 });
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
      // Misma ruta de configuración que producción: variables de entorno.
      env: {
        ASSISTANT_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: ANT_KEY,
        ASSISTANT_MODEL: MODEL,
        ANTHROPIC_BASE_URL: antUrl,
        ASSISTANT_SPEECH_PROVIDER: 'openai_compatible',
        SPEECH_API_KEY: SP_KEY,
        SPEECH_BASE_URL: `${spUrl}/v1`,
        SPEECH_STT_MODEL: 'stt-contrato',
        SPEECH_TTS_MODEL: 'tts-contrato',
        SPEECH_TTS_VOICE: 'voz-contrato',
      },
      storage: new MemoryStorage(),
    },
  });
  await app.ready();
  // Programa Personal con su operador.
  const email = `op-${randomUUID().slice(0, 10)}@example.com`;
  const PASSWORD = 'contrato asistente 2026';
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD },
  });
  await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: reg.json().verification_token },
  });
  await adminPool.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
    program,
    reg.json().user_id,
    'owner',
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  const op = { authorization: `Bearer ${login.json().session_token as string}` };
  await app.inject({
    method: 'POST',
    url: '/v1/auth/step-up/password',
    headers: op,
    payload: { password: PASSWORD },
  });
  const setup = await app.inject({
    method: 'POST',
    url: `/v1/programs/${program}/setup`,
    headers: op,
    payload: { name: 'Fluvia Personal', currencies: ['VES', 'USD'] },
  });
  expect(setup.statusCode).toBe(201);
}, 60_000);

afterAll(async () => {
  await app.close();
  await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
  await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
});

const P = '/v1/personal/assistant';

async function consumer(): Promise<Record<string, string>> {
  const r = await app.inject({
    method: 'POST',
    url: `/v1/personal/programs/${program}/register`,
    payload: {
      email: `cli-${randomUUID().slice(0, 10)}@personal.fluvia.test`,
      password: 'clave del cliente 2026',
      display_name: 'Cliente contrato',
      synthetic_risk_profile: 'B',
    },
  });
  expect(r.statusCode).toBe(201);
  return { authorization: `Bearer ${r.json().session as string}` };
}

async function conversation(h: Record<string, string>): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `${P}/conversations`,
    headers: h,
    payload: {},
  });
  return r.json().id as string;
}

describe('conversación con el adaptador Anthropic (servidor de contrato)', () => {
  it('estado: proveedor real, sin claves ni URL en la respuesta', async () => {
    const r = await app.inject({ method: 'GET', url: `${P}/status`, headers: await consumer() });
    expect(r.json()).toMatchObject({
      conversation: { provider: 'anthropic', simulated: false },
      speech_to_text: { simulated: false },
      text_to_speech: { simulated: false },
    });
    expect(r.body).not.toContain(ANT_KEY);
    expect(r.body).not.toContain(SP_KEY);
    expect(r.body).not.toContain('127.0.0.1');
  });

  it('herramienta: pide get_balances, la API la ejecuta con la sesión y devuelve el resultado', async () => {
    const h = await consumer();
    const conv = await conversation(h);
    anthropicSeen.length = 0;
    const r = await app.inject({
      method: 'POST',
      url: `${P}/conversations/${conv}/messages`,
      headers: h,
      payload: { text: '¿Cuál es mi saldo?' },
    });
    expect(r.statusCode).toBe(200);
    const evs = parseSse(r.body);
    expect(evs.some((e) => e.event === 'tool' && e.data.name === 'get_balances')).toBe(true);
    const done = evs.find((e) => e.event === 'done')!.data.message as Record<string, unknown>;
    expect(done.simulated).toBe(false);
    expect(done.tools_used).toEqual(['get_balances']);
    expect(String(done.content)).toMatch(/^Según tus datos: /);

    // Dos rondas contra el proveedor; la segunda lleva el resultado de la herramienta.
    expect(anthropicSeen).toHaveLength(2);
    const [first, second] = anthropicSeen as [Seen, Seen];
    // Solo herramientas de LECTURA se ofrecen al modelo.
    const offered = (first.body!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(offered.every((n) => READ_TOOLS.includes(n))).toBe(true);
    expect(offered).toContain('get_balances');
    const msgs = second.body!.messages as Array<{ role: string; content: unknown[] }>;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const result = msgs[2]!.content[0] as { type: string; tool_use_id: string; content: string };
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_contrato' });
    expect(JSON.parse(result.content)).toHaveProperty('summary');
    // El texto final del modelo es exactamente lo que se guarda.
    expect(String(done.content)).toContain(
      (JSON.parse(result.content) as { summary: string }).summary
    );
  });

  it('visión: la foto llega como imagen base64 SIN metadatos EXIF', async () => {
    const h = await consumer();
    const up = await app.inject({
      method: 'POST',
      url: `${P}/attachments`,
      headers: { ...h, 'content-type': 'application/octet-stream', 'x-attachment-kind': 'image' },
      payload: fx('px-exif.jpg'),
    });
    expect(up.statusCode).toBe(201);
    expect(fx('px-exif.jpg').includes(Buffer.from('Exif'))).toBe(true);
    const conv = await conversation(h);
    anthropicSeen.length = 0;
    const r = await app.inject({
      method: 'POST',
      url: `${P}/conversations/${conv}/messages`,
      headers: h,
      payload: { text: '¿Qué ves?', attachment_ids: [up.json().id] },
    });
    const done = parseSse(r.body).find((e) => e.event === 'done')!.data.message as {
      content: string;
    };
    expect(done.content).toMatch(/^Veo una imagen image\/jpeg de \d+ bytes\.$/);
    const content = (anthropicSeen[0]!.body!.messages as Array<{ content: unknown[] }>)[0]!
      .content as Array<{ type: string; source?: { media_type: string; data: string } }>;
    const img = content.find((c) => c.type === 'image')!;
    const bytes = Buffer.from(img.source!.data, 'base64');
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(bytes.includes(Buffer.from('Exif'))).toBe(false);
  });

  it('errores del proveedor: 429 y sobrecarga a mitad de stream → error tipado, sin texto inventado', async () => {
    const h = await consumer();
    for (const text of ['provoca 429', 'provoca sobrecarga']) {
      const conv = await conversation(h);
      const r = await app.inject({
        method: 'POST',
        url: `${P}/conversations/${conv}/messages`,
        headers: h,
        payload: { text },
      });
      const evs = parseSse(r.body);
      expect(evs.some((e) => e.event === 'done')).toBe(false);
      const err = evs.find((e) => e.event === 'error')!;
      expect(err).toBeTruthy();
      expect(JSON.stringify(err.data)).not.toContain(ANT_KEY);
    }
  });
});

describe('voz con el adaptador compatible con OpenAI (servidor de contrato)', () => {
  it('transcripción: multipart con el archivo, modelo e idioma; el texto vuelve recortado', async () => {
    const h = await consumer();
    const up = await app.inject({
      method: 'POST',
      url: `${P}/attachments`,
      headers: { ...h, 'content-type': 'application/octet-stream', 'x-attachment-kind': 'audio' },
      payload: fx('tone.webm'),
    });
    expect(up.statusCode).toBe(201);
    speechSeen.length = 0;
    const t = await app.inject({
      method: 'POST',
      url: `${P}/transcriptions`,
      headers: h,
      payload: { attachment_id: up.json().id },
    });
    expect(t.statusCode).toBe(200);
    expect(t.json()).toMatchObject({ simulated: false });
    expect(t.json().text).toBe(`Texto transcrito de ${fx('tone.webm').length} bytes.`);
    expect(speechSeen[0]!.form).toEqual({
      file: { size: fx('tone.webm').length, type: 'audio/webm', name: 'nota.webm' },
      fields: { model: 'stt-contrato', language: 'es' },
    });
  });

  it('respuesta hablada: JSON con modelo, voz y formato wav; el WAV llega intacto', async () => {
    const h = await consumer();
    speechSeen.length = 0;
    const r = await app.inject({
      method: 'POST',
      url: `${P}/speech`,
      headers: h,
      payload: { text: 'Tu saldo disponible es de 100 VES.' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('audio/wav');
    expect(r.headers['x-fluvia-simulated']).toBe('false');
    expect(r.rawPayload.equals(TTS_WAV)).toBe(true);
    expect(speechSeen[0]!.body).toEqual({
      model: 'tts-contrato',
      voice: 'voz-contrato',
      input: 'Tu saldo disponible es de 100 VES.',
      response_format: 'wav',
    });
  });
});
