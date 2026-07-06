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

/**
 * Roles que pueden GOBERNAR la conciliación (permiso RBAC `reconciliation:manage`;
 * espeja `ROLE_PERMISSIONS` en @fluvia/identity: owner/admin/finance). Como
 * `canResendRole`, es solo una PISTA de UX — el API es la fuente de verdad y
 * rechaza (403 `insufficient_permissions`) a quien no lo tenga. Autorizar dinero
 * es un acto humano: una API key jamás alcanza este plano.
 */
const RECONCILIATION_MANAGE_ROLES = new Set(['owner', 'admin', 'finance']);
export function canManageReconciliation(role: string | undefined): boolean {
  return role !== undefined && RECONCILIATION_MANAGE_ROLES.has(role);
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

// --- casos operativos + ajustes con four-eyes (F4-03c-ii) ---
export type CaseStatus = 'open' | 'acknowledged' | 'resolved';
export type CaseSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AdjustmentDirection = 'debit_differences' | 'credit_differences';
export type AdjustmentStatus = 'proposed' | 'applied' | 'rejected';

export interface OperationalCase {
  id: string;
  case_type: string;
  severity: CaseSeverity;
  status: CaseStatus;
  reconciliation_entry_id: string;
  report_id: string | null;
  provider: string | null;
  provider_ref: string | null;
  discrepancy_status: string | null;
  ledger_amount: number | null;
  provider_amount: number | null;
  assignee_user_id: string | null;
  resolution: string | null;
  resolved_by_user_id: string | null;
  version: number;
  created_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

export interface CaseAdjustment {
  id: string;
  case_id: string;
  amount: number;
  currency: string;
  direction: AdjustmentDirection;
  reason: string;
  status: AdjustmentStatus;
  requires_second_approval: boolean;
  proposed_by_user_id: string;
  approved_by_user_id: string | null;
  rejected_by_user_id: string | null;
  rejection_reason: string | null;
  ledger_transaction_id: string | null;
  version: number;
  created_at: string;
  decided_at: string | null;
}

/** El detalle de un caso trae sus ajustes embebidos (como la ruta de sesión). */
export type OperationalCaseDetail = OperationalCase & { adjustments: CaseAdjustment[] };

export async function fetchOperationalCases(
  opts: ClientOptions & { orgId: string; status?: CaseStatus; severity?: CaseSeverity }
): Promise<OperationalCase[]> {
  const params = new URLSearchParams({ limit: '200' });
  if (opts.status) params.set('status', opts.status);
  if (opts.severity) params.set('severity', opts.severity);
  const body = await apiGet<{ data?: OperationalCase[] }>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/operational_cases?${params.toString()}`
  );
  return body?.data ?? [];
}

export async function fetchOperationalCase(
  opts: ClientOptions & { orgId: string; caseId: string }
): Promise<OperationalCaseDetail | null> {
  return apiGet<OperationalCaseDetail>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/operational_cases/${encodeURIComponent(opts.caseId)}`
  );
}

/** ¿Hay un ajuste VIVO (proposed/applied)? Bloquea proponer otro (índice único
 * parcial en la BD `WHERE status<>'rejected'`); la UI oculta el formulario. */
export function liveAdjustment(adjustments: CaseAdjustment[]): CaseAdjustment | undefined {
  return adjustments.find((a) => a.status !== 'rejected');
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
