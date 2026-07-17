import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  REJECT_ALL_ORIGIN,
  allowedMutationOrigin,
  canonicalDashboardOrigin,
  untrustedMutationReason,
} from '../app/lib/csrf';
import { POST as createKeyPOST } from '../app/api/orgs/[orgId]/api-keys/route';
import { POST as revokeKeyPOST } from '../app/api/orgs/[orgId]/api-keys/[keyId]/revoke/route';
import { POST as createEndpointPOST } from '../app/api/orgs/[orgId]/webhook-endpoints/route';
import { POST as rotatePOST } from '../app/api/orgs/[orgId]/webhook-endpoints/[id]/rotate/route';
import { POST as disablePOST } from '../app/api/orgs/[orgId]/webhook-endpoints/[id]/disable/route';
import { POST as resendPOST } from '../app/api/orgs/[orgId]/webhook-events/[id]/resend/route';
import { POST as stepUpPOST } from '../app/api/step-up/password/route';
import { POST as onboardingOrgPOST } from '../app/api/onboarding/organization/route';
import { POST as onboardingMerchantPOST } from '../app/api/orgs/[orgId]/onboarding/merchant/route';

// La cookie de sesión EXISTE en todos los escenarios (SameSite=Lax la envía
// también desde el sibling): lo que debe frenar el request es el guard CSRF.
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'fluvia_session' ? { value: 'session-token-test' } : undefined,
    }),
}));

/**
 * RA-F65B-EXT-002 — política CSRF de los route handlers MUTANTES del dashboard.
 * La cookie `fluvia_session` es SameSite=Lax: un sibling same-site
 * (`evil.example.com` vs `dashboard.example.com`) la porta igualmente, así que
 * la política exige procedencia `same-origin` ESTRICTA (Origin exacto +
 * Sec-Fetch-Site + header no-simple), fail-closed.
 */

const DASH = 'https://dashboard.example.com';

function trusted(overrides: Record<string, string | null> = {}): Headers {
  const base: Record<string, string> = {
    origin: DASH,
    'sec-fetch-site': 'same-origin',
    [CSRF_HEADER]: CSRF_HEADER_VALUE,
  };
  const h = new Headers(base);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) h.delete(k);
    else h.set(k, v);
  }
  return h;
}

