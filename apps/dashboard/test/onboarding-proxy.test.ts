import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../app/lib/csrf-header';
import { POST as orgPOST } from '../app/api/onboarding/organization/route';
import { POST as merchantPOST } from '../app/api/orgs/[orgId]/onboarding/merchant/route';

/**
 * F6.5C2 — proxies BFF del wizard de onboarding. Matriz CSRF completa por
 * proxy (el guard corre ANTES de leer body/cookie/Bearer/fetch), respuesta
 * re-emitida por WHITELIST (jamas passthrough), redirects del backend
 * rechazados, contrato de exito ESTRICTO por status exacto (jamas `res.ok`:
 * 201 solo con `replayed:false`, 200 solo con `replayed:true`; cualquier
 * otro 2xx o incoherencia => 502) y errores restringidos a una ALLOWLIST
 * cerrada (code desconocido => `internal_error`, jamas reflejado).
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

// ── Contrato HTTP ESTRICTO (jamas res.ok): status exacto + coherencia ────────

/** Stub de fetch que devuelve una unica respuesta fija. */
function stubBackend(status: number, body?: unknown, rawBody?: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          rawBody !== undefined ? rawBody : body === undefined ? null : JSON.stringify(body),
          { status }
        )
      )
    )
  );
}

const GOOD_ORG_BODY = {
  organization: { id: 'org-9', name: 'Mi Empresa', slug: 'mi-empresa' },
  membership: { role: 'owner' },
};
const GOOD_MERCHANT_BODY = {
  merchant: { id: 'm-1', name: 'Tienda', country: 'CO', defaultCurrency: 'COP' },
  chartReady: true,
};

async function callOrg(): Promise<Response> {
  return orgPOST(
    requestWith('/api/onboarding/organization', legitHeaders(), {
      organizationName: 'Mi Empresa',
      slug: 'mi-empresa',
    })
  );
}

async function callMerchant(): Promise<Response> {
  return merchantPOST(
    requestWith(`/api/orgs/${ORG}/onboarding/merchant`, legitHeaders(), {
      name: 'Tienda',
      country: 'CO',
      defaultCurrency: 'COP',
    }),
    PARAMS
  );
}

async function expectBadGateway(res: Response) {
  expect(res.status).toBe(502);
  expect((await res.json()).error.code).toBe('internal_error');
}

