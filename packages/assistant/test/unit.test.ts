import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AnthropicConversationProvider,
  MediaRejectedError,
  SimulatedConversationProvider,
  inspectAudio,
  inspectImage,
  loadAssistantLimits,
  loadAssistantProviders,
  redactSecrets,
  resolveActions,
  sanitizeContext,
  signLiveKitToken,
  type StreamEvent,
} from '../src/index.js';

const fx = (n: string) => readFileSync(resolve(__dirname, 'fixtures', n));
const IMG = { maxBytes: 5 * 1024 * 1024, maxPixels: 40_000_000 };
const AUD = { maxBytes: 4 * 1024 * 1024, maxSeconds: 120 };

describe('validación de imágenes (formato real, metadatos)', () => {
  it('JPEG: dimensiones y EXIF eliminado', () => {
    const raw = fx('px-exif.jpg');
    expect(raw.includes(Buffer.from('GPS-LATITUDE'))).toBe(true);
    const r = inspectImage(raw, IMG);
    expect(r).toMatchObject({ mime: 'image/jpeg', width: 64, height: 48 });
    expect(r.clean.includes(Buffer.from('GPS-LATITUDE'))).toBe(false);
    expect(r.clean.includes(Buffer.from('Exif'))).toBe(false);
  });

  it('PNG: dimensiones y comentarios eliminados', () => {
    const r = inspectImage(fx('px.png'), IMG);
    expect(r).toMatchObject({ mime: 'image/png', width: 64, height: 48 });
    expect(r.clean.includes(Buffer.from('secreto'))).toBe(false);
  });

  it('WebP: dimensiones', () => {
    expect(inspectImage(fx('px.webp'), IMG)).toMatchObject({
      mime: 'image/webp',
      width: 40,
      height: 30,
    });
  });

  it('rechaza por contenido, no por nombre: un WAV no es imagen', () => {
    expect(() => inspectImage(fx('tone.wav'), IMG)).toThrow(MediaRejectedError);
  });

  it('rechaza tamaño, píxeles, vacío y truncado', () => {
    const jpg = fx('px-plain.jpg');
    expect(() => inspectImage(jpg, { maxBytes: 10, maxPixels: 1e9 })).toThrow('too_large');
    expect(() => inspectImage(jpg, { maxBytes: 1e9, maxPixels: 100 })).toThrow('too_many_pixels');
    expect(() => inspectImage(Buffer.alloc(0), IMG)).toThrow('empty');
    expect(() => inspectImage(fx('px.png').subarray(0, 40), IMG)).toThrow('malformed');
  });
});

describe('validación de audio (formato y duración leídos del contenedor)', () => {
  it.each([
    ['tone.wav', 'audio/wav', 1500],
    ['tone.ogg', 'audio/ogg', 2000],
    ['tone.webm', 'audio/webm', 2500],
    ['tone.m4a', 'audio/mp4', 3000],
  ])('%s', (file, mime, ms) => {
    const r = inspectAudio(fx(file), AUD);
    expect(r.mime).toBe(mime);
    expect(Math.abs(r.durationMs - ms)).toBeLessThan(120);
  });

  it('WebM de MediaRecorder SIN Duration: se calcula por los bloques', () => {
    const b = Buffer.from(fx('tone.webm'));
    const i = b.indexOf(Buffer.from([0x44, 0x89, 0x88]));
    expect(i).toBeGreaterThan(0);
    // Duration (11 bytes) → elemento Void del mismo tamaño
    b[i] = 0xec;
    b[i + 1] = 0x89;
    b.fill(0, i + 2, i + 11);
    expect(b.indexOf(Buffer.from([0x44, 0x89]))).not.toBe(i);
    const r = inspectAudio(b, AUD);
    expect(Math.abs(r.durationMs - 2500)).toBeLessThan(120);
  });

  it('demasiado larga → too_long', () => {
    expect(() => inspectAudio(fx('long.ogg'), AUD)).toThrow('too_long');
  });

  it('una imagen no es audio', () => {
    expect(() => inspectAudio(fx('px.png'), AUD)).toThrow('unsupported_format');
  });
});

describe('política', () => {
  it('elimina números de tarjeta válidos (Luhn) y CVV del texto', () => {
    const r = redactSecrets('mi tarjeta 4242 4242 4242 4242 y cvv 123, pedido 12345');
    expect(r.redacted).toBe(true);
    expect(r.text).not.toContain('4242 4242');
    expect(r.text).not.toContain('123,');
    expect(r.text).toContain('pedido 12345');
  });

  it('acciones: solo catálogo, solo su superficie, máx. 3', () => {
    const org = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
    expect(
      resolveActions(['personal.cards', 'commerce.pos', 'x', 'public.directory'], 'personal', null)
    ).toEqual([
      { id: 'personal.cards', label: 'Ir a Tarjetas', href: '/personal/tarjetas' },
      { id: 'public.directory', label: 'Dónde comprar', href: '/donde-comprar' },
    ]);
    expect(resolveActions(['commerce.pos'], 'commerce', org)[0]!.href).toBe(`/o/${org}/pos`);
    expect(resolveActions(['commerce.pos'], 'commerce', null)).toEqual([]);
  });

  it('contexto: sin query ni ids; tarea acotada', () => {
    const org = '1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1';
    expect(
      sanitizeContext(
        {
          route: `/o/${org}/payments/8a3cc936-0c79-49bb-a95d-f999a16f3e8e?token=x`,
          task: 'refund',
        },
        org
      )
    ).toEqual({ route: '/o/:org/payments/:id', task: 'refund' });
    expect(sanitizeContext({ route: 'https://evil', task: 'DROP TABLE' }, null)).toEqual({
      route: null,
      task: null,
    });
  });
});

