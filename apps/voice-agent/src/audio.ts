/**
 * Utilidades de audio del agente (PCM 16 bit, mono): segmentación de turnos
 * por energía, WAV y tono de prueba. Sin dependencias: se prueban sin WebRTC.
 */

export const RATE = 48_000;

export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let s = 0;
  for (const v of pcm) s += (v / 32768) ** 2;
  return Math.sqrt(s / pcm.length);
}

export interface TurnEvents {
  /** La persona empezó a hablar (para la interrupción / barge-in). */
  onSpeechStart(): void;
  /** Turno completo: audio desde el inicio de la voz hasta el silencio final. */
  onUtterance(pcm: Int16Array, sampleRate: number): void;
}

/**
 * Detector de turnos por energía, ADAPTATIVO y con histéresis:
 *  - el umbral sigue al ruido de fondo (×`noiseFactor`, acotado entre
 *    `minThreshold` y `maxThreshold`): la voz atenuada por la supresión de
 *    ruido del navegador se detecta y un ventilador constante no es voz;
 *  - voz = ≥ `minSpeechMs` de energía sobre el umbral (los valles breves de
 *    la voz procesada restan, no reinician);
 *  - fin del turno = `silenceMs` seguidos bajo el 60 % del umbral;
 *  - los primeros 500 ms solo aprenden el ruido (nada es voz todavía);
 *  - un turno nunca supera `maxUtteranceMs` (se corta y se entrega).
 */
export interface TurnOptions {
  minThreshold: number;
  maxThreshold: number;
  noiseFactor: number;
  minSpeechMs: number;
  silenceMs: number;
  maxUtteranceMs: number;
}

export const DEFAULT_TURN_OPTIONS: TurnOptions = {
  minThreshold: 0.008,
  maxThreshold: 0.05,
  noiseFactor: 3,
  minSpeechMs: 200,
  silenceMs: 700,
  maxUtteranceMs: 30_000,
};

const WARMUP_MS = 500;

export class TurnDetector {
  private buf: Int16Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private inSpeech = false;
  private totalMs = 0;
  private preRoll: Int16Array[] = [];
  private noise = 0;
  private warmMs = 0;
  private readonly opts: TurnOptions;

  constructor(
    private readonly events: TurnEvents,
    opts: Partial<TurnOptions> = {}
  ) {
    this.opts = { ...DEFAULT_TURN_OPTIONS, ...opts };
  }

  /** Umbral de voz actual (para pruebas y diagnóstico). */
  get threshold(): number {
    const { minThreshold, maxThreshold, noiseFactor } = this.opts;
    return Math.min(maxThreshold, Math.max(minThreshold, this.noise * noiseFactor));
  }

  push(pcm: Int16Array, sampleRate: number): void {
    const ms = (pcm.length / sampleRate) * 1000;
    const level = rms(pcm);
    // Calentamiento: los primeros 500 ms solo aprenden el ruido de fondo.
    if (this.warmMs < WARMUP_MS) {
      this.warmMs += ms;
      this.noise += (level - this.noise) * Math.min(1, ms / this.warmMs);
      return;
    }
    const threshold = this.threshold;
    if (!this.inSpeech) {
      // Ruido de fondo: media lenta (~2 s) de lo que no es voz; si sube y se
      // mantiene, el umbral la sigue más despacio (~16 s).
      const a = Math.min(1, ms / 2000) / (level < threshold ? 1 : 8);
      this.noise = this.noise * (1 - a) + level * a;
      this.preRoll.push(pcm);
      if (this.preRoll.length > 20) this.preRoll.shift();
      this.speechMs = level >= threshold ? this.speechMs + ms : Math.max(0, this.speechMs - ms);
      if (this.speechMs >= this.opts.minSpeechMs) {
        this.inSpeech = true;
        this.buf = [...this.preRoll];
        this.preRoll = [];
        this.totalMs = this.speechMs;
        this.silenceMs = 0;
        this.events.onSpeechStart();
      }
      return;
    }
    this.buf.push(pcm);
    this.totalMs += ms;
    this.silenceMs = level >= threshold * 0.6 ? 0 : this.silenceMs + ms;
    if (this.silenceMs >= this.opts.silenceMs || this.totalMs >= this.opts.maxUtteranceMs) {
      const n = this.buf.reduce((a, b) => a + b.length, 0);
      const out = new Int16Array(n);
      let o = 0;
      for (const c of this.buf) {
        out.set(c, o);
        o += c.length;
      }
      this.buf = [];
      this.inSpeech = false;
      this.speechMs = 0;
      this.silenceMs = 0;
      this.totalMs = 0;
      this.events.onUtterance(out, sampleRate);
    }
  }
}

export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** WAV PCM 16 bit → muestras mono (mezcla los canales si hay varios). */
export function decodeWav(b: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let i = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4);
    const len = b.readUInt32LE(i + 4);
    if (id === 'fmt ') {
      channels = b.readUInt16LE(i + 10);
      rate = b.readUInt32LE(i + 12);
      bits = b.readUInt16LE(i + 22);
    } else if (id === 'data') {
      if (bits !== 16 || !rate) throw new Error('unsupported WAV');
      // Algunos proveedores emiten un tamaño 0xffffffff en streaming.
      const end = Math.min(b.length, i + 8 + (len === 0xffffffff ? b.length : len));
      const frames = Math.floor((end - i - 8) / (2 * channels));
      const pcm = new Int16Array(frames);
      for (let f = 0; f < frames; f++) {
        let acc = 0;
        for (let c = 0; c < channels; c++) acc += b.readInt16LE(i + 8 + (f * channels + c) * 2);
        pcm[f] = Math.round(acc / channels);
      }
      return { pcm, sampleRate: rate };
    }
    i += 8 + len + (len % 2);
  }
  throw new Error('WAV without data');
}

/** Remuestreo lineal (suficiente para voz). */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm;
  const n = Math.floor((pcm.length * to) / from);
  const out = new Int16Array(n);
  for (let k = 0; k < n; k++) {
    const x = (k * from) / to;
    const i = Math.floor(x);
    const f = x - i;
    const a = pcm[i] ?? 0;
    const b = pcm[i + 1] ?? a;
    out[k] = Math.round(a + (b - a) * f);
  }
  return out;
}

/**
 * Voz de PRUEBA del agente: una secuencia de tonos con envolvente, de
 * duración proporcional al texto (máx. 6 s). No pretende ser habla.
 */
export function testVoice(text: string, sampleRate = RATE): Int16Array {
  const seconds = Math.min(6, 0.6 + text.length / 45);
  const n = Math.round(sampleRate * seconds);
  const out = new Int16Array(n);
  const syll = Math.round(sampleRate * 0.18);
  for (let k = 0; k < n; k++) {
    const s = Math.floor(k / syll);
    const inSyll = k % syll;
    const env = Math.sin((Math.PI * inSyll) / syll);
    const f = 180 + (s % 5) * 35;
    out[k] = Math.round(Math.sin((2 * Math.PI * f * k) / sampleRate) * 9000 * env);
  }
  return out;
}