describe('proxy de organizacion: contrato de exito ESTRICTO por status exacto', () => {
  it('201 + replayed:false valido => 201; 200 + replayed:true valido => 200', async () => {
    stubBackend(201, { ...GOOD_ORG_BODY, replayed: false });
    const created = await callOrg();
    expect(created.status).toBe(201);
    expect((await created.json()).replayed).toBe(false);

    stubBackend(200, { ...GOOD_ORG_BODY, replayed: true });
    const replayed = await callOrg();
    expect(replayed.status).toBe(200);
    expect((await replayed.json()).replayed).toBe(true);
  });

  it('otros 2xx (202, 204, 206) => 502 internal_error', async () => {
    for (const status of [202, 206]) {
      stubBackend(status, { ...GOOD_ORG_BODY, replayed: false });
      await expectBadGateway(await callOrg());
    }
    stubBackend(204); // sin body
    await expectBadGateway(await callOrg());
  });

  it('incoherencia status/replayed: 201 con replayed:true y 200 con replayed:false => 502', async () => {
    stubBackend(201, { ...GOOD_ORG_BODY, replayed: true });
    await expectBadGateway(await callOrg());
    stubBackend(200, { ...GOOD_ORG_BODY, replayed: false });
    await expectBadGateway(await callOrg());
  });

  it('replayed ausente o no-boolean => 502', async () => {
    stubBackend(201, GOOD_ORG_BODY); // sin replayed
    await expectBadGateway(await callOrg());
    stubBackend(201, { ...GOOD_ORG_BODY, replayed: 'false' });
    await expectBadGateway(await callOrg());
  });

  it('body vacio o malformado => 502', async () => {
    stubBackend(201, undefined, ''); // vacio
    await expectBadGateway(await callOrg());
    stubBackend(201, undefined, 'not-json{'); // malformado
    await expectBadGateway(await callOrg());
    stubBackend(201, { replayed: false }); // sin organization
    await expectBadGateway(await callOrg());
  });

  it('campos contractuales invalidos: id vacio, name/slug no-string, role distinto de owner => 502', async () => {
    stubBackend(201, {
      organization: { id: '', name: 'X', slug: 'x' },
      membership: { role: 'owner' },
      replayed: false,
    });
    await expectBadGateway(await callOrg());
    stubBackend(201, {
      organization: { id: 'org-9', name: 42, slug: 'x' },
      membership: { role: 'owner' },
      replayed: false,
    });
    await expectBadGateway(await callOrg());
    stubBackend(201, {
      organization: { id: 'org-9', name: 'X', slug: null },
      membership: { role: 'owner' },
      replayed: false,
    });
    await expectBadGateway(await callOrg());
    stubBackend(201, { ...GOOD_ORG_BODY, membership: { role: 'admin' }, replayed: false });
    await expectBadGateway(await callOrg());
    stubBackend(201, { organization: GOOD_ORG_BODY.organization, replayed: false }); // sin membership
    await expectBadGateway(await callOrg());
  });

  it('allowlist de errores: los seis codes contractuales pasan con su status', async () => {
    for (const [code, status] of [
      ['validation_error', 400],
      ['invalid_session', 401],
      ['email_not_verified', 403],
      ['organization_slug_taken', 409],
      ['onboarding_already_completed', 409],
      ['internal_error', 500],
    ] as const) {
      stubBackend(status, { error: { code } });
      const res = await callOrg();
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
  });

  it('un code DESCONOCIDO jamas se refleja: se convierte en 502 internal_error', async () => {
    for (const code of ['rate_limited', 'merchant_onboarding_already_completed', 'x'.repeat(80)]) {
      stubBackend(400, { error: { code } });
      const res = await callOrg();
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe('internal_error');
      expect(text).not.toContain(code);
    }
    // Error sin code / body de error malformado => tambien 502.
    stubBackend(500, {});
    await expectBadGateway(await callOrg());
    stubBackend(500, undefined, 'not-json{');
    await expectBadGateway(await callOrg());
  });
});

describe('proxy de merchant: contrato de exito ESTRICTO por status exacto', () => {
  it('201 + replayed:false + chartReady:true => 201; 200 + replayed:true + chartReady:true => 200', async () => {
    stubBackend(201, { ...GOOD_MERCHANT_BODY, replayed: false });
    const created = await callMerchant();
    expect(created.status).toBe(201);
    expect((await created.json()).replayed).toBe(false);

    stubBackend(200, { ...GOOD_MERCHANT_BODY, replayed: true });
    const replayed = await callMerchant();
    expect(replayed.status).toBe(200);
    expect((await replayed.json()).replayed).toBe(true);
  });

  it('otros 2xx (202, 204, 206) => 502 internal_error', async () => {
    for (const status of [202, 206]) {
      stubBackend(status, { ...GOOD_MERCHANT_BODY, replayed: false });
      await expectBadGateway(await callMerchant());
    }
    stubBackend(204);
    await expectBadGateway(await callMerchant());
  });

  it('incoherencia status/replayed => 502', async () => {
    stubBackend(201, { ...GOOD_MERCHANT_BODY, replayed: true });
    await expectBadGateway(await callMerchant());
    stubBackend(200, { ...GOOD_MERCHANT_BODY, replayed: false });
    await expectBadGateway(await callMerchant());
  });

  it('replayed ausente/no-boolean y chartReady distinto de true => 502', async () => {
    stubBackend(201, GOOD_MERCHANT_BODY); // sin replayed
    await expectBadGateway(await callMerchant());
    stubBackend(201, { ...GOOD_MERCHANT_BODY, replayed: 'false' });
    await expectBadGateway(await callMerchant());
    stubBackend(201, { ...GOOD_MERCHANT_BODY, chartReady: false, replayed: false });
    await expectBadGateway(await callMerchant());
    stubBackend(201, {
      merchant: GOOD_MERCHANT_BODY.merchant,
      replayed: false, // sin chartReady
    });
    await expectBadGateway(await callMerchant());
  });

  it('body vacio/malformado/incompleto => 502', async () => {
    stubBackend(201, undefined, '');
    await expectBadGateway(await callMerchant());
    stubBackend(201, undefined, 'not-json{');
    await expectBadGateway(await callMerchant());
    stubBackend(201, { chartReady: true, replayed: false }); // sin merchant
    await expectBadGateway(await callMerchant());
    stubBackend(201, {
      merchant: { id: '', name: 'T', country: 'CO', defaultCurrency: 'COP' },
      chartReady: true,
      replayed: false,
    });
    await expectBadGateway(await callMerchant());
  });

  it('un redirect del backend NO se sigue: 502 estable', async () => {
    stubBackend(307);
    await expectBadGateway(await callMerchant());
  });

  it('allowlist de errores: los seis codes contractuales pasan con su status', async () => {
    for (const [code, status] of [
      ['validation_error', 400],
      ['invalid_session', 401],
      ['insufficient_permissions', 403],
      ['not_found', 404],
      ['merchant_onboarding_already_completed', 409],
      ['internal_error', 500],
    ] as const) {
      stubBackend(status, { error: { code } });
      const res = await callMerchant();
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
  });

  it('un code DESCONOCIDO jamas se refleja: se convierte en 502 internal_error', async () => {
    for (const code of ['rate_limited', 'organization_slug_taken', 'debug_leak_code']) {
      stubBackend(409, { error: { code } });
      const res = await callMerchant();
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe('internal_error');
      expect(text).not.toContain(code);
    }
    stubBackend(500, {});
    await expectBadGateway(await callMerchant());
  });
});

// ── RA-F65C2-EXT-004: parejas code/status ESTRICTAS (mapa cerrado) ───────────

const ORG_CANONICAL_PAIRS = [
  ['validation_error', 400],
  ['invalid_session', 401],
  ['email_not_verified', 403],
  ['organization_slug_taken', 409],
  ['onboarding_already_completed', 409],
  ['internal_error', 500],
] as const;

const MERCHANT_CANONICAL_PAIRS = [
  ['validation_error', 400],
  ['invalid_session', 401],
  ['insufficient_permissions', 403],
  ['not_found', 404],
  ['merchant_onboarding_already_completed', 409],
  ['internal_error', 500],
] as const;

describe('RA-F65C2-EXT-004 — proxy de organizacion: pareja code/status exacta', () => {
  it('cada code SOLO es contractual con su status canonico; la respuesta se reconstruye con el', async () => {
    for (const [code, status] of ORG_CANONICAL_PAIRS) {
      stubBackend(status, { error: { code } });
      const res = await callOrg();
      expect(res.status, `${code}@${status}`).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
  });

  it('cada code con un status INCORRECTO => 502 (jamas se preserva el status backend)', async () => {
    const wrongByCode: Record<string, number[]> = {
      validation_error: [401, 409],
      invalid_session: [400, 403],
      email_not_verified: [401, 409],
      organization_slug_taken: [400, 403],
      onboarding_already_completed: [400, 500],
      internal_error: [400, 401, 403, 404, 409],
    };
    for (const [code, statuses] of Object.entries(wrongByCode)) {
      for (const status of statuses) {
        stubBackend(status, { error: { code } });
        const res = await callOrg();
        expect(res.status, `${code}@${status}`).toBe(502);
        expect((await res.json()).error.code).toBe('internal_error');
      }
    }
  });

  it('codes del OTRO proxy en su status canonico => 502 sin reflejarse', async () => {
    for (const [code, status] of [
      ['insufficient_permissions', 403],
      ['not_found', 404],
      ['merchant_onboarding_already_completed', 409],
    ] as const) {
      stubBackend(status, { error: { code } });
      const res = await callOrg();
      expect(res.status, `${code}@${status}`).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe('internal_error');
      expect(text).not.toContain(code);
    }
  });

  it('error de red del backend => 502 estable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED')))
    );
    await expectBadGateway(await callOrg());
  });
});

