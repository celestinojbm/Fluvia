/**
 * Mensajes del canal de datos de la llamada (tema `fluvia-call`, fiables).
 * El agente NO tiene acceso a la API de Fluvia: oye, transcribe y habla. Las
 * respuestas las pide el NAVEGADOR con la sesión de la persona (misma
 * autorización y herramientas de solo lectura que el chat) y se las envía al
 * agente para que las diga.
 */
export const TOPIC = 'fluvia-call';

export type AgentToUser =
  | {
      t: 'hello';
      agent: string;
      /** true = agente de PRUEBA (STT/TTS deterministas); false = proveedores reales. */
      test: boolean;
      stt: { provider: string; simulated: boolean };
      tts: { provider: string; simulated: boolean };
      maxSeconds: number;
    }
  | { t: 'speech_start' }
  | { t: 'transcript'; text: string; seconds: number; simulated: boolean }
  | { t: 'speaking'; on: boolean }
  | { t: 'interrupted' }
  | { t: 'error'; code: 'stt_failed' | 'tts_failed' | 'max_duration' };

export type UserToAgent = { t: 'say'; text: string } | { t: 'bye' };

export function parseUserMessage(raw: Uint8Array): UserToAgent | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    if (v.t === 'say' && typeof v.text === 'string' && v.text.length > 0) {
      return { t: 'say', text: v.text.slice(0, 1000) };
    }
    if (v.t === 'bye') return { t: 'bye' };
  } catch {
    /* mensaje inválido: se ignora */
  }
  return null;
}

export function encode(m: AgentToUser): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(m));
}

/** Salas que la API crea para el asistente; el agente no entra en otras. */
export const ROOM_RE = /^fluvia-(personal|commerce)-[0-9a-f-]{36}$/;
export const IDENTITY_RE = /^(consumer|user):[0-9a-f-]{36}$/;
