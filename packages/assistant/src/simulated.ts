import { createHash } from 'node:crypto';
import type {
  CallGrant,
  CallTransport,
  ChatMessage,
  ConversationProvider,
  ConversationRequest,
  SpeechAudio,
  SpeechToTextProvider,
  StreamEvent,
  TextToSpeechProvider,
  Transcription,
} from './providers.js';

/**
 * Proveedores SIMULADOS y DETERMINISTAS (mismo input ⇒ mismo output). Sirven
 * para probar el flujo completo sin credenciales; jamás se presentan como una
 * conversación, transcripción o llamada real: cada salida lo dice.
 *
 * La conversación simulada NO entiende lenguaje: reconoce palabras clave y
 * llama a las MISMAS herramientas de lectura que usaría un modelo real, de
 * modo que la autorización y el aislamiento se prueban de verdad.
 */

const SIM_PREFIX = '[Simulado] ';

const INTENTS: Array<{ re: RegExp; tool: string; input?: Record<string, unknown> }> = [
  { re: /\b(saldo|dinero|cu[aá]nto tengo|disponible)\b/i, tool: 'get_balances' },
  { re: /\b(cr[eé]dito|l[ií]mite)\b/i, tool: 'get_credit_status' },
  { re: /\b(cuota|vence|pr[oó]ximo pago)\b/i, tool: 'list_upcoming_installments' },
  { re: /\b(tarjeta)\b/i, tool: 'list_cards' },
  { re: /\b(movimiento|compra|gasto)\b/i, tool: 'list_recent_activity' },
  { re: /\b(ventas?|cobrado|resumen)\b/i, tool: 'get_sales_summary' },
  {
    re: /\b(incierto|por confirmar|pendiente|no s[eé] si (se )?cobr)/i,
    tool: 'list_uncertain_payments',
  },
  { re: /\b(directorio|perfil p[uú]blico)\b/i, tool: 'get_directory_status' },
  { re: /\b(d[oó]nde (comprar|pagar)|comercios?)\b/i, tool: 'find_merchants', input: { q: '' } },
];

const SENSITIVE =
  /\b(aprueba|apru[eé]bame|transfiere|env[ií]a(me)? dinero|mueve|retira|paga(r)? por m[ií]|emite|emitir|cambia (mi|los) permiso|hazme admin|confirma el pago|cobra otra vez)\b/i;
const SECRETS =
  /\b(cvv|cvc|c[oó]digo de seguridad|contrase[nñ]a|otp|clave de un solo uso|n[uú]mero completo)\b/i;

function lastUser(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') return m;
  }
  return null;
}

function* chunks(text: string): Generator<string> {
  const words = text.split(/(\s+)/);
  for (let i = 0; i < words.length; i += 6) yield words.slice(i, i + 6).join('');
}

export class SimulatedConversationProvider implements ConversationProvider {
  readonly name = 'simulated';
  readonly simulated = true;
  readonly vision = true;

  constructor(private readonly delayMs = 15) {}