describe('RA-F65C2-EXT-004 — proxy de merchant: pareja code/status exacta', () => {
  it('cada code SOLO es contractual con su status canonico; la respuesta se reconstruye con el', async () => {
    for (const [code, status] of MERCHANT_CANONICAL_PAIRS) {
      stubBackend(status, { error: { code } });
      const res = await callMerchant();
      expect(res.status, `${code}@${status}`).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
  });

  it('cada code con un status INCORRECTO => 502 (jamas se preserva el status backend)', async () => {
    const wrongByCode: Record<string, number[]> = {
      validation_error: [401, 404],
      invalid_session: [400, 403],
      insufficient_permissions: [401, 404],
      not_found: [403, 409],
      merchant_onboarding_already_completed: [400, 404],
      internal_error: [400, 401, 403, 404, 409],
    };
    for (const [code, statuses] of Object.entries(wrongByCode)) {
      for (const status of statuses) {
        stubBackend(status, { error: { code } });
        const res = await callMerchant();
        expect(res.status, `${code}@${status}`).toBe(502);
        expect((await res.json()).error.code).toBe('internal_error');
      }
    }
  });

  it('codes del OTRO proxy en su status canonico => 502 sin reflejarse', async () => {
    for (const [code, status] of [
      ['email_not_verified', 403],
      ['organization_slug_taken', 409],
      ['onboarding_already_completed', 409],
    ] as const) {
      stubBackend(status, { error: { code } });
      const res = await callMerchant();
      expect(res.status, `${code}@${status}`).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe('internal_error');
      expect(text).not.toContain(code);
    }
  });

  it('error de red del backend => 502 estable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED')))
    );
    await expectBadGateway(await callMerchant());
  });
});
