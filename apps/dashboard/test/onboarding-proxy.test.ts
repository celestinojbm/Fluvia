import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../app/lib/csrf-header';
import { POST as orgPOST } from '../app/api/onboarding/organization/route';
import { POST as merchantPOST } from '../app/api/orgs/[orgId]/onboarding/merchant/route';

/**
 * F6.5C2 — proxies BFF del wizard de onboarding. Matriz CSRF completa por
 * proxy (el guard corre ANTES de leer body/cookie/Bearer/fetch), respuesta
 * re-emitida por WHITELIST (jamas passthrough), redirects del backend
 * rechazados y errores con `code` estable sin detalle interno.
 */

// Cookie configurable por test: los escenarios sin sesion la anulan.
const cookieState = vi.hoisted(() => ({ value: 'session-token-test' as string | null }));
const cookieReads = vi.hoisted(() => ({ count: 0 }));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        cookieReads.count += 1;
        return name === 'fluvia_session' && cookieState.value !== null
          ? { value: cookieState.value }
          : undefined;
      },
    }),
}));

const ORG = 'org-1';
const PARAMS = { params: Promise.resolve({ orgId: ORG }) };
const BASE = 'http://dashboard.local';

function requestWith(path: string, headers: Record<string, string>, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
}

function legitHeaders(): Record<string, string> {
  return {
    origin: BASE,
    'sec-fetch-site': 'same-origin',
    [CSRF_HEADER]: CSRF_HEADER_VALUE,
  };
}

beforeEach(() => {
  cookieState.value = 'session-token-test';
  cookieReads.count = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })))
  );
  vi.stubEnv('FLUVIA_DASHBOARD_ORIGIN', BASE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── Matriz CSRF completa por proxy ────────────────────────────────────────────

const REJECTION_MATRIX: Array<{ name: string; headers: Record<string, string> }> = [
  {
    name: 'sibling same-site',
    headers: {
      origin: 'http://evil.dashboard.local',
      'sec-fetch-site': 'same-site',
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
    },
  },
  {
    name: 'cross-site',
    headers: {
      origin: 'https://attacker.test',
      'sec-fetch-site': 'cross-site',
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
    },
  },
  {
    name: 'Origin ausente',
    headers: { 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE },
  },
  {
    name: 'Origin null',
    headers: { origin: 'null', 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE },
  },
  {
    name: 'header CSRF ausente',
    headers: { origin: BASE, 'sec-fetch-site': 'same-origin' },
  },
  {
    name: 'header CSRF incorrecto',
    headers: { origin: BASE, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: '0' },
  },
  {
    name: 'esquema distinto (https vs http)',
    headers: {
      origin: 'https://dashboard.local',
      'sec-fetch-site': 'same-origin',
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
    },
  },
  {
    name: 'puerto distinto',
    headers: {
      origin: 'http://dashboard.local:8443',
      'sec-fetch-site': 'same-origin',
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
    },
  },
  {
    name: 'Sec-Fetch-Site same-site',
    headers: { origin: BASE, 'sec-fetch-site': 'same-site', [CSRF_HEADER]: CSRF_HEADER_VALUE },
  },
  {
    name: 'Sec-Fetch-Site cross-site',
    headers: { origin: BASE, 'sec-fetch-site': 'cross-site', [CSRF_HEADER]: CSRF_HEADER_VALUE },
  },
  {
    name: 'Sec-Fetch-Site none',
    headers: { origin: BASE, 'sec-fetch-site': 'none', [CSRF_HEADER]: CSRF_HEADER_VALUE },
  },
];

const PROXIES: Array<{ name: string; path: string; call: (req: Request) => Promise<Response> }> = [
  {
    name: 'organization',
    path: '/api/onboarding/organization',
    call: (req) => orgPOST(req),
  },
  {
    name: 'merchant',
    path: `/api/orgs/${ORG}/onboarding/merchant`,
    call: (req) => merchantPOST(req, PARAMS),
  },
];

for (const proxy of PROXIES) {
  describe(`matriz CSRF — proxy de ${proxy.name}`, () => {
    for (const rejection of REJECTION_MATRIX) {
      it(`${rejection.name}: 403 sin leer cookie, sin Bearer, sin invocar fetch/backend`, async () => {
        const res = await proxy.call(requestWith(proxy.path, rejection.headers, { x: 1 }));
        expect(res.status).toBe(403);
        const body = await res.text();
        expect(JSON.parse(body).error.code).toBe('origin_not_allowed');
        // Backend jamas invocado; cookie jamas leida; cero secretos en la salida.
        expect(fetch).not.toHaveBeenCalled();
        expect(cookieReads.count).toBe(0);
        expect(body).not.toContain('session-token-test');
        expect(body).not.toContain('Bearer');
      });
    }

    it('same-origin + headers correctos: permitido (el guard no bloquea el flujo legitimo)', async () => {
      const res = await proxy.call(requestWith(proxy.path, legitHeaders(), { x: 1 }));
      // Con backend stub {} el proxy responde por contrato (400/502), pero el
      // punto es que PASO el guard: la cookie se leyo y el flujo continuo.
      expect(res.status).not.toBe(403);
      expect(cookieReads.count).toBeGreaterThan(0);
    });

    it('sin cookie de sesion => 401 sin invocar al backend', async () => {
      cookieState.value = null;
      const res = await proxy.call(requestWith(proxy.path, legitHeaders(), { x: 1 }));
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('invalid_session');
      expect(fetch).not.toHaveBeenCalled();
    });
  });
}

// ── Whitelist de la respuesta y contrato de errores ──────────────────────────

describe('proxy de organizacion: whitelist y errores estables', () => {
  it('201: re-emite SOLO los campos del contrato (un campo extra del backend jamas cruza)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              organization: { id: 'org-9', name: 'Mi Empresa', slug: 'mi-empresa' },
              membership: { role: 'owner' },
              replayed: false,
              internal_debug: 'never-cross',
              verification_token: 'fluvia_verify_leak',
            }),
            { status: 201 }
          )
        )
      )
    );
    const res = await orgPOST(
      requestWith('/api/onboarding/organization', legitHeaders(), {
        organizationName: 'Mi Empresa',
        slug: 'mi-empresa',
      })
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      organization: { id: 'org-9', name: 'Mi Empresa', slug: 'mi-empresa' },
      membership: { role: 'owner' },
      replayed: false,
    });
    expect(text).not.toContain('never-cross');
    expect(text).not.toContain('fluvia_verify_leak');
    // El Bearer se construyo SOLO tras el guard y viajo al backend correcto.
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/v1/organizations');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer session-token-test'
    );
    expect(init.redirect).toBe('manual');
  });

  it('200 con replayed:true se preserva (recuperacion natural)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              organization: { id: 'org-9', name: 'Mi Empresa', slug: 'mi-empresa' },
              membership: { role: 'owner' },
              replayed: true,
            }),
            { status: 200 }
          )
        )
      )
    );
    const res = await orgPOST(
      requestWith('/api/onboarding/organization', legitHeaders(), {
        organizationName: 'Mi Empresa',
        slug: 'mi-empresa',
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).replayed).toBe(true);
  });

  it('propaga el code estable de error del catalogo sin body interno', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'organization_slug_taken',
                message: 'public',
                stack: 'SECRET-STACK',
              },
            }),
            { status: 409 }
          )
        )
      )
    );
    const res = await orgPOST(
      requestWith('/api/onboarding/organization', legitHeaders(), {
        organizationName: 'Mi Empresa',
        slug: 'tomado',
      })
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('organization_slug_taken');
    expect(text).not.toContain('SECRET-STACK');
  });

  it('body invalido => 400 validation_error SIN invocar al backend', async () => {
    const res = await orgPOST(
      requestWith('/api/onboarding/organization', legitHeaders(), { organizationName: 42 })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_error');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('un redirect del backend NO se sigue: 502 estable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(null, { status: 307, headers: { location: '/evil' } }))
      )
    );
    const res = await orgPOST(
      requestWith('/api/onboarding/organization', legitHeaders(), {
        organizationName: 'Mi Empresa',
        slug: 'mi-empresa',
      })
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('internal_error');
  });
});

