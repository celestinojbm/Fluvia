import { describe, expect, it } from 'vitest';
import { TurnDetector, decodeWav, encodeWav, resample, rms, testVoice } from '../src/audio.js';
import { IDENTITY_RE, ROOM_RE, parseUserMessage } from '../src/protocol.js';

const tone = (ms: number, amp = 8000, rate = 48_000) => {
  const n = Math.round((rate * ms) / 1000);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin((2 * Math.PI * 300 * i) / rate) * amp);
  return a;
};
const silence = (ms: number, rate = 48_000) => new Int16Array(Math.round((rate * ms) / 1000));
const feed = (d: TurnDetector, pcm: Int16Array) => {
  for (let o = 0; o < pcm.length; o += 480) d.push(pcm.subarray(o, o + 480), 48_000);
};

describe('detección de turnos', () => {
  it('voz + silencio = un turno; el inicio de voz se avisa (para la interrupción)', () => {
    const turns: number[] = [];
    let starts = 0;
    const d = new TurnDetector({
      onSpeechStart: () => starts++,
      onUtterance: (pcm, rate) => turns.push(pcm.length / rate),
    });
    feed(d, silence(300));
    feed(d, tone(1200));
    feed(d, silence(900));
    feed(d, tone(800));
    feed(d, silence(900));
    expect(starts).toBe(2);
    expect(turns).toHaveLength(2);
    expect(turns[0]!).toBeGreaterThan(1.2);
    expect(turns[0]!).toBeLessThan(2.4);
  });

  it('un clic corto no es un turno', () => {
    let n = 0;
    const d = new TurnDetector({ onSpeechStart: () => n++, onUtterance: () => n++ });
    feed(d, tone(100));
    feed(d, silence(1000));
    expect(n).toBe(0);
  });
});

describe('WAV y remuestreo', () => {
  it('ida y vuelta', () => {
    const pcm = tone(250, 5000, 16_000);
    const back = decodeWav(encodeWav(pcm, 16_000));
    expect(back.sampleRate).toBe(16_000);
    expect(Array.from(back.pcm)).toEqual(Array.from(pcm));
  });
  it('remuestreo conserva la duración', () => {
    expect(resample(tone(1000, 5000, 16_000), 16_000, 48_000).length).toBe(48_000);
  });
  it('la voz de prueba tiene energía y dura según el texto', () => {
    const v = testVoice('Hola, ¿qué tal?');
    expect(rms(v)).toBeGreaterThan(0.05);
    expect(v.length / 48_000).toBeGreaterThan(0.6);
  });
});

describe('protocolo', () => {
  it('solo acepta mensajes conocidos y salas/identidades de Fluvia', () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(parseUserMessage(enc({ t: 'say', text: 'hola' }))).toEqual({ t: 'say', text: 'hola' });
    expect(parseUserMessage(enc({ t: 'transfer', amount: 1 }))).toBeNull();
    expect(parseUserMessage(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(ROOM_RE.test('fluvia-personal-8a3cc936-0c79-49bb-a95d-f999a16f3e8e')).toBe(true);
    expect(ROOM_RE.test('otra-sala')).toBe(false);
    expect(IDENTITY_RE.test('consumer:8a3cc936-0c79-49bb-a95d-f999a16f3e8e')).toBe(true);
    expect(IDENTITY_RE.test('agente-fluvia')).toBe(false);
  });
});
