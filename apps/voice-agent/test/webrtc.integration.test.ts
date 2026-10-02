import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { rms } from '../src/audio.js';
import { TOPIC, type AgentToUser } from '../src/protocol.js';

/**
 * Integración WebRTC REAL (servidor LiveKit local + agente + cliente
 * rtc-node como persona). Requiere `LIVEKIT_TEST_URL` (p. ej.
 * ws://127.0.0.1:3363) y las claves del servidor; si no están, se omite.
 * No usa proveedores externos: STT/TTS de PRUEBA del agente.
 */
const URL = process.env.LIVEKIT_TEST_URL;
const KEY = process.env.LIVEKIT_TEST_API_KEY ?? 'fluviadev';
const SECRET =
  process.env.LIVEKIT_TEST_API_SECRET ?? 'fluvia-dev-secret-solo-local-0123456789abcdef';
const CONTROL = 'test-control-secret-0123456789abcdef';
const PORT = 33966;

let agent: ChildProcess;

beforeAll(async () => {
  if (!URL) return;
  agent = spawn(process.execPath, ['--import', 'tsx', resolve(__dirname, '../src/main.ts')], {
    env: {
      ...process.env,
      LIVEKIT_INTERNAL_URL: URL,
      LIVEKIT_API_KEY: KEY,
      LIVEKIT_API_SECRET: SECRET,
      AGENT_CONTROL_SECRET: CONTROL,
      AGENT_PORT: String(PORT),
      ASSISTANT_SPEECH_PROVIDER: '',
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

afterAll(() => {
  agent?.kill('SIGTERM');
});

function speechLike(): Int16Array {
  // 1,2 s de «voz» (tono modulado), 1,2 s de silencio, 1,2 s de «voz».
  const rate = 48_000;
  const seg = (ms: number, on: boolean) => {
    const n = Math.round((rate * ms) / 1000);
    const a = new Int16Array(n);
    if (on)
      for (let i = 0; i < n; i++)
        a[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 9000);
    return a;
  };
  const parts = [seg(1200, true), seg(1200, false), seg(1200, true), seg(1500, false)];
  const out = new Int16Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe.skipIf(!URL)('llamada WebRTC real con el agente de prueba', () => {
  it('conecta, transcribe un turno, habla con audio real, se calla al ser interrumpido y sale al colgar', async () => {
    const roomName = `fluvia-personal-${randomUUID()}`;
    const identity = `consumer:${randomUUID()}`;
    const join = await fetch(`http://127.0.0.1:${PORT}/join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CONTROL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ room: roomName, identity }),
    });
    expect(join.status).toBe(200);
    // Sin secreto: rechazado.
    const bad = await fetch(`http://127.0.0.1:${PORT}/join`, {
      method: 'POST',
      body: JSON.stringify({ room: roomName, identity }),
    });
    expect(bad.status).toBe(401);

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
        if (Date.now() > end)
          throw new Error(`timeout: ${what} · recibido ${JSON.stringify(received)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await waitFor(() => received.some((m) => m.t === 'hello'), 10_000, 'hello');
    const hello = received.find((m) => m.t === 'hello') as Extract<AgentToUser, { t: 'hello' }>;
    expect(hello.test).toBe(true);

    // La persona habla por WebRTC.
    const source = new AudioSource(48_000, 1);
    const mic = LocalAudioTrack.createAudioTrack('mic', source);
    await room.localParticipant!.publishTrack(
      mic,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })
    );
    const pcm = speechLike();
    const pushAudio = async (from: number, to: number) => {
      for (let o = from; o < to; o += 480) {
        const c = pcm.subarray(o, Math.min(o + 480, to));
        await source.captureFrame(new AudioFrame(Int16Array.from(c), 48_000, 1, c.length));
      }
    };
    await pushAudio(0, 48_000 * 2.4); // primer turno + silencio
    await waitFor(() => received.some((m) => m.t === 'transcript'), 15_000, 'transcript');
    const tr = received.find((m) => m.t === 'transcript') as Extract<
      AgentToUser,
      { t: 'transcript' }
    >;
    expect(tr.simulated).toBe(true);
    expect(tr.seconds).toBeGreaterThan(0.8);

    // El navegador pediría la respuesta al asistente; aquí se la enviamos.
    await room.localParticipant!.publishData(
      new TextEncoder().encode(
        JSON.stringify({
          t: 'say',
          text: 'Tu saldo disponible es de veinticinco mil bolívares. ¿Algo más?',
        })
      ),
      { reliable: true, topic: TOPIC, destination_identities: ['agente-fluvia'] }
    );
    await waitFor(() => received.some((m) => m.t === 'speaking' && m.on), 10_000, 'speaking');
    await waitFor(() => agentLevel > 0.05, 10_000, 'audio del agente');

    // Interrupción: la persona vuelve a hablar mientras el agente habla.
    await pushAudio(48_000 * 2.4, pcm.length);
    await waitFor(() => received.some((m) => m.t === 'interrupted'), 10_000, 'interrupted');

    // Colgar: el agente sale de la sala.
    await room.localParticipant!.publishData(
      new TextEncoder().encode(JSON.stringify({ t: 'bye' })),
      {
        reliable: true,
        topic: TOPIC,
        destination_identities: ['agente-fluvia'],
      }
    );
    await waitFor(() => !room.remoteParticipants.has('agente-fluvia'), 10_000, 'agente sale');
    await room.disconnect();
    await source.close();
    const health = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as {
      sessions: number;
    };
    expect(health.sessions).toBe(0);
  }, 60_000);
});
