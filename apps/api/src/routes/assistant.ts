import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AssistantLimitError,
  MediaRejectedError,
  ProviderError,
  inspectAudio,
  inspectImage,
  sanitizeContext,
  type AssistantEngine,
  type AssistantLimits,
  type AssistantProviders,
  type AssistantStore,
  type AttachmentDto,
  type BlobStorage,
  type ConversationDto,
  type EngineEvent,
  type MessageDto,
  type Owner,
  type Surface,
} from '@fluvia/assistant';
import type { Security } from '../security.js';
import { FixedWindowLimiter, rateLimit, type RateLimiter } from '../rate-limit.js';

/**
 * Asistente «Fluvia» en dos planos que NO se mezclan:
 *  - Personal: sesión del CLIENTE (`fluvia_csess_*`); titular = cliente.
 *  - Comercio: sesión del OPERADOR + permiso `payments:read` en la
 *    organización; titular = usuario.
 * El titular sale SIEMPRE de la sesión autenticada (nunca del cuerpo) y la
 * persistencia aplica RLS por tenant Y titular (0055). Las herramientas son de
 * lectura y se ejecutan con esa misma identidad.
 */

// ── Errores con código estable del catálogo ─────────────────────────────────
class NamedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class AssistantQuotaError extends NamedError {}
export class AssistantBusyError extends NamedError {}
export class AssistantAttachmentError extends NamedError {}
export class AssistantEmptyError extends NamedError {}
export class MediaUnsupportedError extends NamedError {}
export class MediaTooLargeError extends NamedError {}
export class MediaTooLongError extends NamedError {}
export class MediaMalformedError extends NamedError {}
export class MediaDurationUnknownError extends NamedError {}
export class AssistantProviderUnavailableError extends NamedError {}

function mapError(e: unknown): unknown {
  if (e instanceof AssistantLimitError) {
    if (e.code === 'quota_exceeded') return new AssistantQuotaError(e.message);
    if (e.code === 'busy') return new AssistantBusyError(e.message);
    if (e.code === 'empty') return new AssistantEmptyError(e.message);
    return new AssistantAttachmentError(e.message);
  }
  if (e instanceof MediaRejectedError) {
    if (e.reason === 'unsupported_format') return new MediaUnsupportedError(e.message);
    if (e.reason === 'too_large' || e.reason === 'too_many_pixels')
      return new MediaTooLargeError(e.message);
    if (e.reason === 'too_long') return new MediaTooLongError(e.message);
    if (e.reason === 'duration_unknown') return new MediaDurationUnknownError(e.message);
    return new MediaMalformedError(e.message);
  }
  if (e instanceof ProviderError) return new AssistantProviderUnavailableError(e.message);
  return e;
}

const IdParam = z.object({ id: z.string().uuid() });
const OrgParam = z.object({ orgId: z.string().uuid() });
const OrgIdParams = z.object({ orgId: z.string().uuid(), id: z.string().uuid() });

const CreateConversation = z
  .object({ title: z.string().trim().max(80).optional() })
  .strict()
  .default({});
const SendBody = z
  .object({
    text: z.string().max(8000).default(''),
    attachment_ids: z.array(z.string().uuid()).max(10).default([]),
    input_mode: z.enum(['text', 'voice', 'call']).default('text'),
    context: z
      .object({ route: z.string().max(300).optional(), task: z.string().max(60).optional() })
      .strict()
      .default({}),
  })
  .strict();
const TranscribeBody = z.object({ attachment_id: z.string().uuid() }).strict();
const SpeechBody = z.object({ text: z.string().trim().min(1).max(1000) }).strict();
const KindHeader = z.enum(['image', 'audio']);

