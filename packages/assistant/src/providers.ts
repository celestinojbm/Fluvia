/**
 * Interfaces SEPARADAS de proveedor del asistente (una por capacidad):
 *  - ConversationProvider: conversación + visión, con herramientas y streaming.
 *  - SpeechToTextProvider: nota de voz → texto.
 *  - TextToSpeechProvider: texto → audio (respuesta hablada opcional).
 *  - CallTransport: credencial de sala para la llamada en vivo (WebRTC).
 *
 * Cada implementación declara `simulated`: la UI y las respuestas lo muestran,
 * y nunca se afirma una conversación o llamada real con un proveedor simulado.
 * Las credenciales viven SOLO en el servidor (variables de entorno de la API).
 */

export interface ImagePart {
  type: 'image';
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  data: Buffer;
}
export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'user'; content: Array<TextPart | ImagePart> }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; results: Array<{ id: string; content: string; isError?: boolean }> };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema del input (objeto). */
  inputSchema: Record<string, unknown>;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; stop: 'end' | 'tool_use' | 'max_tokens' }
  | { type: 'error'; code: ProviderErrorCode };

export type ProviderErrorCode = 'overloaded' | 'rate_limited' | 'unavailable' | 'invalid' | 'auth';

export interface ConversationRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
}

export interface ConversationProvider {
  readonly name: string;
  readonly simulated: boolean;
  readonly vision: boolean;
  stream(req: ConversationRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

export interface Transcription {
  text: string;
  language: string | null;
}

export interface SpeechToTextProvider {
  readonly name: string;
  readonly simulated: boolean;
  transcribe(
    audio: { data: Buffer; mime: string; durationMs: number },
    signal: AbortSignal
  ): Promise<Transcription>;
}

export interface SpeechAudio {
  data: Buffer;
  mime: 'audio/wav' | 'audio/mpeg' | 'audio/ogg';
}

export interface TextToSpeechProvider {
  readonly name: string;
  readonly simulated: boolean;
  synthesize(text: string, signal: AbortSignal): Promise<SpeechAudio>;
}

export interface CallGrant {
  /** URL wss del servidor de medios; null en el transporte simulado. */
  url: string | null;
  token: string;
  room: string;
  identity: string;
  expiresAt: string;
}

export interface CallTransport {
  readonly name: string;
  readonly simulated: boolean;
  /** Credencial de vida corta, limitada a UNA sala y a UNA identidad. */
  grant(input: { room: string; identity: string; ttlSeconds: number }): Promise<CallGrant>;
}

export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(`assistant provider error: ${code}`);
    this.name = new.target.name;
  }
}
