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

// --- payouts (F4-07d: money out, lectura por sesión) ---
export interface Payout {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  failure_code: string | null;
  created_at: string;
}

export async function fetchPayouts(opts: ClientOptions & { orgId: string }): Promise<Payout[]> {
  const body = await apiGet<{ data?: Payout[] }>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/payouts?limit=100`
  );
  return body?.data ?? [];
}

export async function fetchPayout(
  opts: ClientOptions & { orgId: string; payoutId: string }
): Promise<Payout | null> {
  return apiGet<Payout>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/payouts/${encodeURIComponent(opts.payoutId)}`
  );
}

// --- disputas (F4-08d: money clawed back, lectura por sesión) ---
export interface Dispute {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  provider_ref: string | null;
  created_at: string;
}

export async function fetchDisputes(opts: ClientOptions & { orgId: string }): Promise<Dispute[]> {
  const body = await apiGet<{ data?: Dispute[] }>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/disputes?limit=100`
  );
  return body?.data ?? [];
}

export async function fetchDispute(
  opts: ClientOptions & { orgId: string; disputeId: string }
): Promise<Dispute | null> {
  return apiGet<Dispute>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/disputes/${encodeURIComponent(opts.disputeId)}`
  );
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

// --- panel admin: comercios (F4-04a) ---
export interface Merchant {
  id: string;
  name: string;
  country: string;
  defaultCurrency: string;
  status: 'active' | 'frozen';
  createdAt: string;
}

export async function fetchMerchants(opts: ClientOptions & { orgId: string }): Promise<Merchant[]> {
  const body = await apiGet<{ merchants?: Merchant[] }>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/merchants`
  );
  return body?.merchants ?? [];
}

/**
 * «Buscar comercios»: filtro puro sobre la lista ya traída (la lista por org es
 * pequeña). Casa por nombre, id, país o moneda, sin distinguir mayúsculas.
 * Cadena vacía ⇒ todo. Testeable sin red ni navegador.
 */
export function filterMerchants(merchants: Merchant[], query: string | undefined): Merchant[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return merchants;
  return merchants.filter((m) =>
    [m.name, m.id, m.country, m.defaultCurrency].some((f) => f.toLowerCase().includes(q))
  );
}

// --- panel admin: eventos de auditoría (F4-04b) ---
/**
 * Roles que pueden LEER la auditoría (permiso RBAC `audit:read`; espeja
 * `ROLE_PERMISSIONS`: owner/admin/finance/analyst). Solo es un hint de UX para
 * ocultar el enlace a quien no puede — el API es la fuente de verdad (403).
 */
const AUDIT_READ_ROLES = new Set(['owner', 'admin', 'finance', 'analyst']);
export function canReadAudit(role: string | undefined): boolean {
  return role !== undefined && AUDIT_READ_ROLES.has(role);
}

export interface AuditEvent {
  id: string;
  actor_type: string;
  actor_id: string | null;
  auth_method: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  result: string;
  risk_level: string;
  reason: string | null;
  request_id: string | null;
  created_at: string;
}

export interface AuditEventsPage {
  events: AuditEvent[];
  /** Cursor (id del último evento) para la página anterior/más antigua. */
  nextBefore: string | null;
}

export async function fetchAuditEvents(
  opts: ClientOptions & { orgId: string; before?: string }
): Promise<AuditEventsPage> {
  const params = new URLSearchParams({ limit: '50' });
  if (opts.before) params.set('before', opts.before);
  const body = await apiGet<{ audit_events?: AuditEvent[]; next_before?: string | null }>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/audit-events?${params.toString()}`
  );
  return { events: body?.audit_events ?? [], nextBefore: body?.next_before ?? null };
}

// --- superficie de pagos (F6.5A) — SOLO LECTURA por sesión ---
// Consume exclusivamente los GET existentes del plano de lectura del dashboard
// (`security.org('payments:read')`, permiso que tiene todo rol). Las acciones de
// escritura (crear refund, crear payment link) viven HOY solo en el plano de
// integración (API key, scope `payments:write`): no existen por sesión y este
// cliente no las inventa — el gap se reporta, no se puentea.

export interface PaymentIntent {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: string;
  capture_method: string;
  amount_captured: number;
  amount_refunded: number;
  failure_code: string | null;
  created_at: string;
}