function publicConversation(c: ConversationDto) {
  return {
    object: 'assistant_conversation',
    id: c.id,
    title: c.title,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}
function publicMessage(
  m: MessageDto,
  orgId: string | null,
  surface: Surface,
  resolve: AssistantRoutesOptions['resolveActions']
) {
  return {
    object: 'assistant_message',
    id: m.id,
    role: m.role,
    content: m.content,
    input_mode: m.inputMode,
    attachment_ids: m.attachmentIds,
    actions: resolve(m.actions, surface, orgId),
    tools_used: m.toolsUsed,
    simulated: m.simulated,
    status: m.status,
    created_at: m.createdAt,
  };
}
function publicAttachment(a: AttachmentDto) {
  return {
    object: 'assistant_attachment',
    id: a.id,
    kind: a.kind,
    mime: a.mime,
    bytes: a.bytes,
    width: a.width,
    height: a.height,
    duration_ms: a.durationMs,
    status: a.status,
  };
}

export interface AssistantRoutesOptions {
  security: Security;
  authenticateConsumer: (token: string) => Promise<{ consumerId: string; tenantId: string }>;
  engine: AssistantEngine;
  store: AssistantStore;
  storage: BlobStorage;
  providers: AssistantProviders;
  limits: AssistantLimits;
  resolveActions: (ids: string[], surface: Surface, orgId: string | null) => unknown[];
  limiter?: RateLimiter;
}

export function registerAssistantRoutes(app: FastifyInstance, o: AssistantRoutesOptions): void {
  const pm = (m: MessageDto, orgId: string | null, surface: Surface) =>
    publicMessage(m, orgId, surface, o.resolveActions);
  // Límites por IDENTIDAD autenticada (titular y organización), no por la IP
  // del BFF: todas las peticiones del panel llegan desde la misma IP. Se
  // aplican DESPUÉS de autenticar, con la identidad de la sesión.
  const limiter = o.limiter ?? new FixedWindowLimiter();
  const perOwner = rateLimit(limiter, [
    {
      keyOf: (req) =>
        req.assistantOwner
          ? `assistant:owner:${req.assistantOwner.tenantId}:${req.assistantOwner.ownerId}`
          : null,
      rule: { max: o.limits.requestsPerMinute, windowMs: 60_000 },
    },
    {
      // Toda una organización de Comercio comparte un techo (varios usuarios).
      keyOf: (req) => (req.assistantOrg ? `assistant:org:${req.assistantOrg}` : null),
      rule: { max: o.limits.requestsPerMinute * 10, windowMs: 60_000 },
    },
  ]);

  // Cuerpo binario de adjuntos: el formato REAL se decide por contenido.
  app.addContentTypeParser(
    'application/octet-stream',
    {
      parseAs: 'buffer',
      bodyLimit: Math.max(o.limits.maxImageBytes, o.limits.maxAudioBytes) + 1024,
    },
    (_req, body, done) => done(null, body)
  );

  const consumer = async (req: FastifyRequest): Promise<void> => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const id = await o.authenticateConsumer(token);
    req.assistantOwner = {
      tenantId: id.tenantId,
      ownerId: id.consumerId,
      kind: 'consumer',
      surface: 'personal',
    };
    req.assistantOrg = null;
  };
  const operator = async (req: FastifyRequest): Promise<void> => {
    req.assistantOwner = {
      tenantId: req.org!.organizationId,
      ownerId: req.identity!.userId,
      kind: 'user',
      surface: 'commerce',
    };
    req.assistantOrg = req.org!.organizationId;
  };

  const planes: Array<{ prefix: string; pre: unknown[] }> = [
    { prefix: '/v1/personal/assistant', pre: [consumer, perOwner] },
    {
      prefix: '/v1/organizations/:orgId/assistant',
      pre: [o.security.session, o.security.org('payments:read'), operator, perOwner],
    },
  ];

  for (const { prefix, pre } of planes) {
    const opts = { preHandler: pre as never };
    const owner = (req: FastifyRequest): Owner => req.assistantOwner!;
    const org = (req: FastifyRequest): string | null => req.assistantOrg ?? null;
    const idOf = (req: FastifyRequest) => {
      const p = req.params as Record<string, string>;
      if (p.orgId) OrgIdParams.parse(p);
      return IdParam.parse({ id: p.id }).id;
    };
    const orgOk = (req: FastifyRequest) => {
      const p = req.params as Record<string, string>;
      if (p.orgId) OrgParam.parse(p);
    };

    app.get(`${prefix}/status`, opts, async (req) => {
      orgOk(req);
      return {
        object: 'assistant_status',
        conversation: {
          provider: o.providers.conversation.name,
          simulated: o.providers.conversation.simulated,
        },
        speech_to_text: { provider: o.providers.stt.name, simulated: o.providers.stt.simulated },
        text_to_speech: { provider: o.providers.tts.name, simulated: o.providers.tts.simulated },
        call: { provider: o.providers.call.name, simulated: o.providers.call.simulated },
        limits: {
          max_input_chars: o.limits.maxInputChars,
          max_image_bytes: o.limits.maxImageBytes,
          max_images_per_message: o.limits.maxImagesPerMessage,
          max_audio_bytes: o.limits.maxAudioBytes,
          max_audio_seconds: o.limits.maxAudioSeconds,
          max_call_seconds: o.limits.maxCallSeconds,
          retention_days: o.limits.retentionDays,
        },
      };
    });

    app.get(`${prefix}/conversations`, opts, async (req) => {
      orgOk(req);
      const list = await o.store.run(owner(req), (c) => o.store.listConversations(c, owner(req)));
      return { object: 'list', data: list.map(publicConversation) };
    });

    app.post(`${prefix}/conversations`, opts, async (req, reply) => {
      orgOk(req);
      const b = CreateConversation.parse(req.body ?? {});
      const c = await o.store.run(owner(req), (cl) =>
        o.store.createConversation(cl, owner(req), b.title || 'Conversación')
      );
      return reply.code(201).send(publicConversation(c));
    });

    app.get(`${prefix}/conversations/:id/messages`, opts, async (req) => {
      const id = idOf(req);
      const list = await o.store.run(owner(req), async (c) => {
        await o.store.getConversation(c, owner(req), id);
        return o.store.listMessages(c, id, 100);
      });
      return {
        object: 'list',
        data: list.map((m) => pm(m, org(req), owner(req).surface)),
      };
    });

    // Respuesta en streaming (SSE). Los fallos ANTES del primer evento salen
    // como error JSON normal; después, como evento `error` del stream.
    app.post(`${prefix}/conversations/:id/messages`, opts, async (req, reply) => {
      const id = idOf(req);
      const b = SendBody.parse(req.body ?? {});
      const controller = new AbortController();
      let started = false;
      const open = () => {
        if (started) return;
        started = true;
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        reply.raw.on('close', () => {
          if (!reply.raw.writableFinished) controller.abort();
        });
      };
      const write = (e: EngineEvent) => {
        open();
        if (reply.raw.destroyed) return;
        const wire =
          e.type === 'start'
            ? {
                type: 'start',
                user_message: pm(e.userMessage, org(req), owner(req).surface),
                simulated: e.simulated,
              }
            : e.type === 'done'
              ? { type: 'done', message: pm(e.message, org(req), owner(req).surface) }
              : e.type === 'error'
                ? {
                    type: 'error',
                    code: e.code,
                    message: e.message ? pm(e.message, org(req), owner(req).surface) : null,
                  }
                : e;
        reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(wire)}\n\n`);
      };
      try {
        await o.engine.reply(
          {
            owner: owner(req),
            orgId: org(req),
            conversationId: id,
            text: b.text,
            inputMode: b.input_mode,
            attachmentIds: b.attachment_ids,
            context: sanitizeContext(b.context, org(req)),
          },
          write,
          controller.signal
        );
      } catch (e) {
        if (!started) throw mapError(e);
        if (!reply.raw.destroyed) {
          reply.raw.write(
            `event: error\ndata: ${JSON.stringify({ type: 'error', code: 'unavailable' })}\n\n`
          );
        }
      }
      if (started && !reply.raw.destroyed) reply.raw.end();
      return reply;
    });

    // ── Adjuntos ─────────────────────────────────────────────────────────────
    app.post(
      `${prefix}/attachments`,
      {
        ...opts,
        bodyLimit: Math.max(o.limits.maxImageBytes, o.limits.maxAudioBytes) + 1024,
      },
      async (req, reply) => {
        orgOk(req);
        const kind = KindHeader.parse(req.headers['x-attachment-kind']);
        const body = req.body;
        if (!Buffer.isBuffer(body)) throw new MediaUnsupportedError('expected binary body');
        let meta: {
          mime: string;
          data: Buffer;
          width: number | null;
          height: number | null;
          durationMs: number | null;
        };
        try {
          if (kind === 'image') {
            const i = inspectImage(body, {
              maxBytes: o.limits.maxImageBytes,
              maxPixels: o.limits.maxImagePixels,
            });
            meta = {
              mime: i.mime,
              data: i.clean,
              width: i.width,
              height: i.height,
              durationMs: null,
            };
          } else {
            const a = inspectAudio(body, {
              maxBytes: o.limits.maxAudioBytes,
              maxSeconds: o.limits.maxAudioSeconds,
            });
            meta = {
              mime: a.mime,
              data: body,
              width: null,
              height: null,
              durationMs: a.durationMs,
            };
          }
        } catch (e) {
          throw mapError(e);
        }
        const key = await o.storage.put(meta.data);
        try {
          const a = await o.store.run(owner(req), (c) =>
            o.store.addAttachment(c, owner(req), {
              kind,
              mime: meta.mime,
              bytes: meta.data.length,
              width: meta.width,
              height: meta.height,
              durationMs: meta.durationMs,
              storageKey: key,
              sha256: createHash('sha256').update(meta.data).digest('hex'),
            })
          );
          return reply.code(201).send(publicAttachment(a));
        } catch (e) {
          await o.storage.remove(key).catch(() => undefined);
          throw e;
        }
      }
    );

    app.post(`${prefix}/attachments/:id/delete`, opts, async (req) => {
      const id = idOf(req);
      const a = await o.store.run(owner(req), (c) => o.store.markDeleted(c, id));
      await o.storage.remove(a.storageKey).catch(() => undefined);
      return publicAttachment(a);
    });

    // Contenido: solo el titular; nunca en caché compartida.
    app.get(`${prefix}/attachments/:id/content`, opts, async (req, reply) => {
      const id = idOf(req);
      const a = await o.store.run(owner(req), (c) => o.store.getAttachment(c, id));
      const data = await o.storage.get(a.storageKey);
      return reply
        .header('content-type', a.mime)
        .header('cache-control', 'private, no-store')
        .header('content-disposition', 'inline')
        .header('x-content-type-options', 'nosniff')
        .send(data);
    });

    // Nota de voz → texto EDITABLE. El audio se borra justo después: lo que se
    // envía al asistente es la transcripción que la persona revisa.
    app.post(`${prefix}/transcriptions`, opts, async (req) => {
      orgOk(req);
      const b = TranscribeBody.parse(req.body);
      const a = await o.store.run(owner(req), (c) => o.store.getAttachment(c, b.attachment_id));
      if (a.kind !== 'audio' || a.status !== 'uploaded')
        throw new AssistantAttachmentError('not audio');
      const data = await o.storage.get(a.storageKey);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const t = await o.providers.stt.transcribe(
          { data, mime: a.mime, durationMs: a.durationMs ?? 0 },
          controller.signal
        );
        return {
          object: 'assistant_transcription',
          text: t.text.slice(0, o.limits.maxInputChars),
          duration_ms: a.durationMs,
          simulated: o.providers.stt.simulated,
        };
      } catch (e) {
        throw mapError(e);
      } finally {
        clearTimeout(timer);
        await o.store.run(owner(req), (c) => o.store.markDeleted(c, a.id)).catch(() => undefined);
        await o.storage.remove(a.storageKey).catch(() => undefined);
      }
    });

    // Respuesta hablada opcional (el texto sigue disponible en el chat).
    app.post(`${prefix}/speech`, opts, async (req, reply) => {
      orgOk(req);
      const b = SpeechBody.parse(req.body);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const audio = await o.providers.tts.synthesize(b.text, controller.signal);
        return reply
          .header('content-type', audio.mime)
          .header('cache-control', 'no-store')
          .header('x-fluvia-simulated', String(o.providers.tts.simulated))
          .send(audio.data);
      } catch (e) {
        throw mapError(e);
      } finally {
        clearTimeout(timer);
      }
    });

    // Llamada en vivo: credencial de vida corta para UNA sala propia.
    app.post(`${prefix}/call/token`, opts, async (req) => {
      orgOk(req);
      const ow = owner(req);
      const room = `fluvia-${ow.surface}-${randomUUID()}`;
      const ttl = Math.min(o.limits.maxCallSeconds, 900);
      // Con LiveKit, antes del token se despacha el agente a ESA sala.
      const g = await o.providers.call
        .grant({ room, identity: `${ow.kind}:${ow.ownerId}`, ttlSeconds: ttl })
        .catch((e: unknown) => {
          throw mapError(e);
        });
      return {
        object: 'assistant_call_grant',
        simulated: o.providers.call.simulated,
        url: g.url,
        token: g.token,
        room: g.room,
        expires_at: g.expiresAt,
        max_seconds: o.limits.maxCallSeconds,
      };
    });
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    assistantOwner?: Owner;
    assistantOrg?: string | null;
  }
}
