import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  Room,
  RoomEvent,
  TrackKind,
} from '@livekit/rtc-node';
import { signLiveKitToken } from '@fluvia/assistant';
import { RATE, rms } from '../src/audio.js';
import { TOPIC, type AgentToUser } from '../src/protocol.js';
import { CallSession } from '../src/session.js';
import { agentSpeech } from '../src/speech.js';

/**
 * Fallo DETERMINISTA del envío de audio del agente (captureFrame) durante una
 * llamada real (servidor LiveKit local). Demuestra que:
 *  - esa frase falla y la persona recibe el aviso (y «speaking: false»);
 *  - la MISMA llamada vuelve a hablar con normalidad;
 *  - una SEGUNDA llamada en el mismo proceso funciona;
 *  - ningún rechazo llega al manejador global (cada sesión limpia el suyo).
 * Requiere `LIVEKIT_TEST_URL`; si no está, se omite.
 */
const URL = process.env.LIVEKIT_TEST_URL;
const KEY = process.env.LIVEKIT_TEST_API_KEY ?? 'fluviadev';
const SECRET =
  process.env.LIVEKIT_TEST_API_SECRET ?? 'fluvia-dev-secret-solo-local-0123456789abcdef';

/** Falla UNA vez, en la trama número `failAt` de la primera frase. */
class FaultyOnceSource extends AudioSource {
  private n = 0;
  failed = false;
  constructor(private readonly failAt: number) {
    super(RATE, 1);
  }
  override async captureFrame(frame: AudioFrame): Promise<void> {
    if (!this.failed && ++this.n === this.failAt) {
      this.failed = true;
      throw new Error('an RtcError occurred: InvalidState - failed to capture frame (inyectado)');
    }
    return super.captureFrame(frame);
  }
}

let unhandled = 0;
const onUnhandled = () => unhandled++;
process.on('unhandledRejection', onUnhandled);
const sessions: CallSession[] = [];
const rooms: Room[] = [];
afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  await Promise.all(rooms.map((r) => r.disconnect().catch(() => undefined)));
  await Promise.all(sessions.map((s) => s.close('test_end')));
});

async function call(createSource?: () => AudioSource) {
  const roomName = `fluvia-personal-${randomUUID()}`;
  const identity = `consumer:${randomUUID()}`;
  const logs: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const session = new CallSession({
    url: URL!,
    apiKey: KEY,
    apiSecret: SECRET,
    room: roomName,
    userIdentity: identity,
    maxSeconds: 120,
    speech: agentSpeech({}),
    log: (msg, extra) => logs.push({ msg, extra }),
    createSource,
  });
  sessions.push(session);
  await session.start();
  const room = new Room();
  rooms.push(room);
  const received: AgentToUser[] = [];
  room.on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
    if (topic === TOPIC)
      received.push(JSON.parse(new TextDecoder().decode(payload)) as AgentToUser);
  });
  const level = { max: 0 };
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (participant.identity !== 'agente-fluvia' || track.kind !== TrackKind.KIND_AUDIO) return;
    void (async () => {
      for await (const f of new AudioStream(track, 48_000, 1))
        level.max = Math.max(level.max, rms(f.data));
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
  const say = (text: string) =>
    room.localParticipant!.publishData(
      new TextEncoder().encode(JSON.stringify({ t: 'say', text })),
      {
        reliable: true,
        topic: TOPIC,
        destination_identities: ['agente-fluvia'],
      }
    );
  await waitFor(() => received.some((m) => m.t === 'hello'), 10_000, 'hello');
  return { session, room, received, level, logs, waitFor, say };
}

const count = (rs: AgentToUser[], pred: (m: AgentToUser) => boolean) => rs.filter(pred).length;

describe.skipIf(!URL)('fallo de envío de audio del agente (inyectado, determinista)', () => {
  it('falla esa frase; la misma llamada y una segunda llamada siguen funcionando', async () => {
    const faulty = new FaultyOnceSource(5);
    const a = await call(() => faulty);

    // 1) Primera frase: el envío falla en la trama 5.
    await a.say('Esta frase va a fallar a mitad.');
    await a.waitFor(
      () => a.received.some((m) => m.t === 'error' && m.code === 'tts_failed'),
      10_000,
      'aviso de fallo'
    );
    await a.waitFor(
      () => count(a.received, (m) => m.t === 'speaking' && !m.on) >= 1,
      5_000,
      'speaking off tras el fallo'
    );
    expect(faulty.failed).toBe(true);
    expect(a.logs.some((l) => l.msg === 'session task failed' && l.extra?.task === 'say')).toBe(
      true
    );

    // 2) La MISMA llamada vuelve a hablar y termina normalmente.
    const ons = count(a.received, (m) => m.t === 'speaking' && m.on);
    const offs = count(a.received, (m) => m.t === 'speaking' && !m.on);
    a.level.max = 0;
    await a.say('Ahora sí: tu saldo disponible es de cien bolívares.');
    await a.waitFor(
      () => count(a.received, (m) => m.t === 'speaking' && m.on) > ons,
      10_000,
      'habla de nuevo'
    );
    await a.waitFor(
      () => count(a.received, (m) => m.t === 'speaking' && !m.on) > offs,
      15_000,
      'termina la frase'
    );
    expect(a.level.max).toBeGreaterThan(0.05);
    expect(count(a.received, (m) => m.t === 'error')).toBe(1);

    // 3) Una SEGUNDA llamada en el mismo proceso funciona.
    const b = await call();
    await b.say('Segunda llamada.');
    await b.waitFor(
      () => b.received.some((m) => m.t === 'speaking' && !m.on),
      15_000,
      'segunda llamada habla'
    );
    expect(b.level.max).toBeGreaterThan(0.05);
    expect(count(b.received, (m) => m.t === 'error')).toBe(0);

    // 4) Nada llegó al manejador global: cada sesión capturó y limpió lo suyo.
    expect(unhandled).toBe(0);
  }, 90_000);
});
