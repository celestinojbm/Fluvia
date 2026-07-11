import { describe, expect, it, vi } from 'vitest';
import {
  canManageReconciliation,
  canReadAudit,
  canResendRole,
  fetchAuditEvents,
  fetchCheckoutSession,
  fetchCheckoutSessions,
  fetchDashboardData,
  fetchMerchants,
  fetchOperationalCase,
  fetchOperationalCases,
  fetchOrganizations,
  fetchPaymentIntent,
  fetchPaymentIntents,
  fetchPaymentLink,
  fetchPaymentLinks,
  fetchRefund,
  fetchRefunds,
  filterMerchants,
  liveAdjustment,
  login,
  paymentTimeline,
  sessionsForIntent,
  type CaseAdjustment,
  type CheckoutSession,
  type Merchant,
  type PaymentIntent,
  type Refund,
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

describe('canReadAudit', () => {
  it('allows audit-reading roles (owner/admin/finance/analyst) and rejects the rest', () => {
    for (const r of ['owner', 'admin', 'finance', 'analyst']) expect(canReadAudit(r)).toBe(true);
    for (const r of ['developer', 'support', 'read_only', undefined]) {
      expect(canReadAudit(r)).toBe(false);
    }
  });
});

describe('fetchAuditEvents', () => {
  it('returns events with the cursor and passes ?before, degrading on error', async () => {
    const spy = fakeFetch(200, {
      audit_events: [{ id: '42', action: 'x' }],
      next_before: '42',
    });
    const ok = await fetchAuditEvents({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      before: '99',
      fetchImpl: spy,
    });
    expect(ok.events).toHaveLength(1);
    expect(ok.nextBefore).toBe('42');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('before=99'), expect.anything());

    const bad = await fetchAuditEvents({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: fakeFetch(403, {}),
    });
    expect(bad).toEqual({ events: [], nextBefore: null });
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

// ── F6.5A — superficie de pagos (solo lectura por sesión) ─────────────────────

const INTENT: PaymentIntent = {
  id: 'pi_abcdef123456',
  merchant_id: 'mer_1',
  amount: 90_000,
  currency: 'COP',
  status: 'succeeded',
  capture_method: 'automatic',
  amount_captured: 90_000,
  amount_refunded: 40_000,
  failure_code: null,
  created_at: '2026-07-05T10:00:00Z',
};

const REFUND: Refund = {
  id: 're_1',
  payment_intent_id: 'pi_abcdef123456',
  amount: 40_000,
  currency: 'COP',
  status: 'succeeded',
  reason: null,
  failure_code: null,
  created_at: '2026-07-05T12:00:00Z',
};

function session(over: Partial<CheckoutSession>): CheckoutSession {
  return {
    id: 'cs_1',
    payment_intent_id: 'pi_abcdef123456',
    customer_id: null,
    status: 'completed',
    url: 'http://localhost:3100/c/cs_1',
    success_url: null,
    cancel_url: null,
    expires_at: '2026-07-05T11:00:00Z',
    completed_at: '2026-07-05T10:30:00Z',
    created_at: '2026-07-05T10:05:00Z',
    ...over,
  };
}

describe('payments-surface fetchers (F6.5A)', () => {
  it('scope every request to the organization path (tenant isolation client-side)', async () => {
    for (const call of [
      () =>
        fetchPaymentIntents({
          apiBase: 'http://api',
          token: 't',
          orgId: 'o/1',
          fetchImpl: jsonFetch({}),
        }),
      () =>
        fetchRefunds({ apiBase: 'http://api', token: 't', orgId: 'o/1', fetchImpl: jsonFetch({}) }),
      () =>
        fetchCheckoutSessions({
          apiBase: 'http://api',
          token: 't',
          orgId: 'o/1',
          fetchImpl: jsonFetch({}),
        }),
      () =>
        fetchPaymentLinks({
          apiBase: 'http://api',
          token: 't',
          orgId: 'o/1',
          fetchImpl: jsonFetch({}),
        }),
    ]) {
      await call();
    }
    // La URL SIEMPRE va bajo /v1/organizations/{orgId}/… con el orgId escapado:
    // el navegador jamás elige el tenant — lo hace la membresía en el API.
    const f = jsonFetch({});
    await fetchPaymentIntents({ apiBase: 'http://api', token: 't', orgId: 'o/1', fetchImpl: f });
    const url = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0];
    expect(url).toContain('/v1/organizations/o%2F1/payment_intents');
  });

  it('fetchPaymentIntents returns the list and degrades to [] on 403 (RBAC lo decide el API)', async () => {
    const ok = await fetchPaymentIntents({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: jsonFetch({ payment_intents: { body: { data: [INTENT] } } }),
    });
    expect(ok).toHaveLength(1);
    const denied = await fetchPaymentIntents({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      fetchImpl: jsonFetch({ payment_intents: { status: 403, body: {} } }),
    });
    expect(denied).toEqual([]);
  });

  it('fetchPaymentIntent returns the object, or null on not-found', async () => {
    const ok = await fetchPaymentIntent({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      paymentId: 'pi_abcdef123456',
      fetchImpl: jsonFetch({ 'payment_intents/pi_abcdef123456': { body: INTENT } }),
    });
    expect(ok?.id).toBe('pi_abcdef123456');
    const missing = await fetchPaymentIntent({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      paymentId: 'nope',
      fetchImpl: jsonFetch({}),
    });
    expect(missing).toBeNull();
  });

  it('fetchRefunds filters by payment intent via the API query param', async () => {
    const f = jsonFetch({ refunds: { body: { data: [REFUND] } } });
    const list = await fetchRefunds({
      apiBase: 'http://api',
      token: 't',
      orgId: 'o1',
      paymentIntentId: 'pi_abcdef123456',
      fetchImpl: f,
    });
    expect(list).toHaveLength(1);
    const url = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0];
    expect(url).toContain('payment_intent_id=pi_abcdef123456');
  });

  it('fetchRefund / fetchCheckoutSession / fetchPaymentLink return null on not-found', async () => {
    const none = jsonFetch({});
    expect(
      await fetchRefund({
        apiBase: 'http://api',
        token: 't',
        orgId: 'o1',
        refundId: 'x',
        fetchImpl: none,
      })
    ).toBeNull();
    expect(
      await fetchCheckoutSession({
        apiBase: 'http://api',
        token: 't',
        orgId: 'o1',
        sessionId: 'x',
        fetchImpl: none,
      })
    ).toBeNull();
    expect(
      await fetchPaymentLink({
        apiBase: 'http://api',
        token: 't',
        orgId: 'o1',
        linkId: 'x',
        fetchImpl: none,
      })
    ).toBeNull();
  });
});

describe('sessionsForIntent', () => {
  it('keeps only the sessions of the given payment intent', () => {
    const mine = session({ id: 'cs_mine' });
    const other = session({ id: 'cs_other', payment_intent_id: 'pi_other' });
    expect(sessionsForIntent([mine, other], 'pi_abcdef123456')).toEqual([mine]);
  });
});

describe('paymentTimeline', () => {
  it('derives entries from persisted timestamps in chronological order', () => {
    const entries = paymentTimeline(INTENT, [REFUND], [session({})]);
    expect(entries.map((e) => e.kind)).toEqual([
      'payment_created',
      'session_created',
      'session_completed',
      'refund_created',
    ]);
    expect(entries.map((e) => e.at)).toEqual([...entries.map((e) => e.at)].sort());
  });

  it('does not invent a completion entry when the session never completed', () => {
    const entries = paymentTimeline(INTENT, [], [session({ completed_at: null, status: 'open' })]);
    expect(entries.map((e) => e.kind)).toEqual(['payment_created', 'session_created']);
  });
});
