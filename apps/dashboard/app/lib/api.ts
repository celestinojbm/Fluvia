/**
 * Cliente de la API de Fluvia — SOLO server-side. Toda llamada reenvía el token
 * de sesión (cookie httpOnly) como `Authorization: Bearer`; el navegador jamás
 * conoce la URL de la API ni sostiene el token. Todo es inyectable (`fetchImpl`)
 * para probar la lógica en CI sin red ni navegador.
 */

const DEFAULT_API = 'http://127.0.0.1:3000';

export function apiBase(): string {
  return process.env.FLUVIA_API_URL ?? DEFAULT_API;
}

export interface Org {
  organization_id: string;
  name: string;
  slug: string;
  role: string;
}

/**
 * Roles que pueden reenviar webhooks `dead` (permiso RBAC `webhooks:manage`;
 * espeja `ROLE_PERMISSIONS` en @fluvia/identity). Solo es una PISTA de UX: el API
 * es la fuente de verdad y rechaza (403) a quien no lo tenga.
 */
const RESEND_ROLES = new Set(['owner', 'admin', 'developer']);
export function canResendRole(role: string | undefined): boolean {
  return role !== undefined && RESEND_ROLES.has(role);
}

export type LoginResult =
  | { ok: true; sessionToken: string }
  | { ok: false; mfaRequired: true }
  | { ok: false; mfaRequired: false };

export interface ClientOptions {
  apiBase: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

async function apiGet<T>(opts: ClientOptions, path: string): Promise<T | null> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`${opts.apiBase}${path}`, {
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Login (solo la vía sin MFA entrega sesión; MFA queda fuera de alcance aquí). */
export async function login(opts: {
  apiBase: string;
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
}): Promise<LoginResult> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`${opts.apiBase}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: opts.email, password: opts.password }),
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, mfaRequired: false };
    const body = (await res.json()) as {
      mfa_required?: boolean;
      session_token?: string;
    };
    if (body.mfa_required) return { ok: false, mfaRequired: true };
    if (typeof body.session_token === 'string' && body.session_token) {
      return { ok: true, sessionToken: body.session_token };
    }
    return { ok: false, mfaRequired: false };
  } catch {
    return { ok: false, mfaRequired: false };
  }
}

export async function fetchOrganizations(opts: ClientOptions): Promise<Org[]> {
  const body = await apiGet<{ organizations: Org[] }>(opts, '/v1/organizations');
  return body?.organizations ?? [];
}

export interface DashboardData {
  intents: Record<string, unknown>[];
  refunds: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  links: Record<string, unknown>[];
  webhookEvents: Record<string, unknown>[];
}

type ListBody = { data?: Record<string, unknown>[] };

// --- conciliación (F4-01c) ---
export type ReconciliationStatus =
  'matched' | 'amount_mismatch' | 'missing_in_ledger' | 'missing_at_provider';
export type ReconciliationSummary = Record<ReconciliationStatus, number>;

export interface SettlementReport {
  id: string;
  provider: string;
  currency: string;
  period_start: string;
  period_end: string;
  status: string;
  created_at: string;
  reconciled_at: string | null;
  summary?: ReconciliationSummary;
}

export interface ReconciliationEntry {
  provider_ref: string;
  status: ReconciliationStatus;
  ledger_amount: number | null;
  provider_amount: number | null;
  payment_intent_id: string | null;
}

export async function fetchSettlementReports(
  opts: ClientOptions & { orgId: string }
): Promise<SettlementReport[]> {
  const body = await apiGet<{ data?: SettlementReport[] }>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/settlement_reports?limit=100`
  );
  return body?.data ?? [];
}

export async function fetchSettlementReport(
  opts: ClientOptions & { orgId: string; reportId: string }
): Promise<SettlementReport | null> {
  return apiGet<SettlementReport>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/settlement_reports/${encodeURIComponent(opts.reportId)}`
  );
}

export async function fetchReconciliationEntries(
  opts: ClientOptions & { orgId: string; reportId: string; status?: ReconciliationStatus }
): Promise<ReconciliationEntry[]> {
  const q = opts.status ? `?status=${encodeURIComponent(opts.status)}` : '';
  const body = await apiGet<{ data?: ReconciliationEntry[] }>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/settlement_reports/${encodeURIComponent(opts.reportId)}/entries${q}`
  );
  return body?.data ?? [];
}

/**
 * Trae las 5 vistas del plano de lectura de operación en paralelo. El fallo de
 * un recurso (p.ej. permiso o red) degrada a lista vacía sin tumbar el panel.
 */
export async function fetchDashboardData(
  opts: ClientOptions & { orgId: string }
): Promise<DashboardData> {
  const g = (resource: string) =>
    apiGet<ListBody>(opts, `/v1/organizations/${encodeURIComponent(opts.orgId)}/${resource}`).then(
      (b) => b?.data ?? []
    );
  const [intents, refunds, sessions, links, webhookEvents] = await Promise.all([
    g('payment_intents'),
    g('refunds'),
    g('checkout_sessions'),
    g('payment_links'),
    g('webhook_events'),
  ]);
  return { intents, refunds, sessions, links, webhookEvents };
}
