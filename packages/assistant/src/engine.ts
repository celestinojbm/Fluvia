import type { AssistantLimits } from './config.js';
import type { BlobStorage } from './storage.js';
import { redactSecrets, resolveActions, systemPrompt, type Surface } from './policy.js';
import type {
  ChatMessage,
  ConversationProvider,
  ImagePart,
  ProviderErrorCode,
  ToolCall,
  ToolSpec,
} from './providers.js';
import {
  AssistantNotFoundError,
  type AssistantStore,
  type MessageDto,
  type Owner,
} from './store.js';

/**
 * Orquestación de una respuesta: guarda el mensaje del usuario, consulta al
 * proveedor en streaming, ejecuta herramientas de LECTURA (autorizadas por el
 * servidor con la identidad del titular, nunca con datos del mensaje) y guarda
 * la respuesta — completa, cancelada o con error, siempre con lo que se
 * alcanzó a mostrar.
 */

export interface ToolContext {
  owner: Owner;
  orgId: string | null;
  signal: AbortSignal;
}

export interface ToolResult {
  /** Frase corta en español con el dato (la usa también el simulado). */
  summary: string;
  data?: unknown;
}

export interface AssistantTool {
  spec: ToolSpec;
  /** Pantallas relacionadas que se ofrecen al usar la herramienta. */
  actions: string[];
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type EngineEvent =
  | { type: 'start'; userMessage: MessageDto; simulated: boolean; provider: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | {
      type: 'done';
      message: MessageDto;
      actions: Array<{ id: string; label: string; href: string }>;
    }
  | { type: 'error'; code: EngineErrorCode; message?: MessageDto };

export type EngineErrorCode =
  ProviderErrorCode | 'quota_exceeded' | 'busy' | 'invalid_attachment' | 'empty';

export class AssistantLimitError extends Error {
  constructor(readonly code: 'quota_exceeded' | 'busy' | 'invalid_attachment' | 'empty') {
    super(`assistant limit: ${code}`);
    this.name = new.target.name;
  }
}

const SUGGEST: ToolSpec = {
  name: 'suggest_actions',
  description:
    'Ofrece a la persona 1 a 3 enlaces a pantallas del producto. Usa solo ids del catálogo.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
    },
    required: ['ids'],
  },
};

export class AssistantEngine {
  private readonly active = new Map<string, number>();

  constructor(
    private readonly deps: {
      store: AssistantStore;
      storage: BlobStorage;
      provider: ConversationProvider;
      limits: AssistantLimits;
      tools: (surface: Surface) => AssistantTool[];
    }
  ) {}

  get providerInfo() {
    return { name: this.deps.provider.name, simulated: this.deps.provider.simulated };
  }

  async reply(
    input: {
      owner: Owner;
      orgId: string | null;
      conversationId: string;
      text: string;
      inputMode: 'text' | 'voice' | 'call';
      attachmentIds: string[];
      context: { route: string | null; task: string | null };
    },
    emit: (e: EngineEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const { owner, limits } = { owner: input.owner, limits: this.deps.limits };
    const key = `${owner.tenantId}:${owner.ownerId}`;
    if ((this.active.get(key) ?? 0) >= limits.concurrentStreams) {
      throw new AssistantLimitError('busy');
    }
    const text = input.text.trim().slice(0, limits.maxInputChars);
    if (!text && input.attachmentIds.length === 0) throw new AssistantLimitError('empty');
    if (input.attachmentIds.length > limits.maxImagesPerMessage) {
      throw new AssistantLimitError('invalid_attachment');
    }
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      await this.run({ ...input, text }, emit, signal);
    } finally {
      const n = (this.active.get(key) ?? 1) - 1;
      if (n <= 0) this.active.delete(key);
      else this.active.set(key, n);
    }
  }

