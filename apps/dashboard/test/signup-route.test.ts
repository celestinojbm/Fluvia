import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../app/lib/csrf-header';
import { POST as signupPOST } from '../app/api/signup/route';

/**
 * F6.5C1 — BFF `POST /api/signup` (proxy hacia /v1/auth/register-sandbox).
 * Matriz CSRF completa (misma politica auditada de F6.5B): en TODO rechazo el
 * backend NO se invoca, el body NO se procesa, no se crea Bearer y no se
 * devuelve cookie ni secreto. En el camino legitimo: sin cookie, sin
 * Authorization, respuesta re-emitida con whitelist (jamas un token).
 */

const ORIGIN = 'http://dashboard.local';

function signupRequest(headers: Record<string, string | null>, body?: string): Request {
  const base: Record<string, string> = {
    origin: ORIGIN,
    host: 'dashboard.local',
    'sec-fetch-site': 'same-origin',
    [CSRF_HEADER]: CSRF_HEADER_VALUE,
    'content-type': 'application/json',
  };
  const merged = new Headers(base);
  for (const [k, v] of Object.entries(headers)) {
    if (v === null) merged.delete(k);
    else merged.set(k, v);
  }
  return new Request(`${ORIGIN}/api/signup`, {
    method: 'POST',
    headers: merged,
    body: body ?? JSON.stringify({ email: 'nueva@example.com', password: 'sandbox password 12' }),
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ registered: true, email_verified: true }), { status: 201 })
      )
    )
  );
  vi.stubEnv('FLUVIA_DASHBOARD_ORIGIN', ORIGIN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('camino legitimo', () => {
  it('same-origin + header CSRF => 201 minimo, sin Authorization, sin cookie', async () => {
    const req = signupRequest({});
    const res = await signupPOST(req);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ registered: true, email_verified: true });
    expect(res.headers.get('set-cookie')).toBeNull();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/v1/auth/register-sandbox');
    const headers = init.headers as Record<string, string>;
    // Pre-sesion: jamas cookie ni Bearer hacia el backend.
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  });

  it('whitelist estricta: si el backend incluyera un token, el BFF NO lo reenvia al navegador', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              registered: true,
              email_verified: true,
              verification_token: 'fluvia_verify_LEAKED',
              session_token: 'fluvia_sess_LEAKED',
            }),
            { status: 201 }
          )
        )
      )
    );
    const res = await signupPOST(signupRequest({}));
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ registered: true, email_verified: true });
    expect(text).not.toContain('LEAKED');
  });

  it('conserva el code estable del catalogo en errores (email_taken 409) sin stack ni detalle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'email_taken', message: 'x', stack: 'SECRET-STACK' },
            }),
            { status: 409 }
          )
        )
      )
    );
    const res = await signupPOST(signupRequest({}));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { code: 'email_taken' } });
    expect(text).not.toContain('SECRET-STACK');
  });

  it('body invalido (tipos no string) => 400 validation_error SIN llamar al backend', async () => {
    const res = await signupPOST(signupRequest({}, JSON.stringify({ email: 5, password: [] })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_error');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('matriz CSRF: todo rechazo => 403, backend intacto, body sin procesar', () => {
  const rejections: Array<{ name: string; headers: Record<string, string | null> }> = [
    {
      name: 'sibling same-site',
      headers: { origin: 'http://evil.local', 'sec-fetch-site': 'same-site' },
    },
    {
      name: 'cross-site',
      headers: { origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' },
    },
    { name: 'Origin ausente', headers: { origin: null, 'sec-fetch-site': null } },
    { name: 'Origin null opaco', headers: { origin: 'null', 'sec-fetch-site': null } },
    { name: 'header CSRF ausente', headers: { [CSRF_HEADER]: null } },
    { name: 'header CSRF invalido', headers: { [CSRF_HEADER]: '0' } },
    {
      name: 'esquema distinto (https vs http permitido)',
      headers: { origin: 'https://dashboard.local', 'sec-fetch-site': null },
    },
    {
      name: 'puerto distinto',
      headers: { origin: 'http://dashboard.local:8443', 'sec-fetch-site': null },
    },
    { name: 'Sec-Fetch-Site: same-site', headers: { 'sec-fetch-site': 'same-site' } },
    { name: 'Sec-Fetch-Site: cross-site', headers: { 'sec-fetch-site': 'cross-site' } },
    { name: 'Sec-Fetch-Site: none', headers: { 'sec-fetch-site': 'none' } },
  ];

  for (const r of rejections) {
    it(`${r.name} => 403 estable`, async () => {
      const req = signupRequest(r.headers);
      const res = await signupPOST(req);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe('origin_not_allowed');
      // El backend jamas se invoco y el body NUNCA se leyo.
      expect(fetch).not.toHaveBeenCalled();
      expect(req.bodyUsed).toBe(false);
      // Sin Bearer, sin cookie, sin secreto en la respuesta.
      expect(text).not.toContain('Bearer');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(text).not.toContain('password');
    });
  }
});
