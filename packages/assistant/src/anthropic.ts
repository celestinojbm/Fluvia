import type {
  ChatMessage,
  ConversationProvider,
  ConversationRequest,
  ProviderErrorCode,
  StreamEvent,
} from './providers.js';

/**
 * Conversación + visión con la API de Mensajes de Anthropic (SSE), por `fetch`
 * y sin SDK. Protocolo según la documentación oficial («Streaming messages»):
 * POST /v1/messages con `anthropic-version: 2023-06-01`, `x-api-key` y
 * `stream: true`; eventos content_block_start (tool_use), content_block_delta
 * (text_delta / input_json_delta), message_delta (stop_reason) y error.
 *
 * La clave y el modelo son del PRODUCTO (variables ANTHROPIC_API_KEY y
 * ASSISTANT_MODEL); nunca la sesión ni los créditos de una herramienta de
 * desarrollo.
 */
export class AnthropicConversationProvider implements ConversationProvider {
  readonly name = 'anthropic';
  readonly simulated = false;
  readonly vision = true;

  constructor(
    private readonly cfg: { apiKey: string; model: string; baseUrl: string },
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async *stream(req: ConversationRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': this.cfg.apiKey,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          max_tokens: req.maxTokens,
          stream: true,
          system: req.system,
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
          messages: toWire(req.messages),
        }),
      });
    } catch {
      if (signal.aborted) return;
      yield { type: 'error', code: 'unavailable' };
      return;
    }
    if (!res.ok || !res.body) {
      yield { type: 'error', code: httpCode(res.status) };
      return;
    }

    const tools = new Map<number, { id: string; name: string; json: string }>();
    let stop: 'end' | 'tool_use' | 'max_tokens' = 'end';
    for await (const ev of sse(res.body, signal)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = data.type;
      if (type === 'content_block_start') {
        const block = data.content_block as { type?: string; id?: string; name?: string };
        if (block?.type === 'tool_use' && block.id && block.name) {
          tools.set(data.index as number, { id: block.id, name: block.name, json: '' });
        }
      } else if (type === 'content_block_delta') {
        const d = data.delta as { type?: string; text?: string; partial_json?: string };
        if (d?.type === 'text_delta' && d.text) yield { type: 'text', text: d.text };
        if (d?.type === 'input_json_delta') {
          const t = tools.get(data.index as number);
          if (t) t.json += d.partial_json ?? '';
        }
      } else if (type === 'content_block_stop') {
        const t = tools.get(data.index as number);
        if (t) {
          let input: Record<string, unknown> = {};
          try {
            input = t.json ? (JSON.parse(t.json) as Record<string, unknown>) : {};
          } catch {
            input = {};
          }
          yield { type: 'tool_call', call: { id: t.id, name: t.name, input } };
          tools.delete(data.index as number);
        }
      } else if (type === 'message_delta') {
        const r = (data.delta as { stop_reason?: string })?.stop_reason;
        if (r === 'tool_use') stop = 'tool_use';
        else if (r === 'max_tokens') stop = 'max_tokens';
      } else if (type === 'error') {
        const t = (data.error as { type?: string })?.type;
        yield { type: 'error', code: t === 'overloaded_error' ? 'overloaded' : 'unavailable' };
        return;
      }
    }
    if (signal.aborted) return;
    yield { type: 'done', stop };
  }
}

function httpCode(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 529 || status === 503) return 'overloaded';
  if (status === 400) return 'invalid';
  return 'unavailable';
}

/** Mensajes internos → formato de la API (tool_result en un mensaje de usuario). */
function toWire(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'user') {
      return {
        role: 'user',
        content: m.content.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : {
                type: 'image',
                source: { type: 'base64', media_type: p.mime, data: p.data.toString('base64') },
              }
        ),
      };
    }
    if (m.role === 'assistant') {
      const content: unknown[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      }
      return { role: 'assistant', content };
    }
    return {
      role: 'user',
      content: m.results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  });
}

/** Lector SSE mínimo (líneas `event:` / `data:` separadas por línea en blanco). */
export async function* sse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncIterable<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        let event = 'message';
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
