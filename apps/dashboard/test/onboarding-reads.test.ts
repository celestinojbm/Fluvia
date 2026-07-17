import { describe, expect, it, vi } from 'vitest';
import { readMerchants, readOrganizations } from '../app/lib/onboarding-reads';

/**
 * RA-F65C2-EXT-003 — helpers de lectura ESTRICTOS de /onboarding: solo el
 * status exacto contractual (200) con JSON valido y shape valido produce
 * `ok:true`; 401/403/404/5xx/red/JSON invalido/shape invalido son fallos
 * TIPADOS (jamas lista vacia) y una respuesta con shape invalido no aporta
 * datos parciales.
 */

const OPTS = { apiBase: 'http://api.local', token: 'session-token-test' };

function stub(status: number, body?: unknown, rawBody?: string) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(
        rawBody !== undefined ? rawBody : body === undefined ? null : JSON.stringify(body),
        { status }
      )
    )
  ) as unknown as typeof fetch;
}

const networkFail = () =>
  vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;

const GOOD_ORG = { organization_id: 'a', name: 'Empresa A', slug: 'empresa-a', role: 'owner' };
const GOOD_MERCHANT = { id: 'm-1', name: 'Tienda', country: 'CO', defaultCurrency: 'COP' };

describe('readOrganizations (estricto, fail-closed)', () => {
  it('200 con array vacio valido => ok:true []; 200 con entradas validas => ok:true (tipadas)', async () => {
    expect(
      await readOrganizations({ ...OPTS, fetchImpl: stub(200, { organizations: [] }) })
    ).toEqual({ ok: true, value: [] });
    const res = await readOrganizations({
      ...OPTS,
      fetchImpl: stub(200, { organizations: [GOOD_ORG] }),
    });
    expect(res).toEqual({ ok: true, value: [GOOD_ORG] });
  });

  it('HTTP 500 => http_error; 401 => unauthorized; 403 => forbidden (JAMAS lista vacia)', async () => {
    expect(await readOrganizations({ ...OPTS, fetchImpl: stub(500, {}) })).toEqual({
      ok: false,
      kind: 'http_error',
    });
    expect(await readOrganizations({ ...OPTS, fetchImpl: stub(401, {}) })).toEqual({
      ok: false,
      kind: 'unauthorized',
    });
    expect(await readOrganizations({ ...OPTS, fetchImpl: stub(403, {}) })).toEqual({
      ok: false,
      kind: 'forbidden',
    });
  });

  it('JSON invalido / shape invalido / error de red => fallo tipado sin datos parciales', async () => {
    expect(
      await readOrganizations({ ...OPTS, fetchImpl: stub(200, undefined, 'not-json{') })
    ).toEqual({ ok: false, kind: 'invalid_response' });
    // `organizations` no-array.
    expect(
      await readOrganizations({ ...OPTS, fetchImpl: stub(200, { organizations: 'nope' }) })
    ).toEqual({ ok: false, kind: 'invalid_response' });
    // Una entrada invalida invalida TODA la respuesta (cero datos parciales).
    expect(
      await readOrganizations({
        ...OPTS,
        fetchImpl: stub(200, { organizations: [GOOD_ORG, { organization_id: 42 }] }),
      })
    ).toEqual({ ok: false, kind: 'invalid_response' });
    expect(await readOrganizations({ ...OPTS, fetchImpl: networkFail() })).toEqual({
      ok: false,
      kind: 'network_error',
    });
  });

  it('otros 2xx / redirects NO son contractuales (solo 200 exacto)', async () => {
    expect(await readOrganizations({ ...OPTS, fetchImpl: stub(204) })).toEqual({
      ok: false,
      kind: 'http_error',
    });
    expect(await readOrganizations({ ...OPTS, fetchImpl: stub(307) })).toEqual({
      ok: false,
      kind: 'http_error',
    });
  });
});

describe('readMerchants (estricto, fail-closed)', () => {
  const M_OPTS = { ...OPTS, orgId: 'org-1' };

  it('200 valido: 0 => []; 1 => uno tipado; 2 => dos (la cardinalidad la decide el resolutor)', async () => {
    expect(await readMerchants({ ...M_OPTS, fetchImpl: stub(200, { merchants: [] }) })).toEqual({
      ok: true,
      value: [],
    });
    expect(
      await readMerchants({ ...M_OPTS, fetchImpl: stub(200, { merchants: [GOOD_MERCHANT] }) })
    ).toEqual({ ok: true, value: [GOOD_MERCHANT] });
    const two = await readMerchants({
      ...M_OPTS,
      fetchImpl: stub(200, { merchants: [GOOD_MERCHANT, { ...GOOD_MERCHANT, id: 'm-2' }] }),
    });
    expect(two.ok).toBe(true);
    expect((two as { ok: true; value: unknown[] }).value).toHaveLength(2);
  });

  it('HTTP 500/401/403/404 => fallo tipado (http_error/unauthorized/forbidden/not_found)', async () => {
    for (const [status, kind] of [
      [500, 'http_error'],
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
    ] as const) {
      expect(await readMerchants({ ...M_OPTS, fetchImpl: stub(status, {}) })).toEqual({
        ok: false,
        kind,
      });
    }
  });

  it('JSON invalido / shape invalido / error de red => fallo tipado sin datos parciales', async () => {
    expect(await readMerchants({ ...M_OPTS, fetchImpl: stub(200, undefined, '{{{') })).toEqual({
      ok: false,
      kind: 'invalid_response',
    });
    expect(await readMerchants({ ...M_OPTS, fetchImpl: stub(200, { merchants: null }) })).toEqual({
      ok: false,
      kind: 'invalid_response',
    });
    expect(
      await readMerchants({
        ...M_OPTS,
        fetchImpl: stub(200, { merchants: [GOOD_MERCHANT, { id: '', name: 'X' }] }),
      })
    ).toEqual({ ok: false, kind: 'invalid_response' });
    expect(await readMerchants({ ...M_OPTS, fetchImpl: networkFail() })).toEqual({
      ok: false,
      kind: 'network_error',
    });
  });
});
