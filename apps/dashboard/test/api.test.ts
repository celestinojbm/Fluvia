import { describe, expect, it, vi } from 'vitest';
import {
  canManageReconciliation,
  canResendRole,
  fetchDashboardData,
  fetchMerchants,
  fetchOperationalCase,
  fetchOperationalCases,
  fetchOrganizations,
  filterMerchants,
  liveAdjustment,
  login,
  type CaseAdjustment,
  type Merchant,
} from '../app/lib/api';

/**
 * F3-09b — lógica pura del cliente de la API (server-side), probada en CI sin
 * red ni navegador vía `fetchImpl` inyectable.
 */

function jsonFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return vi.fn((url: string) => {
    const match = Object.keys(routes).find((k) => url.includes(k));
    const r = match ? routes[match]! : { status: 404, body: {} };
    return Promise.resolve({
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: () => Promise.resolve(r.body),
    });
  }) as unknown as typeof fetch;
}

describe('login', () => {
  it('returns the session token on the non-MFA path', async () => {
    const res = await login({
      apiBase: 'http://api',
      email: 'a@b.co',
      password: 'x',
      fetchImpl: jsonFetch({
        '/v1/auth/login': { body: { mfa_required: false, session_token: 'sess_1' } },
      }),
    });
    expect(res).toEqual({ ok: true, sessionToken: 'sess_1' });
  });

  it('flags MFA-required accounts without pretending to log in', async () => {
    const res = await login({
      apiBase: 'http://api',
      email: 'a@b.co',
      password: 'x',
      fetchImpl: jsonFetch({
        '/v1/auth/login': { body: { mfa_required: true, challenge_token: 'c' } },
      }),
    });
    expect(res).toEqual({ ok: false, mfaRequired: true });
  });

  it('reports invalid credentials (401) as a non-ok result', async () => {
    const res = await login({
      apiBase: 'http://api',
      email: 'a@b.co',
      password: 'bad',
      fetchImpl: jsonFetch({ '/v1/auth/login': { status: 401, body: {} } }),
    });
    expect(res).toEqual({ ok: false, mfaRequired: false });
  });
});

describe('canResendRole', () => {
  it('allows integration-managing roles and rejects read-only ones', () => {
    for (const r of ['owner', 'admin', 'developer']) expect(canResendRole(r)).toBe(true);
    for (const r of ['finance', 'support', 'analyst', 'read_only', undefined]) {
      expect(canResendRole(r)).toBe(false);
    }
  });
});

describe('canManageReconciliation', () => {
  it('allows money-governing roles (owner/admin/finance) and rejects the rest', () => {
    // Espeja ROLE_PERMISSIONS de @fluvia/identity: reconciliation:manage.
    for (const r of ['owner', 'admin', 'finance']) expect(canManageReconciliation(r)).toBe(true);
    for (const r of ['developer', 'read_only', 'support', undefined]) {
      expect(canManageReconciliation(r)).toBe(false);
    }
  });
});

function adj(status: CaseAdjustment['status']): CaseAdjustment {
  return {
    id: `adj_${status}`,
    case_id: 'c1',
    amount: 9_000,
    currency: 'COP',
    direction: 'debit_differences',
    reason: 'r',
    status,
    requires_second_approval: true,
    proposed_by_user_id: 'u1',
    approved_by_user_id: null,
    rejected_by_user_id: null,
    rejection_reason: null,
    ledger_transaction_id: null,
    version: 1,
    created_at: '2026-07-06T00:00:00Z',
    decided_at: null,
  };
}

describe('liveAdjustment', () => {
  it('finds a proposed/applied adjustment but ignores rejected ones', () => {
    expect(liveAdjustment([adj('rejected')])).toBeUndefined();
    expect(liveAdjustment([adj('rejected'), adj('proposed')])?.status).toBe('proposed');
    expect(liveAdjustment([adj('applied')])?.status).toBe('applied');
    expect(liveAdjustment([])).toBeUndefined();
  });
});

