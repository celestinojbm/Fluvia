import { createHmac } from 'node:crypto';
import type { CallGrant, CallTransport } from './providers.js';

/**
 * Transporte de llamada con LiveKit: SOLO emite el token de acceso (JWT HS256
 * firmado con el secreto de la API, que no sale del servidor). Estructura
 * según «Access tokens & grants» de la documentación oficial: `iss` = API key,
 * `sub` = identidad, `nbf`, `exp` y el grant `video` limitado a UNA sala.
 *
 * Permisos mínimos: entrar a esa sala, publicar micrófono (y cámara o pantalla
 * solo si el usuario la comparte: se habilitan como fuentes, la UI pide
 * consentimiento cada vez), suscribirse y canal de datos para la
 * transcripción. Sin admin, sin grabación, sin crear salas.
 *
 * El agente de voz (LiveKit Agents) es un proceso aparte que entra a la sala;
 * no forma parte de este repositorio (dependencia externa documentada).
 */
const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function signLiveKitToken(
  cfg: { apiKey: string; apiSecret: string },
  input: { room: string; identity: string; ttlSeconds: number; now?: number }
): { token: string; expiresAt: number } {
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  const exp = now + input.ttlSeconds;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: cfg.apiKey,
      sub: input.identity,
      nbf: now - 5,
      exp,
      video: {
        room: input.room,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canPublishSources: ['microphone', 'camera', 'screen_share'],
      },
    })
  );
  const sig = b64url(createHmac('sha256', cfg.apiSecret).update(`${header}.${payload}`).digest());
  return { token: `${header}.${payload}.${sig}`, expiresAt: exp };
}

export class LiveKitCallTransport implements CallTransport {
  readonly name = 'livekit';
  readonly simulated = false;
  constructor(private readonly cfg: { url: string; apiKey: string; apiSecret: string }) {}

  async grant(input: { room: string; identity: string; ttlSeconds: number }): Promise<CallGrant> {
    const t = signLiveKitToken(this.cfg, input);
    return {
      url: this.cfg.url,
      token: t.token,
      room: input.room,
      identity: input.identity,
      expiresAt: new Date(t.expiresAt * 1000).toISOString(),
    };
  }
}