  private async run(
    input: Parameters<AssistantEngine['reply']>[0],
    emit: (e: EngineEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const { store, storage, provider, limits } = this.deps;
    const owner = input.owner;
    const clean = redactSecrets(input.text);

    // 1) Mensaje del usuario + adjuntos (propios, subidos, imágenes) + historial.
    const prep = await store.run(owner, async (c) => {
      await store.getConversation(c, owner, input.conversationId);
      if ((await store.countUserMessagesToday(c)) >= limits.messagesPerDay) {
        throw new AssistantLimitError('quota_exceeded');
      }
      const atts = [];
      for (const id of input.attachmentIds) {
        let a;
        try {
          a = await store.getAttachment(c, id);
        } catch (e) {
          if (e instanceof AssistantNotFoundError)
            throw new AssistantLimitError('invalid_attachment');
          throw e;
        }
        if (a.kind !== 'image' || a.status !== 'uploaded') {
          throw new AssistantLimitError('invalid_attachment');
        }
        atts.push(a);
      }
      const history = await store.listMessages(c, input.conversationId, 20);
      const userMessage = await store.addMessage(c, owner, {
        conversationId: input.conversationId,
        role: 'user',
        content: clean.text,
        inputMode: input.inputMode,
        attachmentIds: atts.map((a) => a.id),
        actions: [],
        toolsUsed: [],
        provider: null,
        simulated: false,
        status: 'complete',
      });
      await store.markSent(
        c,
        atts.map((a) => a.id)
      );
      await store.touchConversation(c, input.conversationId);
      return { atts, history, userMessage };
    });

    emit({
      type: 'start',
      userMessage: prep.userMessage,
      simulated: provider.simulated,
      provider: provider.name,
    });

    const images: ImagePart[] = [];
    for (const a of prep.atts) {
      images.push({
        type: 'image',
        mime: a.mime as ImagePart['mime'],
        data: await storage.get(a.storageKey),
      });
    }

    const messages: ChatMessage[] = [];
    for (const m of prep.history) {
      if (m.status !== 'complete' || !m.content) continue;
      if (m.role === 'user')
        messages.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
      else messages.push({ role: 'assistant', content: m.content });
    }
    messages.push({
      role: 'user',
      content: [
        ...images,
        {
          type: 'text',
          text:
            (clean.text || '(Sin texto: la persona solo envió imágenes.)') +
            (clean.redacted
              ? '\n[Nota del sistema: se eliminaron datos de tarjeta del mensaje.]'
              : ''),
        },
      ],
    });

    const tools = this.deps.tools(owner.surface);
    const specs = [...tools.map((t) => t.spec), SUGGEST];
    const system = systemPrompt({
      surface: owner.surface,
      route: input.context.route,
      task: input.context.task,
      simulatedTools: provider.simulated,
    });

    let answer = '';
    const used = new Set<string>();
    const actionIds: string[] = [];
    let status: MessageDto['status'] = 'complete';
    let errorCode: EngineErrorCode | null = null;

    try {
      for (let round = 0; round <= limits.maxToolRounds; round++) {
        const calls: ToolCall[] = [];
        let roundText = '';
        let stop: 'end' | 'tool_use' | 'max_tokens' = 'end';
        for await (const ev of provider.stream(
          {
            system,
            messages,
            tools: round < limits.maxToolRounds ? specs : [SUGGEST],
            maxTokens: limits.maxOutputTokens,
          },
          signal
        )) {
          if (ev.type === 'text') {
            roundText += ev.text;
            answer += ev.text;
            emit({ type: 'delta', text: ev.text });
          } else if (ev.type === 'tool_call') calls.push(ev.call);
          else if (ev.type === 'done') stop = ev.stop;
          else if (ev.type === 'error') {
            errorCode = ev.code;
            break;
          }
        }
        if (signal.aborted) {
          status = 'cancelled';
          break;
        }
        if (errorCode) {
          status = 'error';
          break;
        }
        if (calls.length === 0 || stop !== 'tool_use') break;

        const results: Array<{ id: string; content: string; isError?: boolean }> = [];
        for (const call of calls) {
          if (call.name === 'suggest_actions') {
            const ids = Array.isArray(call.input.ids)
              ? call.input.ids.filter((x): x is string => typeof x === 'string')
              : [];
            actionIds.push(...ids);
            results.push({ id: call.id, content: JSON.stringify({ summary: '' }) });
            continue;
          }
          const tool = tools.find((t) => t.spec.name === call.name);
          if (!tool) {
            results.push({ id: call.id, content: '{"error":"unknown_tool"}', isError: true });
            continue;
          }
          emit({ type: 'tool', name: tool.spec.name });
          used.add(tool.spec.name);
          actionIds.push(...tool.actions);
          try {
            const r = await tool.run(call.input, { owner, orgId: input.orgId, signal });
            results.push({ id: call.id, content: JSON.stringify(r).slice(0, 6000) });
          } catch {
            results.push({ id: call.id, content: '{"error":"read_failed"}', isError: true });
          }
        }
        messages.push({ role: 'assistant', content: roundText, toolCalls: calls });
        messages.push({ role: 'tool', results });
      }
    } catch {
      status = signal.aborted ? 'cancelled' : 'error';
      if (!signal.aborted) errorCode = 'unavailable';
    }

    const actions = resolveActions(actionIds, owner.surface, input.orgId);
    const saved = await store.run(owner, async (c) => {
      const m = await store.addMessage(c, owner, {
        conversationId: input.conversationId,
        role: 'assistant',
        content: answer.trim(),
        inputMode: 'text',
        attachmentIds: [],
        actions: actions.map((a) => a.id),
        toolsUsed: [...used],
        provider: provider.name,
        simulated: provider.simulated,
        status,
      });
      await store.touchConversation(c, input.conversationId);
      return m;
    });
    if (status === 'error')
      emit({ type: 'error', code: errorCode ?? 'unavailable', message: saved });
    else emit({ type: 'done', message: saved, actions });
  }
}