describe('untrustedMutationReason (origin canónico configurado)', () => {
  it('allows the exact canonical origin with same-origin metadata and the CSRF header', () => {
    expect(untrustedMutationReason(trusted(), DASH)).toBeNull();
  });

  it('rejects a SIBLING same-site origin (the Hermes scenario)', () => {
    // Con metadata de fetch: cae por Sec-Fetch-Site.
    expect(
      untrustedMutationReason(
        trusted({ origin: 'https://evil.example.com', 'sec-fetch-site': 'same-site' }),
        DASH
      )
    ).toBe('sec_fetch_site');
    // Sin metadata (navegador antiguo): cae por comparación EXACTA de Origin.
    expect(
      untrustedMutationReason(
        trusted({ origin: 'https://evil.example.com', 'sec-fetch-site': null }),
        DASH
      )
    ).toBe('origin_mismatch');
  });

  it('rejects a cross-site origin', () => {
    expect(
      untrustedMutationReason(
        trusted({ origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' }),
        DASH
      )
    ).toBe('sec_fetch_site');
    expect(
      untrustedMutationReason(
        trusted({ origin: 'https://attacker.test', 'sec-fetch-site': null }),
        DASH
      )
    ).toBe('origin_mismatch');
  });

  it('Sec-Fetch-Site policy: same-origin allowed; same-site, cross-site and none rejected', () => {
    expect(untrustedMutationReason(trusted({ 'sec-fetch-site': 'same-origin' }), DASH)).toBeNull();
    for (const site of ['same-site', 'cross-site', 'none']) {
      expect(untrustedMutationReason(trusted({ 'sec-fetch-site': site }), DASH), site).toBe(
        'sec_fetch_site'
      );
    }
  });

  it('missing Origin is fail-closed (explicit policy), including opaque "null"', () => {
    expect(untrustedMutationReason(trusted({ origin: null }), DASH)).toBe('missing_origin');
    expect(untrustedMutationReason(trusted({ origin: 'null' }), DASH)).toBe('missing_origin');
  });

  it('missing or invalid CSRF header is rejected (defence in depth, never the only check)', () => {
    expect(untrustedMutationReason(trusted({ [CSRF_HEADER]: null }), DASH)).toBe(
      'missing_csrf_header'
    );
    expect(untrustedMutationReason(trusted({ [CSRF_HEADER]: 'nope' }), DASH)).toBe(
      'missing_csrf_header'
    );
  });

  it('near-miss origins never pass the exact comparison', () => {
    for (const origin of [
      'https://dashboard.example.com.attacker.test',
      'https://dashboard.example.com:8443',
      'http://dashboard.example.com',
      'https://xdashboard.example.com',
    ]) {
      expect(
        untrustedMutationReason(trusted({ origin, 'sec-fetch-site': null }), DASH),
        origin
      ).toBe('origin_mismatch');
    }
  });
});

// ── RA-F65B-DELTA2-002: política de ORIGIN COMPLETO (scheme+host+port) ────────

describe('untrustedMutationReason: comparación de origin COMPLETO (esquema + puerto)', () => {
  it('same origin exacto → permitido; downgrade HTTP↔HTTPS y diferencia de puerto → rechazados', () => {
    // 1. https vs request https del mismo origin → permitido.
    expect(untrustedMutationReason(trusted({ origin: DASH }), DASH)).toBeNull();
    // 2. Origin HTTP contra origin permitido HTTPS del mismo host → rechazado.
    expect(
      untrustedMutationReason(
        trusted({ origin: 'http://dashboard.example.com', 'sec-fetch-site': null }),
        DASH
      )
    ).toBe('origin_mismatch');
    // 3. Origin HTTPS contra origin permitido HTTP del mismo host → rechazado.
    expect(
      untrustedMutationReason(
        trusted({ origin: 'https://dashboard.example.com', 'sec-fetch-site': null }),
        'http://dashboard.example.com'
      )
    ).toBe('origin_mismatch');
    // 4. Puerto distinto → rechazado.
    expect(
      untrustedMutationReason(
        trusted({ origin: 'https://dashboard.example.com:8443', 'sec-fetch-site': null }),
        DASH
      )
    ).toBe('origin_mismatch');
    // 5. Hostname distinto → rechazado.
    expect(
      untrustedMutationReason(
        trusted({ origin: 'https://other.example.com', 'sec-fetch-site': null }),
        DASH
      )
    ).toBe('origin_mismatch');
    // 6. Sibling → rechazado (por Sec-Fetch-Site y por origin).
    expect(
      untrustedMutationReason(
        trusted({ origin: 'https://evil.example.com', 'sec-fetch-site': 'same-site' }),
        DASH
      )
    ).toBe('sec_fetch_site');
    // El origin permitido REJECT_ALL jamás casa con un origin real.
    expect(untrustedMutationReason(trusted({ origin: DASH }), REJECT_ALL_ORIGIN)).toBe(
      'origin_mismatch'
    );
  });
});

describe('canonicalDashboardOrigin: validación estricta de FLUVIA_DASHBOARD_ORIGIN', () => {
  const env = (v?: string): NodeJS.ProcessEnv =>
    ({ NODE_ENV: 'test', FLUVIA_DASHBOARD_ORIGIN: v }) as NodeJS.ProcessEnv;

  it('null si no está fijada; origin canónico exacto si es http/https válida', () => {
    expect(canonicalDashboardOrigin(env())).toBeNull();
    // 7. Env válida → comparación exacta (path se ignora, solo el origin).
    expect(canonicalDashboardOrigin(env('https://dash.fluvia.test'))).toBe(
      'https://dash.fluvia.test'
    );
    expect(canonicalDashboardOrigin(env('http://localhost:3100/'))).toBe('http://localhost:3100');
  });

  it('8/9. env inválida o con userinfo/query/fragment/path → fail-closed (REJECT_ALL)', () => {
    for (const bad of [
      '::no::', // no parseable
      'ftp://dash.fluvia.test', // esquema no http/https
      'https://user:pass@dash.fluvia.test', // userinfo
      'https://dash.fluvia.test?x=1', // query
      'https://dash.fluvia.test#frag', // fragment
      'https://dash.fluvia.test/base', // path ambiguo
    ]) {
      expect(canonicalDashboardOrigin(env(bad)), bad).toBe(REJECT_ALL_ORIGIN);
    }
    // REJECT_ALL rechaza cualquier origin real → 403.
    expect(untrustedMutationReason(trusted(), canonicalDashboardOrigin(env('::no::'))!)).toBe(
      'origin_mismatch'
    );
  });
});

describe('allowedMutationOrigin: env → producción fail-closed → derivación dev/test', () => {
  const req = (url: string, xfHost?: string): Request =>
    new Request(url, { headers: xfHost ? { 'x-forwarded-host': xfHost } : {} });

  it('env configurada tiene prioridad (comparación exacta, no deriva del request)', () => {
    const env = {
      NODE_ENV: 'production',
      FLUVIA_DASHBOARD_ORIGIN: 'https://dash.fluvia.test',
    } as NodeJS.ProcessEnv;
    expect(allowedMutationOrigin(req('https://whatever.internal/api/x'), env)).toBe(
      'https://dash.fluvia.test'
    );
  });

  it('10. producción SIN env → fail-closed (no deriva del request, que tras proxy vendría en http)', () => {
    const env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(allowedMutationOrigin(req('http://dashboard.local/api/x'), env)).toBe(REJECT_ALL_ORIGIN);
  });

  it('11. dev/test SIN env → deriva el origin EXACTO de request.url (esquema+host+puerto)', () => {
    const env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    expect(allowedMutationOrigin(req('http://dashboard.local/api/x'), env)).toBe(
      'http://dashboard.local'
    );
    expect(allowedMutationOrigin(req('https://dashboard.local:8443/api/x'), env)).toBe(
      'https://dashboard.local:8443'
    );
  });

  it('12. NO usa X-Forwarded-Host para derivar el origin', () => {
    const env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    // Aunque el atacante inyecte X-Forwarded-Host, el origin derivado sale de
    // request.url (host real), no de la cabecera forjable.
    expect(
      allowedMutationOrigin(req('http://dashboard.local/api/x', 'evil.example.com'), env)
    ).toBe('http://dashboard.local');
  });
});

// ── Nivel route handler: un request rechazado JAMÁS llega al backend ──────────

const ORG = 'org-1';
const PARAMS = { params: Promise.resolve({ orgId: ORG, keyId: 'k-1', id: 'e-1' }) };

function siblingRequest(path: string, body?: string): Request {
  // Formulario/fetch desde el sibling: cookie presente (SameSite=Lax la envía),
  // sin header CSRF, Origin del sibling, Sec-Fetch-Site same-site.
  return new Request(`https://dashboard.example.com${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://evil.example.com',
      host: 'dashboard.example.com',
      'sec-fetch-site': 'same-site',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body,
  });
}

function legitRequest(path: string, body?: string): Request {
  return new Request(`http://dashboard.local${path}`, {
    method: 'POST',
    headers: {
      origin: 'http://dashboard.local',
      host: 'dashboard.local',
      'sec-fetch-site': 'same-origin',
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body,
  });
}

describe('route handlers mutantes: enforcement antes del backend', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    );
    // Origin canónico explícito: la comparación exacta no depende del `Host`.
    vi.stubEnv('FLUVIA_DASHBOARD_ORIGIN', 'http://dashboard.local');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const cases: Array<{
    name: string;
    path: string;
    call: (req: Request) => Promise<Response>;
  }> = [
    {
      name: 'create api key',
      path: `/api/orgs/${ORG}/api-keys`,
      call: (req) => createKeyPOST(req, PARAMS),
    },
    {
      name: 'revoke api key (sin body)',
      path: `/api/orgs/${ORG}/api-keys/k-1/revoke`,
      call: (req) => revokeKeyPOST(req, PARAMS),
    },
    {
      name: 'create webhook endpoint',
      path: `/api/orgs/${ORG}/webhook-endpoints`,
      call: (req) => createEndpointPOST(req, PARAMS),
    },
    {
      name: 'rotate webhook endpoint (sin body)',
      path: `/api/orgs/${ORG}/webhook-endpoints/e-1/rotate`,
      call: (req) => rotatePOST(req, PARAMS),
    },
    {
      name: 'disable webhook endpoint (sin body)',
      path: `/api/orgs/${ORG}/webhook-endpoints/e-1/disable`,
      call: (req) => disablePOST(req, PARAMS),
    },
    {
      name: 'webhook event resend',
      path: `/api/orgs/${ORG}/webhook-events/e-1/resend`,
      call: (req) => resendPOST(req, PARAMS),
    },
    {
      name: 'step-up password',
      path: `/api/step-up/password`,
      call: (req) => stepUpPOST(req),
    },
    // F6.5C2: los dos proxies del wizard de onboarding.
    {
      name: 'onboarding organization',
      path: `/api/onboarding/organization`,
      call: (req) => onboardingOrgPOST(req),
    },
    {
      name: 'onboarding merchant',
      path: `/api/orgs/${ORG}/onboarding/merchant`,
      call: (req) => onboardingMerchantPOST(req, PARAMS),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: sibling same-site → 403 sin tocar el backend ni filtrar secretos`, async () => {
      const res = await c.call(siblingRequest(c.path));
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(JSON.parse(body).error.code).toBe('origin_not_allowed');
      // Jamás se reenvió al backend.
      expect(fetch).not.toHaveBeenCalled();
      // La respuesta no contiene Bearer, cookie ni detalle sensible.
      expect(body).not.toContain('session-token-test');
      expect(body).not.toContain('Bearer');
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  }

  it('un create legítimo sigue funcionando y reenvía el Bearer al backend', async () => {
    const res = await createEndpointPOST(
      legitRequest(
        `/api/orgs/${ORG}/webhook-endpoints`,
        JSON.stringify({ url: 'https://x.test/h' })
      ),
      PARAMS
    );
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain(`/v1/organizations/${ORG}/webhook_endpoints`);
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer session-token-test'
    );
  });

  it('el step-up legítimo sigue funcionando', async () => {
    const res = await stepUpPOST(
      legitRequest('/api/step-up/password', JSON.stringify({ password: 'pw' }))
    );
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/v1/auth/step-up/password');
  });

  it('un resend legítimo sigue funcionando y reenvía el Bearer al backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ id: 'whe_new' }), { status: 201 })))
    );
    const res = await resendPOST(
      legitRequest(`/api/orgs/${ORG}/webhook-events/e-1/resend`),
      PARAMS
    );
    expect(res.status).toBe(201);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain(`/v1/organizations/${ORG}/webhook_events/e-1/resend`);
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer session-token-test'
    );
  });

  it('resend: sibling con cookie presente → 403; la cookie NUNCA se transforma en Bearer', async () => {
    const res = await resendPOST(
      siblingRequest(`/api/orgs/${ORG}/webhook-events/e-1/resend`),
      PARAMS
    );
    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    const body = await res.text();
    expect(JSON.parse(body).error.code).toBe('origin_not_allowed');
    expect(body).not.toContain('session-token-test');
    expect(body).not.toContain('Bearer');
  });

  it('el header CSRF ausente o inválido se rechaza incluso con Origin correcto', async () => {
    const noHeader = new Request('http://dashboard.local/api/step-up/password', {
      method: 'POST',
      headers: {
        origin: 'http://dashboard.local',
        host: 'dashboard.local',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect((await stepUpPOST(noHeader)).status).toBe(403);
    const badHeader = new Request('http://dashboard.local/api/step-up/password', {
      method: 'POST',
      headers: {
        origin: 'http://dashboard.local',
        host: 'dashboard.local',
        'sec-fetch-site': 'same-origin',
        [CSRF_HEADER]: '0',
      },
    });
    expect((await stepUpPOST(badHeader)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