  async *stream(req: ConversationRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const last = req.messages[req.messages.length - 1];
    let text: string;
    if (last?.role === 'tool') {
      // Segunda vuelta: resume los resultados de herramienta, sin inventar.
      const parts = last.results.map((r) =>
        r.isError ? 'No pude leer ese dato ahora.' : summarize(r.content)
      );
      const said = parts.join(' ').trim();
      if (!said) {
        yield { type: 'done', stop: 'end' };
        return;
      }
      text = `${SIM_PREFIX}${said}`;
    } else {
      const user = lastUser(req.messages);
      const said = (user?.content ?? [])
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join(' ');
      const images = (user?.content ?? []).filter((p) => p.type === 'image').length;
      if (SECRETS.test(said)) {
        text = `${SIM_PREFIX}No compartas el número completo de tu tarjeta, el código de seguridad, contraseñas ni códigos de un solo uso. No los necesito para ayudarte.`;
      } else if (SENSITIVE.test(said)) {
        text = `${SIM_PREFIX}No puedo hacer operaciones por ti desde el chat. Te llevo a la pantalla donde puedes hacerlo tú, con tu confirmación.`;
        yield* this.emit(text, signal);
        yield {
          type: 'tool_call',
          call: { id: 'sim-actions', name: 'suggest_actions', input: { ids: guessActions(said) } },
        };
        yield { type: 'done', stop: 'tool_use' };
        return;
      } else {
        const intent = INTENTS.find((i) => i.re.test(said));
        const usable = intent && req.tools.some((t) => t.name === intent.tool);
        if (usable) {
          if (signal.aborted) return;
          yield {
            type: 'tool_call',
            call: {
              id: `sim-${createHash('sha256').update(said).digest('hex').slice(0, 12)}`,
              name: intent.tool,
              input: intent.input ?? {},
            },
          };
          yield { type: 'done', stop: 'tool_use' };
          return;
        }
        text = images
          ? `${SIM_PREFIX}Recibí ${images === 1 ? 'una imagen' : `${images} imágenes`}. El proveedor simulado no analiza su contenido: cuéntame qué necesitas sobre ella.`
          : req.tools.some((t) => t.name === 'get_sales_summary')
            ? `${SIM_PREFIX}Puedo consultar tus ventas, cobros por confirmar o tu perfil en el directorio, y llevarte a la pantalla correcta. ¿Qué necesitas?`
            : `${SIM_PREFIX}Puedo consultar tu saldo, crédito, cuotas, tarjetas o movimientos, y llevarte a la pantalla correcta. ¿Qué necesitas?`;
      }
    }
    yield* this.emit(text, signal);
    yield { type: 'done', stop: 'end' };
  }

  private async *emit(text: string, signal: AbortSignal): AsyncIterable<StreamEvent> {
    for (const c of chunks(text)) {
      if (signal.aborted) return;
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      yield { type: 'text', text: c };
    }
  }
}

function guessActions(said: string): string[] {
  if (/tarjeta|emit/i.test(said)) return ['personal.cards'];
  if (/cr[eé]dito|aprueb/i.test(said)) return ['personal.credit'];
  if (/cobr|pago/i.test(said)) return ['commerce.uncertain'];
  return ['personal.movements'];
}

/** Resumen corto y literal del JSON de una herramienta (sin interpretar). */
function summarize(json: string): string {
  try {
    const v = JSON.parse(json) as { summary?: unknown };
    if (typeof v.summary === 'string') return v.summary.trim();
  } catch {
    /* no JSON */
  }
  return 'Aquí tienes el dato que pediste.';
}

export class SimulatedSpeechToText implements SpeechToTextProvider {
  readonly name = 'simulated';
  readonly simulated = true;
  async transcribe(audio: { data: Buffer; durationMs: number }): Promise<Transcription> {
    const secs = Math.max(1, Math.round(audio.durationMs / 1000));
    return {
      text: `[Transcripción simulada de ${secs} s] Escribe aquí lo que dijiste antes de enviarlo.`,
      language: null,
    };
  }
}

/** Tono breve WAV (PCM 16 bit, 8 kHz) generado de forma determinista. */
export class SimulatedTextToSpeech implements TextToSpeechProvider {
  readonly name = 'simulated';
  readonly simulated = true;
  async synthesize(text: string): Promise<SpeechAudio> {
    const rate = 8000;
    const seconds = Math.min(4, 0.5 + text.length / 60);
    const n = Math.round(rate * seconds);
    const data = Buffer.alloc(44 + n * 2);
    data.write('RIFF', 0, 'ascii');
    data.writeUInt32LE(36 + n * 2, 4);
    data.write('WAVEfmt ', 8, 'ascii');
    data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20);
    data.writeUInt16LE(1, 22);
    data.writeUInt32LE(rate, 24);
    data.writeUInt32LE(rate * 2, 28);
    data.writeUInt16LE(2, 32);
    data.writeUInt16LE(16, 34);
    data.write('data', 36, 'ascii');
    data.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 400, (n - i) / 400);
      data.writeInt16LE(
        Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000 * env),
        44 + i * 2
      );
    }
    return { data, mime: 'audio/wav' };
  }
}

/** Sin servidor de medios: devuelve una credencial inservible a propósito. */
export class SimulatedCallTransport implements CallTransport {
  readonly name = 'simulated';
  readonly simulated = true;
  async grant(input: { room: string; identity: string; ttlSeconds: number }): Promise<CallGrant> {
    return {
      url: null,
      token: 'simulated',
      room: input.room,
      identity: input.identity,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
    };
  }
}
