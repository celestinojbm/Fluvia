import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { IDENTITY_RE, ROOM_RE } from './protocol.js';
import { CallSession } from './session.js';
import { agentSpeech } from './speech.js';

/**
 * Agente de voz de Fluvia (proceso aparte, aislado).
 *
 * Control: HTTP SOLO en loopback, con secreto compartido con la API
 * (`AGENT_CONTROL_SECRET`). La API lo llama al emitir el token de la persona:
 * `POST /join {room, identity}`. El agente firma su propio token de LiveKit
 * para esa sala y no tiene ninguna credencial de Fluvia.
 */
const env = process.env;
const need = (k: string) => {
  const v = env[k];
  if (!v) {
    console.error(`[voice-agent] falta ${k}`);
    process.exit(2);
  }
  return v;
};
const LIVEKIT_URL = need('LIVEKIT_INTERNAL_URL');
const API_KEY = need('LIVEKIT_API_KEY');
const API_SECRET = need('LIVEKIT_API_SECRET');
const SECRET = need('AGENT_CONTROL_SECRET');
const HOST = env.AGENT_HOST ?? '127.0.0.1';
const PORT = Number(env.AGENT_PORT ?? 3366);
const MAX_SESSIONS = Number(env.AGENT_MAX_SESSIONS ?? 4);
const MAX_SECONDS = Math.min(Number(env.ASSISTANT_MAX_CALL_SECONDS ?? 600), 3600);
if (SECRET.length < 24) {
  console.error('[voice-agent] AGENT_CONTROL_SECRET demasiado corto (≥ 24)');
  process.exit(2);
}
const speech = agentSpeech(env);
const sessions = new Map<string, CallSession>();
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(
    JSON.stringify({ level: 'info', msg, ...extra, t: new Date().toISOString() }) + '\n'
  );

function authorized(req: IncomingMessage): boolean {
  const got = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${SECRET}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return reply(res, 200, {
      ok: true,
      sessions: sessions.size,
      stt: { provider: speech.stt.name, simulated: speech.stt.simulated },
      tts: { provider: speech.tts.name, simulated: speech.tts.simulated },
    });
  }
  // Se descarta el cuerpo de lo que se rechaza para no cortar la conexión.
  if (req.method !== 'POST' || req.url !== '/join') {
    req.resume();
    return reply(res, 404, { error: 'not_found' });
  }
  if (!authorized(req)) {
    req.resume();
    return reply(res, 401, { error: 'unauthorized' });
  }
  let raw = '';
  req.on('data', (c: Buffer) => {
    raw += c.toString('utf8');
    if (raw.length > 2048) req.destroy();
  });
  req.on('end', () => {
    let body: { room?: unknown; identity?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return reply(res, 400, { error: 'invalid_json' });
    }
    const room = typeof body.room === 'string' ? body.room : '';
    const identity = typeof body.identity === 'string' ? body.identity : '';
    if (!ROOM_RE.test(room) || !IDENTITY_RE.test(identity))
      return reply(res, 400, { error: 'invalid' });
    if (sessions.has(room)) return reply(res, 200, { ok: true, already: true });
    if (sessions.size >= MAX_SESSIONS) return reply(res, 503, { error: 'busy' });
    const s = new CallSession({
      url: LIVEKIT_URL,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      room,
      userIdentity: identity,
      maxSeconds: MAX_SECONDS,
      speech,
      log,
    });
    sessions.set(room, s);
    void s.done.then(() => sessions.delete(room));
    s.start().then(
      () => reply(res, 200, { ok: true }),
      (err: unknown) => {
        log('agent join failed', { room, err: String(err) });
        void s.close('join_failed');
        reply(res, 502, { error: 'join_failed' });
      }
    );
  });
});

server.listen(PORT, HOST, () =>
  log('voice agent listening', {
    host: HOST,
    port: PORT,
    stt: speech.stt.name,
    tts: speech.tts.name,
    test: speech.stt.simulated && speech.tts.simulated,
  })
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    server.close();
    await Promise.all([...sessions.values()].map((s) => s.close('shutdown')));
    process.exit(0);
  });
}
