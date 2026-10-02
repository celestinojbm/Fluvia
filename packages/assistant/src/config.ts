/**
 * Límites y proveedores del asistente, desde variables de entorno de la API.
 * Todo tiene un valor por defecto prudente; nada de esto es un secreto salvo
 * las claves de proveedor, que nunca salen del servidor.
 */
export interface AssistantLimits {
  /** Mensajes de usuario por titular y día (UTC). */
  messagesPerDay: number;
  /** Respuestas en curso a la vez por titular. */
  concurrentStreams: number;
  maxInputChars: number;
  maxImageBytes: number;
  maxImagePixels: number;
  maxImagesPerMessage: number;
  maxAudioBytes: number;
  maxAudioSeconds: number;
  maxCallSeconds: number;
  retentionDays: number;
  maxOutputTokens: number;
  /** Rondas máximas de herramientas por respuesta. */
  maxToolRounds: number;
  /** Peticiones por titular y minuto (la organización: ×10). */
  requestsPerMinute: number;
}

export interface AssistantProviderConfig {
  conversation:
    { kind: 'simulated' } | { kind: 'anthropic'; apiKey: string; model: string; baseUrl: string };
  speech:
    | { kind: 'simulated' }
    | {
        kind: 'openai_compatible';
        apiKey: string;
        baseUrl: string;
        sttModel: string;
        ttsModel: string;
        ttsVoice: string;
      };
  call: { kind: 'simulated' } | { kind: 'livekit'; url: string; apiKey: string; apiSecret: string };
}

const int = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

export function loadAssistantLimits(env: Record<string, string | undefined>): AssistantLimits {
  return {
    messagesPerDay: int(env.ASSISTANT_MESSAGES_PER_DAY, 200, 1, 10_000),
    concurrentStreams: int(env.ASSISTANT_CONCURRENT_STREAMS, 1, 1, 10),
    maxInputChars: int(env.ASSISTANT_MAX_INPUT_CHARS, 2000, 100, 8000),
    maxImageBytes: int(env.ASSISTANT_MAX_IMAGE_BYTES, 5 * 1024 * 1024, 64 * 1024, 20 * 1024 * 1024),
    maxImagePixels: int(env.ASSISTANT_MAX_IMAGE_PIXELS, 40_000_000, 1_000_000, 100_000_000),
    maxImagesPerMessage: int(env.ASSISTANT_MAX_IMAGES_PER_MESSAGE, 3, 1, 10),
    maxAudioBytes: int(env.ASSISTANT_MAX_AUDIO_BYTES, 4 * 1024 * 1024, 64 * 1024, 25 * 1024 * 1024),
    maxAudioSeconds: int(env.ASSISTANT_MAX_AUDIO_SECONDS, 120, 5, 600),
    maxCallSeconds: int(env.ASSISTANT_MAX_CALL_SECONDS, 600, 30, 3600),
    retentionDays: int(env.ASSISTANT_RETENTION_DAYS, 30, 1, 365),
    maxOutputTokens: int(env.ASSISTANT_MAX_OUTPUT_TOKENS, 700, 64, 4096),
    maxToolRounds: int(env.ASSISTANT_MAX_TOOL_ROUNDS, 3, 1, 6),
    requestsPerMinute: int(env.ASSISTANT_REQUESTS_PER_MINUTE, 60, 5, 10_000),
  };
}

/**
 * Proveedores REALES solo si TODAS sus variables están definidas; si falta
 * alguna, el simulado (y la UI lo dice). No hay modelo por defecto: hay que
 * elegirlo explícitamente (ASSISTANT_MODEL).
 */
export function loadAssistantProviders(
  env: Record<string, string | undefined>
): AssistantProviderConfig {
  const conversation =
    env.ASSISTANT_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY && env.ASSISTANT_MODEL
      ? {
          kind: 'anthropic' as const,
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.ASSISTANT_MODEL,
          baseUrl: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
        }
      : { kind: 'simulated' as const };
  const speech =
    env.ASSISTANT_SPEECH_PROVIDER === 'openai_compatible' &&
    env.SPEECH_API_KEY &&
    env.SPEECH_BASE_URL &&
    env.SPEECH_STT_MODEL &&
    env.SPEECH_TTS_MODEL &&
    env.SPEECH_TTS_VOICE
      ? {
          kind: 'openai_compatible' as const,
          apiKey: env.SPEECH_API_KEY,
          baseUrl: env.SPEECH_BASE_URL,
          sttModel: env.SPEECH_STT_MODEL,
          ttsModel: env.SPEECH_TTS_MODEL,
          ttsVoice: env.SPEECH_TTS_VOICE,
        }
      : { kind: 'simulated' as const };
  const call =
    env.ASSISTANT_CALL_PROVIDER === 'livekit' &&
    env.LIVEKIT_URL &&
    env.LIVEKIT_API_KEY &&
    env.LIVEKIT_API_SECRET
      ? {
          kind: 'livekit' as const,
          url: env.LIVEKIT_URL,
          apiKey: env.LIVEKIT_API_KEY,
          apiSecret: env.LIVEKIT_API_SECRET,
        }
      : { kind: 'simulated' as const };
  return { conversation, speech, call };
}