describe('operational cases fetchers', () => {
  it('fetchOperationalCases passes status/severity filters and degrades to []', async () => {
    const spy = fakeFetch(200, { data: [{ id: 'case_1' }] });
    const ok = await fetchOperationalCases({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      status: 'open',
      fetchImpl: spy,
    });
    expect(ok).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('status=open'), expect.anything());
    const bad = await fetchOperationalCases({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: fakeFetch(403, {}),
    });
    expect(bad).toEqual([]);
  });

  it('fetchOperationalCase returns the detail and null on error', async () => {
    const ok = await fetchOperationalCase({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      caseId: 'case_1',
      fetchImpl: fakeFetch(200, { id: 'case_1', adjustments: [] }),
    });
    expect(ok?.id).toBe('case_1');
    const missing = await fetchOperationalCase({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      caseId: 'nope',
      fetchImpl: fakeFetch(404, {}),
    });
    expect(missing).toBeNull();
  });
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(() =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
  ) as unknown as typeof fetch;
}

function merchant(over: Partial<Merchant> = {}): Merchant {
  return {
    id: 'mer_abc',
    name: 'Acme',
    country: 'CO',
    defaultCurrency: 'COP',
    status: 'active',
    createdAt: '2026-07-06T00:00:00Z',
    ...over,
  };
}

describe('fetchMerchants', () => {
  it('returns the merchants list and degrades to [] on error', async () => {
    const ok = await fetchMerchants({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: fakeFetch(200, { merchants: [merchant()] }),
    });
    expect(ok).toHaveLength(1);
    const bad = await fetchMerchants({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: fakeFetch(403, {}),
    });
    expect(bad).toEqual([]);
  });
});

describe('filterMerchants', () => {
  const list = [
    merchant({ id: 'mer_1', name: 'Tienda Norte', country: 'CO', defaultCurrency: 'COP' }),
    merchant({ id: 'mer_2', name: 'Shop South', country: 'US', defaultCurrency: 'USD' }),
  ];
  it('returns everything for an empty/blank query', () => {
    expect(filterMerchants(list, undefined)).toHaveLength(2);
    expect(filterMerchants(list, '   ')).toHaveLength(2);
  });
  it('matches case-insensitively on name, id, country and currency', () => {
    expect(filterMerchants(list, 'norte').map((m) => m.id)).toEqual(['mer_1']);
    expect(filterMerchants(list, 'MER_2').map((m) => m.id)).toEqual(['mer_2']);
    expect(filterMerchants(list, 'us').map((m) => m.id)).toEqual(['mer_2']);
    expect(filterMerchants(list, 'cop').map((m) => m.id)).toEqual(['mer_1']);
    expect(filterMerchants(list, 'nomatch')).toEqual([]);
  });
});

describe('fetchOrganizations', () => {
  it('returns the memberships list', async () => {
    const orgs = await fetchOrganizations({
      apiBase: 'http://api',
      token: 't',
      fetchImpl: jsonFetch({
        '/v1/organizations': {
          body: { organizations: [{ organization_id: 'o1', name: 'A', slug: 'a', role: 'owner' }] },
        },
      }),
    });
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.organization_id).toBe('o1');
  });

  it('degrades to an empty list on error', async () => {
    const orgs = await fetchOrganizations({
      apiBase: 'http://api',
      token: 't',
      fetchImpl: jsonFetch({ '/v1/organizations': { status: 500, body: {} } }),
    });
    expect(orgs).toEqual([]);
  });
});

describe('fetchDashboardData', () => {
  it('aggregates the five read-plane lists', async () => {
    const data = await fetchDashboardData({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: jsonFetch({
        payment_intents: { body: { data: [{ id: 'pi_1' }] } },
        refunds: { body: { data: [] } },
        checkout_sessions: { body: { data: [{ id: 'cs_1' }, { id: 'cs_2' }] } },
        payment_links: { body: { data: [{ id: 'pl_1' }] } },
        webhook_events: { body: { data: [{ id: 'whe_1' }] } },
      }),
    });
    expect(data.intents.map((i) => i.id)).toEqual(['pi_1']);
    expect(data.sessions).toHaveLength(2);
    expect(data.refunds).toEqual([]);
    expect(data.webhookEvents[0]!.id).toBe('whe_1');
  });

  it('degrades a failing resource to an empty list without dropping the others', async () => {
    const data = await fetchDashboardData({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: jsonFetch({
        payment_intents: { body: { data: [{ id: 'pi_1' }] } },
        refunds: { status: 403, body: {} },
        checkout_sessions: { body: { data: [] } },
        payment_links: { body: { data: [] } },
        webhook_events: { body: { data: [] } },
      }),
    });
    expect(data.intents).toHaveLength(1);
    expect(data.refunds).toEqual([]);
  });
});