describe('configuración', () => {
  it('sin credenciales completas ⇒ simulado (no hay modelo por defecto)', () => {
    expect(
      loadAssistantProviders({ ASSISTANT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' })
    ).toEqual({
      conversation: { kind: 'simulated' },
      speech: { kind: 'simulated' },
      call: { kind: 'simulated' },
    });
    expect(
      loadAssistantProviders({
        ASSISTANT_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'k',
        ASSISTANT_MODEL: 'm',
      }).conversation.kind
    ).toBe('anthropic');
  });

  it('límites acotados', () => {
    const l = loadAssistantLimits({
      ASSISTANT_MAX_AUDIO_SECONDS: '99999',
      ASSISTANT_MESSAGES_PER_DAY: 'x',
    });
    expect(l.maxAudioSeconds).toBe(600);
    expect(l.messagesPerDay).toBe(200);
  });
});

describe('token de LiveKit', () => {
  it('HS256, una sala, una identidad, vida corta', () => {
    const { token, expiresAt } = signLiveKitToken(
      { apiKey: 'APIkey', apiSecret: 'secret' },
      { room: 'fluvia-abc', identity: 'consumer:1', ttlSeconds: 300, now: 1_700_000_000_000 }
    );
    const [h, p, s] = token.split('.');
    const expected = createHmac('sha256', 'secret')
      .update(`${h}.${p}`)
      .digest('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(s).toBe(expected);
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(payload).toMatchObject({
      iss: 'APIkey',
      sub: 'consumer:1',
      exp: 1_700_000_300,
      video: { room: 'fluvia-abc', roomJoin: true },
    });
    expect(payload.video.roomAdmin).toBeUndefined();
    expect(payload.video.roomRecord).toBeUndefined();
    expect(expiresAt).toBe(1_700_000_300);
  });
});

async function collect(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('proveedor Anthropic (SSE simulado en fetch)', () => {
  it('texto, herramienta con JSON parcial y stop_reason', async () => {
    const sse =
      [
        'event: message_start\ndata: {"type":"message_start","message":{}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hola"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"get_balances","input":{}}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cur"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"rency\\":\\"VES\\"}"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ].join('\n\n') + '\n\n';
    let sent: { headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = {
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      };
      return new Response(sse, { status: 200 });
    }) as unknown as typeof fetch;
    const p = new AnthropicConversationProvider(
      { apiKey: 'k', model: 'm', baseUrl: 'https://x' },
      fetchImpl
    );
    const evs = await collect(
      p.stream(
        {
          system: 's',
          tools: [],
          maxTokens: 100,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
        },
        new AbortController().signal
      )
    );
    expect(evs).toEqual([
      { type: 'text', text: 'Hola' },
      { type: 'tool_call', call: { id: 'tu1', name: 'get_balances', input: { currency: 'VES' } } },
      { type: 'done', stop: 'tool_use' },
    ]);
    expect(sent!.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent!.body.stream).toBe(true);
  });

  it('error en el stream y HTTP 529', async () => {
    const mid = (async () =>
      new Response(
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n'
      )) as unknown as typeof fetch;
    const a = new AnthropicConversationProvider(
      { apiKey: 'k', model: 'm', baseUrl: 'https://x' },
      mid
    );
    const req = { system: '', tools: [], maxTokens: 1, messages: [] };
    expect(await collect(a.stream(req, new AbortController().signal))).toEqual([
      { type: 'error', code: 'overloaded' },
    ]);
    const http = (async () => new Response('x', { status: 529 })) as unknown as typeof fetch;
    const b = new AnthropicConversationProvider(
      { apiKey: 'k', model: 'm', baseUrl: 'https://x' },
      http
    );
    expect(await collect(b.stream(req, new AbortController().signal))).toEqual([
      { type: 'error', code: 'overloaded' },
    ]);
  });
});

describe('proveedor simulado (determinista, etiquetado)', () => {
  const sim = new SimulatedConversationProvider(0);
  const tools = [{ name: 'get_balances', description: '', inputSchema: {} }];
  const ask = (text: string) =>
    collect(
      sim.stream(
        {
          system: '',
          tools,
          maxTokens: 1,
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        },
        new AbortController().signal
      )
    );

  it('mismo input ⇒ misma salida; usa la herramienta de lectura', async () => {
    const a = await ask('¿cuál es mi saldo?');
    expect(a).toEqual(await ask('¿cuál es mi saldo?'));
    expect(a[0]).toMatchObject({ type: 'tool_call', call: { name: 'get_balances' } });
  });

  it('una orden sensible no ejecuta nada: guía a la pantalla', async () => {
    const r = await ask('transfiere 100 a Juan');
    const text = r
      .filter((e) => e.type === 'text')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toMatch(/^\[Simulado\] No puedo hacer operaciones/);
    expect(r.some((e) => e.type === 'tool_call' && e.call.name === 'suggest_actions')).toBe(true);
    expect(r.some((e) => e.type === 'tool_call' && e.call.name !== 'suggest_actions')).toBe(false);
  });

  it('pide no compartir CVV ni contraseñas', async () => {
    const r = await ask('te paso mi cvv');
    expect(JSON.stringify(r)).toContain('No compartas');
  });
});