export interface Refund {
  id: string;
  payment_intent_id: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  failure_code: string | null;
  created_at: string;
}

export interface CheckoutSession {
  id: string;
  payment_intent_id: string;
  customer_id: string | null;
  status: string;
  url: string;
  success_url: string | null;
  cancel_url: string | null;
  expires_at: string;
  completed_at: string | null;
  created_at: string;
}

export interface PaymentLink {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  description: string | null;
  status: string;
  url: string;
  created_at: string;
  disabled_at: string | null;
}

export async function fetchPaymentIntents(
  opts: ClientOptions & { orgId: string }
): Promise<PaymentIntent[]> {
  const body = await apiGet<{ data?: PaymentIntent[] }>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/payment_intents?limit=100`
  );
  return body?.data ?? [];
}

export async function fetchPaymentIntent(
  opts: ClientOptions & { orgId: string; paymentId: string }
): Promise<PaymentIntent | null> {
  return apiGet<PaymentIntent>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/payment_intents/${encodeURIComponent(opts.paymentId)}`
  );
}

export async function fetchRefunds(
  opts: ClientOptions & { orgId: string; paymentIntentId?: string }
): Promise<Refund[]> {
  const params = new URLSearchParams({ limit: '100' });
  if (opts.paymentIntentId) params.set('payment_intent_id', opts.paymentIntentId);
  const body = await apiGet<{ data?: Refund[] }>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/refunds?${params.toString()}`
  );
  return body?.data ?? [];
}

export async function fetchRefund(
  opts: ClientOptions & { orgId: string; refundId: string }
): Promise<Refund | null> {
  return apiGet<Refund>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/refunds/${encodeURIComponent(opts.refundId)}`
  );
}

export async function fetchCheckoutSessions(
  opts: ClientOptions & { orgId: string }
): Promise<CheckoutSession[]> {
  const body = await apiGet<{ data?: CheckoutSession[] }>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/checkout_sessions?limit=100`
  );
  return body?.data ?? [];
}

export async function fetchCheckoutSession(
  opts: ClientOptions & { orgId: string; sessionId: string }
): Promise<CheckoutSession | null> {
  return apiGet<CheckoutSession>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/checkout_sessions/${encodeURIComponent(opts.sessionId)}`
  );
}

export async function fetchPaymentLinks(
  opts: ClientOptions & { orgId: string }
): Promise<PaymentLink[]> {
  const body = await apiGet<{ data?: PaymentLink[] }>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/payment_links?limit=100`
  );
  return body?.data ?? [];
}

export async function fetchPaymentLink(
  opts: ClientOptions & { orgId: string; linkId: string }
): Promise<PaymentLink | null> {
  return apiGet<PaymentLink>(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/payment_links/${encodeURIComponent(opts.linkId)}`
  );
}

/** Sesiones de checkout de un pago: filtro puro sobre la lista ya traída (la
 * sesión expone `payment_intent_id`; no existe endpoint por-intent). */
export function sessionsForIntent(
  sessions: CheckoutSession[],
  paymentIntentId: string
): CheckoutSession[] {
  return sessions.filter((s) => s.payment_intent_id === paymentIntentId);
}

// Línea de tiempo del pago: DERIVADA de los timestamps persistidos del intent y
// sus recursos relacionados (sesiones y refunds) — no existe un event-log por
// pago en el API y esta vista no lo simula.
export type TimelineKind =
  'payment_created' | 'session_created' | 'session_completed' | 'refund_created';

export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  refId: string;
  status: string;
}

export function paymentTimeline(
  intent: PaymentIntent,
  refunds: Refund[],
  sessions: CheckoutSession[]
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    { at: intent.created_at, kind: 'payment_created', refId: intent.id, status: intent.status },
  ];
  for (const s of sessions) {
    entries.push({ at: s.created_at, kind: 'session_created', refId: s.id, status: s.status });
    if (s.completed_at) {
      entries.push({
        at: s.completed_at,
        kind: 'session_completed',
        refId: s.id,
        status: s.status,
      });
    }
  }
  for (const r of refunds) {
    entries.push({ at: r.created_at, kind: 'refund_created', refId: r.id, status: r.status });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}
