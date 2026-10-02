import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { signLiveKitToken } from '@fluvia/assistant';
import { decodeWav, encodeWav, rms } from '../src/audio.js';
import { TOPIC, type AgentToUser } from '../src/protocol.js';

/**
 * El agente con los adaptadores REALES de voz (compatibles con OpenAI) contra
 * un servidor de CONTRATO local: la transcripción del turno viene del
 * proveedor (no de prueba) y la voz del agente es el WAV del proveedor,
 * recibido por WebRTC. No prueba la calidad de un proveedor real.
 * Requiere `LIVEKIT_TEST_URL`; si no está, se omite.
 */
const URL = process.env.LIVEKIT_TEST_URL;
const KEY = process.env.LIVEKIT_TEST_API_KEY ?? 'fluviadev';
const SECRET =
  process.env.LIVEKIT_TEST_API_SECRET ?? 'fluvia-dev-secret-solo-local-0123456789abcdef';
const CONTROL = 'test-control-secret-contrato-0123456789';
const PORT = 33967;
const SP_KEY = 'voz-clave-contrato-solo-prueba';

const seen: Array<{ path: string; wavSeconds?: number; body?: Record<string, unknown> }> = [];
const TTS = (() => {
  const rate = 24_000;
  const pcm = new Int16Array(rate); // 1 s a 24 kHz: el agente remuestrea a 48 kHz
  for (let i = 0; i < pcm.length; i++)
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 300 * i) / rate) * 10_000);
  return encodeWav(pcm, rate);
})();

let server: Server;
let agent: ChildProcess;

beforeAll(async () => {
  if (!URL) return;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      if (req.headers.authorization !== `Bearer ${SP_KEY}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.url === '/v1/audio/transcriptions') {
        const form = await new Response(raw, {
          headers: { 'content-type': String(req.headers['content-type']) },
        }).formData();
        const file = form.get('file') as File;
        const w = decodeWav(Buffer.from(await file.arrayBuffer()));
        seen.push({ path: req.url, wavSeconds: w.pcm.length / w.sampleRate });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: '¿Cuánto tengo disponible?' }));
        return;
      }
      if (req.url === '/v1/audio/speech') {
        seen.push({ path: req.url, body: JSON.parse(raw.toString('utf8')) });
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(TTS);
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  agent = spawn(process.execPath, ['--import', 'tsx', resolve(__dirname, '../src/main.ts')], {
    env: {
      ...process.env,
      LIVEKIT_INTERNAL_URL: URL,
      LIVEKIT_API_KEY: KEY,
      LIVEKIT_API_SECRET: SECRET,
      AGENT_CONTROL_SECRET: CONTROL,
      AGENT_PORT: String(PORT),
      ASSISTANT_SPEECH_PROVIDER: 'openai_compatible',
      SPEECH_API_KEY: SP_KEY,
      SPEECH_BASE_URL: base,
      SPEECH_STT_MODEL: 'stt-contrato',
      SPEECH_TTS_MODEL: 'tts-contrato',
      SPEECH_TTS_VOICE: 'voz-contrato',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`http://127.0.0.1:${PORT}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('agent did not start');
}, 30_000);

afterAll(async () => {
  agent?.kill('SIGTERM');
  await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
});

describe.skipIf(!URL)('agente con voz de proveedor (contrato local) por WebRTC', () => {
  it('transcripción del proveedor y voz del proveedor audible en la sala', async () => {
    const roomName = `fluvia-commerce-${randomUUID()}`;
    const identity = `user:${randomUUID()}`;
    const join = await fetch(`http://127.0.0.1:${PORT}/join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CONTROL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ room: roomName, identity }),
    });
    expect(join.status).toBe(200);
    const room = new Room();
    const received: AgentToUser[] = [];
    room.on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
      if (topic === TOPIC)
        received.push(JSON.parse(new TextDecoder().decode(payload)) as AgentToUser);
    });
    let agentLevel = 0;
    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (participant.identity !== 'agente-fluvia' || track.kind !== TrackKind.KIND_AUDIO) return;
      void (async () => {
        for await (const f of new AudioStream(track, 48_000, 1))
          agentLevel = Math.max(agentLevel, rms(f.data));
      })();
    });
    const { token } = signLiveKitToken(
      { apiKey: KEY, apiSecret: SECRET },
      { room: roomName, identity, ttlSeconds: 120 }
    );
    await room.connect(URL!, token, { autoSubscribe: true, dynacast: false });
    const waitFor = async (pred: () => boolean, ms: number, what: string) => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timeout: ${what} · ${JSON.stringify(received)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await waitFor(() => received.some((m) => m.t === 'hello'), 10_000, 'hello');
    const hello = received.find((m) => m.t === 'hello') as Extract<AgentToUser, { t: 'hello' }>;
    expect(hello).toMatchObject({
      test: false,
      stt: { provider: 'openai_compatible', simulated: false },
      tts: { provider: 'openai_compatible', simulated: false },
    });

    const source = new AudioSource(48_000, 1);
    await room.localParticipant!.publishTrack(
      LocalAudioTrack.createAudioTrack('mic', source),
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })
    );
    // 600 ms de silencio (calentamiento) + 1,2 s de voz + 1,2 s de silencio.
    const rate = 48_000;
    const pcm = new Int16Array(rate * 3);
    for (let i = rate * 0.6; i < rate * 1.8; i++)
      pcm[i] = Math.round(Math.sin((2 * Math.PI * 200 * i) / rate) * 9000);
    for (let o = 0; o < pcm.length; o += 480) {
      const c = pcm.subarray(o, o + 480);
      await source.captureFrame(new AudioFrame(Int16Array.from(c), rate, 1, c.length));
    }
    await waitFor(() => received.some((m) => m.t === 'transcript'), 15_000, 'transcript');
    const tr = received.find((m) => m.t === 'transcript') as Extract<
      AgentToUser,
      { t: 'transcript' }
    >;
    expect(tr).toMatchObject({ text: '¿Cuánto tengo disponible?', simulated: false });
    // El proveedor recibió el turno como WAV a 16 kHz con la duración de la voz.
    const stt = seen.find((s) => s.path === '/v1/audio/transcriptions')!;
    expect(stt.wavSeconds!).toBeGreaterThan(1.1);
    expect(stt.wavSeconds!).toBeLessThan(2.6);

    await room.localParticipant!.publishData(
      new TextEncoder().encode(JSON.stringify({ t: 'say', text: 'Tienes 100 VES.' })),
      { reliable: true, topic: TOPIC, destination_identities: ['agente-fluvia'] }
    );
    await waitFor(() => agentLevel > 0.1, 10_000, 'voz del proveedor');
    expect(seen.find((s) => s.path === '/v1/audio/speech')!.body).toEqual({
      model: 'tts-contrato',
      voice: 'voz-contrato',
      input: 'Tienes 100 VES.',
      response_format: 'wav',
    });
    await room.localParticipant!.publishData(new TextEncoder().encode('{"t":"bye"}'), {
      reliable: true,
      topic: TOPIC,
      destination_identities: ['agente-fluvia'],
    });
    await waitFor(() => !room.remoteParticipants.has('agente-fluvia'), 10_000, 'agente sale');
    await room.disconnect();
    await source.close();
  }, 60_000);
});
