import { describe, expect, it, vi } from 'vitest';
import { fetchDashboardData, fetchOrganizations, login } from '../app/lib/api';

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
