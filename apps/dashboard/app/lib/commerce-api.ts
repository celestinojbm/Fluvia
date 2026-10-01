/**
 * Lecturas server-side de la plataforma del comercio. Como `api.ts`: el token
 * de sesión viaja como Bearer desde el servidor (el navegador nunca lo ve).
 *
 * A diferencia de `apiGet` (que colapsa todo fallo en `null`), aquí cada
 * lectura DISTINGUE: ok · sesión caducada (401) · sin acceso / inexistente
 * (403/404) · fallo (red/5xx). La UI muestra estados honestos (vacío ≠ error).
 */

import { apiBase } from './api';

export type Read<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unauthorized' }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error' };

export async function readApi<T>(
  token: string,
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<Read<T>> {
  try {
    const res = await fetchImpl(`${apiBase()}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (res.status === 401) return { kind: 'unauthorized' };
    if (res.status === 403) return { kind: 'forbidden' };
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) return { kind: 'error' };
    return { kind: 'ok', data: (await res.json()) as T };
  } catch {
    return { kind: 'error' };
  }
}

export const orgPath = (orgId: string, rest: string) =>
  `/v1/organizations/${encodeURIComponent(orgId)}${rest}`;

// ── Contratos (espejo de apps/api/src/routes/commerce.ts) ────────────────────

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  category_id: string | null;
  category_name: string | null;
  price: number;
  currency: string;
  available: boolean;
  archived: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  name: string;
  product_count: number;
}

export type OrderPaymentState =
  | 'awaiting_payment'
  | 'payment_in_progress'
  | 'paid'
  | 'partially_refunded'
  | 'refunded';

export interface OrderLine {
  position: number;
  product_id: string | null;
  name: string;
  sku: string | null;
  unit_price: number;
  quantity: number;
  line_total: number;
}

export interface Order {
  id: string;
  number: number;
  merchant_id: string;
  merchant_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  currency: string;
  total: number;
  line_count: number;
  note: string | null;
  payment_link_id: string;
  created_at: string;
  payment: {
    state: OrderPaymentState;
    payment_intent_id: string | null;
    intent_status: string | null;
    amount_refunded: number;
    checkout_count: number;
    latest_checkout_session_id: string | null;
    latest_intent_status: string | null;
  };
  installments_sandbox: {
    plan_id: string;
    status: 'pending' | 'approved' | 'declined';
    installments_count: number;
    paid_count: number;
    overdue_count: number;
    simulated: true;
  } | null;
}

export interface OrderDetail extends Order {
  lines: OrderLine[];
}

export interface OrderList {
  data: Order[];
  has_more: boolean;
  next_before_number: number | null;
}

export interface Customer {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  description: string | null;
  order_count: number;
  last_order_at: string | null;
  created_at: string;
}

export interface CustomerDetail extends Customer {
  orders: Order[];
  orders_has_more: boolean;
}

export interface Figure {
  currency: string;
  count: number;
  amount: number;
}

export interface CommerceSummary {
  period: { start: string; end: string; timezone: 'UTC' };
  confirmed_charges: Figure[];
  charges_in_flight: Figure[];
  refunds_confirmed: Figure[];
  refunds_open: Figure[];
  orders_created: Figure[];
  orders_awaiting_payment: Figure[];
  installments_sandbox_approved: Figure[];
}

export interface CashSummary {
  period: { start: string; end: string; timezone: 'UTC' };
  confirmed_by_channel: Array<Figure & { channel: 'pos_order' | 'other' }>;
  refunds_by_status: Array<Figure & { status: string }>;
  net_operational: Array<{ currency: string; amount: number }>;
  installments_sandbox_by_status: Array<Figure & { status: string }>;
}

export interface InstallmentPlan {
  id: string;
  simulated: true;
  order_id: string;
  order_number: number;
  checkout_session_id: string;
  currency: string;
  total: number;
  installments_count: number;
  interval_days: number;
  terms_version: string;
  scenario: 'approve' | 'decline' | 'pending';
  status: 'pending' | 'approved' | 'declined';
  buyer_confirmed_at: string;
  decided_at: string | null;
  created_at: string;
  installments: Array<{
    seq: number;
    amount: number;
    due_date: string;
    status: 'scheduled' | 'paid_simulated' | 'overdue_simulated';
    status_changed_at: string | null;
  }>;
  events: Array<{
    kind: string;
    seq: number | null;
    actor: 'buyer' | 'simulated_provider' | 'operator';
    created_at: string;
  }>;
}

export interface Member {
  membership_id: string;
  user_id: string;
  email: string;
  role: string;
  since: string;
}

export interface SessionInfo {
  user_id: string;
  mfa: { enabled: boolean };
  memberships: Array<{
    organization_id: string;
    organization_name: string;
    role: string;
  }>;
}

export interface MerchantRow {
  id: string;
  name: string;
  status: string;
  country: string | null;
  defaultCurrency: string;
}