describe('proxy de merchant: whitelist y errores estables', () => {
  const goodBackendBody = {
    merchant: { id: 'm-1', name: 'Tienda', country: 'CO', defaultCurrency: 'COP' },
    chartReady: true,
    replayed: false,
  };

  it('201: re-emite SOLO merchant/chartReady/replayed y reenvia el Bearer al endpoint dedicado', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ...goodBackendBody, secret_field: 'no-cross' }), {
            status: 201,
          })
        )
      )
    );
    const res = await merchantPOST(
      requestWith(`/api/orgs/${ORG}/onboarding/merchant`, legitHeaders(), {
        name: 'Tienda',
        country: 'CO',
        defaultCurrency: 'COP',
      }),
      PARAMS
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(goodBackendBody);
    expect(text).not.toContain('no-cross');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain(`/v1/organizations/${ORG}/onboarding/merchant`);
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer session-token-test'
    );
    expect(init.redirect).toBe('manual');
  });

  it('propaga codes estables (merchant_onboarding_already_completed / not_found)', async () => {
    for (const [code, status] of [
      ['merchant_onboarding_already_completed', 409],
      ['not_found', 404],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { code } }), { status })))
      );
      const res = await merchantPOST(
        requestWith(`/api/orgs/${ORG}/onboarding/merchant`, legitHeaders(), { name: 'Tienda' }),
        PARAMS
      );
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
  });

  it('body invalido => 400 sin backend; respuesta malformada del backend => 502 estable', async () => {
    const bad = await merchantPOST(
      requestWith(`/api/orgs/${ORG}/onboarding/merchant`, legitHeaders(), { name: 7 }),
      PARAMS
    );
    expect(bad.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ chartReady: false }), { status: 200 }))
      )
    );
    const malformed = await merchantPOST(
      requestWith(`/api/orgs/${ORG}/onboarding/merchant`, legitHeaders(), { name: 'Tienda' }),
      PARAMS
    );
    expect(malformed.status).toBe(502);
    expect((await malformed.json()).error.code).toBe('internal_error');
  });
});
