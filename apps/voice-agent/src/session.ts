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
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';
import { signLiveKitToken } from '@fluvia/assistant';
import { RATE, TurnDetector, decodeWav, encodeWav, resample, testVoice } from './audio.js';
import { TOPIC, encode, parseUserMessage, type AgentToUser } from './protocol.js';
import type { AgentSpeech } from './speech.js';

/**
 * Una llamada: el agente entra en UNA sala, escucha SOLO a la persona que la
 * API autorizó (identidad esperada), transcribe cada turno, publica la
 * transcripción por el canal de datos y dice la respuesta que le envía el
 * navegador. Si la persona habla mientras el agente habla, el agente se calla
 * (interrupción). Sale de la sala al colgar, si la persona se va o al llegar
 * a la duración máxima, y libera todos los recursos.
 */
/** Si la persona no entra en la sala en este tiempo, el agente sale. */
const JOIN_TIMEOUT_MS = 60_000;
/** Margen para que la persona vuelva tras perder la conexión. */
const REJOIN_GRACE_MS = 20_000;

export class CallSession {
  private readonly room = new Room();
  private source: AudioSource | null = null;
  private speaking = false;
  private speakToken = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(
    private readonly cfg: {
      url: string;
      apiKey: string;
      apiSecret: string;
      room: string;
      userIdentity: string;
      maxSeconds: number;
      speech: AgentSpeech;
      log: (msg: string, extra?: Record<string, unknown>) => void;
    }
  ) {
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  async start(): Promise<void> {
    const { token } = signLiveKitToken(
      { apiKey: this.cfg.apiKey, apiSecret: this.cfg.apiSecret },
      { room: this.cfg.room, identity: 'agente-fluvia', ttlSeconds: 300 }
    );
    this.room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) =>
      this.onTrack(track, participant)
    );
    this.room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== TOPIC || participant?.identity !== this.cfg.userIdentity) return;
      const m = parseUserMessage(payload);
      if (m?.t === 'say') void this.say(m.text);
      if (m?.t === 'bye') void this.close('bye');
    });
    // El saludo se envía cuando la persona está en la sala (un mensaje
    // dirigido a quien aún no ha entrado se perdería).
    this.room.on(RoomEvent.ParticipantConnected, (p) => {
      if (p.identity !== this.cfg.userIdentity) return;
      // Vuelve tras una reconexión completa: la llamada sigue.
      if (this.leftTimer) {
        clearTimeout(this.leftTimer);
        this.leftTimer = null;
        this.cfg.log('user rejoined', { room: this.cfg.room });
      }
      void this.greet();
    });
    this.room.on(RoomEvent.ParticipantDisconnected, (p) => {
      if (p.identity !== this.cfg.userIdentity || this.leftTimer) return;
      // Una reconexión completa del navegador sale y vuelve a entrar con la
      // misma identidad: se espera un margen antes de dar la llamada por
      // terminada. Colgar de verdad envía «bye» y cierra al instante.
      this.leftTimer = setTimeout(() => void this.close('user_left'), REJOIN_GRACE_MS);
    });
    this.room.on(RoomEvent.Disconnected, () => void this.close('disconnected'));

    await this.room.connect(this.cfg.url, token, { autoSubscribe: true, dynacast: false });
    this.source = new AudioSource(RATE, 1);
    const track = LocalAudioTrack.createAudioTrack('fluvia-voz', this.source);
    await this.room.localParticipant!.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })
    );
    this.timer = setTimeout(() => {
      void this.send({ t: 'error', code: 'max_duration' }).finally(() =>
        this.close('max_duration')
      );
    }, this.cfg.maxSeconds * 1000);
    if (this.room.remoteParticipants.has(this.cfg.userIdentity)) await this.greet();
    else
      this.joinTimer = setTimeout(() => {
        if (!this.greeted) void this.close('user_never_joined');
      }, JOIN_TIMEOUT_MS);
    this.cfg.log('agent joined', { room: this.cfg.room });
  }

  private greeted = false;
  private joinTimer: NodeJS.Timeout | null = null;
  private leftTimer: NodeJS.Timeout | null = null;
  private async greet(): Promise<void> {
    if (this.greeted) return;
    this.greeted = true;
    if (this.joinTimer) clearTimeout(this.joinTimer);
    await this.send({
      t: 'hello',
      agent: 'agente-fluvia',
      test: this.cfg.speech.stt.simulated && this.cfg.speech.tts.simulated,
      stt: { provider: this.cfg.speech.stt.name, simulated: this.cfg.speech.stt.simulated },
      tts: { provider: this.cfg.speech.tts.name, simulated: this.cfg.speech.tts.simulated },
      maxSeconds: this.cfg.maxSeconds,
    });
  }

  private async send(m: AgentToUser): Promise<void> {
    if (this.closed || !this.room.localParticipant) return;
    await this.room.localParticipant
      .publishData(encode(m), {
        reliable: true,
        topic: TOPIC,
        destination_identities: [this.cfg.userIdentity],
      })
      .catch(() => undefined);
  }

  private onTrack(track: RemoteTrack, participant: RemoteParticipant): void {
    // Solo el audio de la persona autorizada; cámara o pantalla se ignoran.
    if (participant.identity !== this.cfg.userIdentity || track.kind !== TrackKind.KIND_AUDIO)
      return;
    const detector = new TurnDetector({
      onSpeechStart: () => {
        this.cfg.log('speech start', { room: this.cfg.room, agentSpeaking: this.speaking });
        void this.send({ t: 'speech_start' });
        if (this.speaking) this.interrupt();
      },
      onUtterance: (pcm, rate) => {
        this.cfg.log('turn', { room: this.cfg.room, seconds: +(pcm.length / rate).toFixed(2) });
        void this.transcribe(pcm, rate);
      },
    });
    void (async () => {
      const stream = new AudioStream(track, RATE, 1);
      for await (const frame of stream) {
        if (this.closed) break;
        detector.push(frame.data, frame.sampleRate);
      }
    })();
  }

  private interrupt(): void {
    this.speakToken++;
    this.source?.clearQueue();
    this.speaking = false;
    void this.send({ t: 'interrupted' });
    void this.send({ t: 'speaking', on: false });
  }

  private async transcribe(pcm: Int16Array, rate: number): Promise<void> {
    const seconds = Math.round((pcm.length / rate) * 10) / 10;
    try {
      const wav = encodeWav(resample(pcm, rate, 16_000), 16_000);
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 30_000);
      const r = await this.cfg.speech.stt
        .transcribe({ data: wav, mime: 'audio/wav', durationMs: seconds * 1000 }, ac.signal)
        .finally(() => clearTimeout(t));
      const text = this.cfg.speech.stt.simulated
        ? `[Transcripción de prueba del agente: ${seconds.toLocaleString('es')} s de voz]`
        : r.text;
      await this.send({ t: 'transcript', text, seconds, simulated: this.cfg.speech.stt.simulated });
    } catch {
      await this.send({ t: 'error', code: 'stt_failed' });
    }
  }

  private async say(text: string): Promise<void> {
    if (!this.source || this.closed) return;
    const my = ++this.speakToken;
    let pcm: Int16Array;
    try {
      if (this.cfg.speech.tts.simulated) {
        pcm = testVoice(text, RATE);
      } else {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 30_000);
        const audio = await this.cfg.speech.tts
          .synthesize(text, ac.signal)
          .finally(() => clearTimeout(t));
        const w = decodeWav(audio.data);
        pcm = resample(w.pcm, w.sampleRate, RATE);
      }
    } catch {
      await this.send({ t: 'error', code: 'tts_failed' });
      return;
    }
    if (my !== this.speakToken) return;
    this.speaking = true;
    await this.send({ t: 'speaking', on: true });
    const step = RATE / 100; // tramas de 10 ms
    for (let o = 0; o < pcm.length; o += step) {
      if (my !== this.speakToken || this.closed) return;
      const chunk = pcm.subarray(o, Math.min(o + step, pcm.length));
      const frame = new AudioFrame(Int16Array.from(chunk), RATE, 1, chunk.length);
      await this.source.captureFrame(frame);
    }
    await this.source.waitForPlayout().catch(() => undefined);
    if (my === this.speakToken) {
      this.speaking = false;
      await this.send({ t: 'speaking', on: false });
    }
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.speakToken++;
    if (this.timer) clearTimeout(this.timer);
    if (this.joinTimer) clearTimeout(this.joinTimer);
    if (this.leftTimer) clearTimeout(this.leftTimer);
    try {
      this.source?.clearQueue();
      await this.source?.close();
    } catch {
      /* ya cerrado */
    }
    await this.room.disconnect().catch(() => undefined);
    this.cfg.log('agent left', { room: this.cfg.room, reason });
    this.resolveDone();
  }
}
