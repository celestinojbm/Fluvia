import { describe, expect, it } from 'vitest';
import {
  decodeCredential,
  encodeCredential,
  keyOf,
  parseCredential,
  rejectCrossSite,
} from '../app/api/asistente/buyer-bff';

describe('BFF del asistente del comprador', () => {
  const sessionId = 'cbb7e41a-9965-4d40-bc3f-ae01e4b6d9df';

  it('acepta el client_secret real (base64url, con «-» y «_»)', () => {
    const secret = 'cs_sla4L_FTjCsUUMicbMvGC-BFUOV6MDUqeqhhEi2Abn4LMWtP';
    const c = parseCredential({ checkout_session_id: sessionId, client_secret: secret });
    expect(c).toEqual({ kind: 'checkout', sessionId, secret });
    expect(decodeCredential(encodeCredential(c!))).toEqual(c);
  });

  it('rechaza credenciales malformadas', () => {
    expect(parseCredential({ checkout_session_id: 'x', client_secret: 'cs_abcdefgh' })).toBeNull();
    expect(parseCredential({ checkout_session_id: sessionId, client_secret: 'a b' })).toBeNull();
    expect(parseCredential({ tracking_token: 'corto' })).toBeNull();
    expect(decodeCredential('no-es-json')).toBeNull();
  });

  it('la clave de la cookie distingue credenciales', () => {
    const a = keyOf({ kind: 'tracking', token: 'a'.repeat(32) });
    const b = keyOf({ kind: 'tracking', token: 'b'.repeat(32) });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
  });

  it('CSRF: exige la cabecera no-simple y el mismo origen', () => {
    const req = (h: Record<string, string>) =>
      new Request('http://127.0.0.1:3341/api/asistente/sesion', { method: 'POST', headers: h });
    const host = { host: '127.0.0.1:3341' };
    expect(rejectCrossSite(req({ ...host, 'x-fluvia-csrf': '1' }))).toBeNull();
    expect(rejectCrossSite(req({ ...host }))?.status).toBe(403);
    expect(
      rejectCrossSite(req({ ...host, 'x-fluvia-csrf': '1', origin: 'https://evil.example' }))
        ?.status
    ).toBe(403);
    expect(
      rejectCrossSite(req({ ...host, 'x-fluvia-csrf': '1', 'sec-fetch-site': 'cross-site' }))
        ?.status
    ).toBe(403);
  });
});
