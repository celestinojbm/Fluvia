import { createHmac } from 'node:crypto';
import { ProviderError, type CallGrant, type CallTransport } from './providers.js';

/**
 * Transporte de llamada con LiveKit: SOLO emite el token de acceso (JWT HS256
 * firmado con el secreto de la API, que no sale del servidor). Estructura
 * según «Access tokens & grants» de la documentación oficial: `iss` = API key,
 * `sub` = identidad, `nbf`, `exp` y el grant `video` limitado a UNA sala.
 *
 * Permisos mínimos: entrar a esa sala, publicar SOLO micrófono, suscribirse
 * y canal de datos (transcripción y respuestas). Sin cámara ni pantalla: una
 * foto durante la llamada va por la subida autenticada del chat, con su
 * validación y su retención. Sin admin, sin grabación, sin crear salas.
 *
 * El agente de voz (apps/voice-agent) es un proceso aparte: al emitir el
 * token, la API le pide entrar en ESA sala para ESA identidad.
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
        canPublishSources: ['microphone'],
      },
    })
  );
  const sig = b64url(createHmac('sha256', cfg.apiSecret).update(`${header}.${payload}`).digest());
  return { token: `${header}.${payload}.${sig}`, expiresAt: exp };
}

export class LiveKitCallTransport implements CallTransport {
  readonly name = 'livekit';
  readonly simulated = false;
  constructor(
    private readonly cfg: {
      url: string;
      apiKey: string;
      apiSecret: string;
      agentUrl: string;
      agentSecret: string;
    },
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async grant(input: { room: string; identity: string; ttlSeconds: number }): Promise<CallGrant> {
    // Primero el agente: sin agente no hay llamada y no se entrega token.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    let status = 0;
    try {
      const res = await this.fetchImpl(new URL('/join', this.cfg.agentUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.agentSecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ room: input.room, identity: input.identity }),
        signal: ac.signal,
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
    } catch {
      throw new ProviderError('unavailable');
    } finally {
      clearTimeout(timer);
    }
    if (status !== 200) throw new ProviderError('unavailable');
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
