import { clientCall, type CallResult } from '../client-call';

/**
 * Cliente del navegador para el BFF del local (`/api/orgs/:orgId/v/...`) y
 * contratos espejo de apps/api/src/routes/{dining,in-person}.ts. Importes en
 * unidades menores. La UI muestra lo que el SERVIDOR confirma: ninguna acción
 * se marca hecha antes de su respuesta.
 */

export const vpath = (orgId: string, rest: string) => `/api/orgs/${orgId}/v/${rest}`;

export function vcall<T>(
  orgId: string,
  rest: string,
  init: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {}
): Promise<CallResult<T>> {
  return clientCall<T>(vpath(orgId, rest), init);
}

export type BusinessType = 'retail' | 'restaurant' | 'quick_service' | 'services';
export interface BusinessProfile {
  business_type: BusinessType;
  modules: string[];
  solo: boolean;
  customer_orders_need_acceptance: boolean;
  version: number;
  configured: boolean;
  vocabulary: { sale: string; sales: string; customer: string; item: string; newSale: string };
  my_access?: {
    membership_role: string;
    can_configure: boolean;
    can_view_payments: boolean;
    venue: { full: boolean; grants: Array<{ role: string; branch_id: string | null }> };
  };
}

export interface Enablement {
  status: 'pending' | 'enabled' | 'restricted' | 'suspended';
  provider: string;
  reason: string | null;
  version: number;
  requirements: Array<{ id: string; label: string; done: boolean }>;
}

export interface VenueLayout {
  branches: Array<{
    id: string;
    name: string;
    areas: Array<{ id: string; name: string }>;
    tables: Array<{
      id: string;
      area_id: string;
      label: string;
      capacity: number;
      qr_token: string | null;
      menu_url: string | null;
    }>;
    stations: Array<{ id: string; code: string; name: string }>;
  }>;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  ingredients: string | null;
  allergen_info: string | null;
  price: number;
  currency: string;
  available: boolean;
  category_name: string | null;
  image_url: string | null;
  station_code: string | null;
  modifier_groups: Array<{
    id: string;
    name: string;
    min_select: number;
    max_select: number;
    options: Array<{ id: string; name: string; price_delta: number; available: boolean }>;
  }>;
}

export type PrepStatus = 'draft' | 'queued' | 'accepted' | 'preparing' | 'ready' | 'delivered';
export interface DiningLine {
  id: string;
  seq: number;
  product_id: string | null;
  name: string;
  unit_price: number;
  modifiers: Array<{ option_id: string; group_name: string; name: string; price_delta: number }>;
  modifiers_total: number;
  quantity: number;
  line_total: number;
  note: string | null;
  station_code: string;
  ticket_id: string | null;
  prep_status: PrepStatus;
  voided: boolean;
  void_reason: string | null;
}
export interface Ticket {
  id: string;
  order_id: string;
  number: number;
  revision: number;
  kind: 'new' | 'addition' | 'void';
  station_code: string;
  status: 'queued' | 'accepted' | 'preparing' | 'ready' | 'delivered';
  version: number;
  created_at: string;
  updated_at: string;
}
export interface DiningOrder {
  id: string;
  branch_id: string;
  number: number;
  mode: 'dine_in' | 'takeaway' | 'pickup';
  table_id: string | null;
  table_label: string | null;
  source: 'staff' | 'customer';
  status: 'pending_acceptance' | 'open' | 'bill_requested' | 'closed' | 'cancelled' | 'rejected';
  currency: string;
  guest_count: number | null;
  customer_name: string | null;
  note: string | null;
  attention_requested_at: string | null;
  version: number;
  total: number;
  lines: DiningLine[];
  tickets: Ticket[];
  created_at: string;
  updated_at: string;
}
export interface KitchenTicket extends Ticket {
  order_number: number;
  mode: DiningOrder['mode'];
  table_label: string | null;
  customer_name: string | null;
  order_note: string | null;
  items: Array<{
    line_id: string;
    name: string;
    quantity: number;
    modifiers: string[];
    note: string | null;
    voided: boolean;
    void_reason: string | null;
  }>;
}

export interface Bill {
  id: string;
  order_id: string;
  order_number: number;
  table_label: string | null;
  currency: string;
  total: number;
  status: 'open' | 'paid' | 'void';
  version: number;
  allocated: number;
  remainder: number;
  charged: number;
  lines: Array<{
    id: string;
    name: string;
    quantity: number;
    line_total: number;
    modifiers: string[];
    allocation_id: string | null;
  }>;
  allocations: Array<{
    id: string;
    kind: 'full' | 'amount' | 'items';
    amount: number;
    label: string | null;
    payment_link_id: string;
    pay_url: string | null;
    voided: boolean;
    void_reason: string | null;
    charge: 'none' | 'failed' | 'in_progress' | 'charged';
    payment_intent_id: string | null;
    bill_line_ids: string[];
  }>;
  anomalies: Array<{ allocation_id: string; payment_intent_id: string }>;
}

export type InPersonState =
  | 'device_incompatible'
  | 'preparing'
  | 'ready'
  | 'waiting_card'
  | 'processing'
  | 'approved'
  | 'declined'
  | 'canceled'
  | 'uncertain';
export interface InPersonPayment {
  id: string;
  method: 'tap_to_pay' | 'external_reader' | 'simulator';
  provider: string;
  simulated: boolean;
  state: InPersonState;
  amount: number;
  currency: string;
  concept: string | null;
  payment_link_id: string;
  payment_intent_id: string | null;
  failure_code: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  receipt: {
    amount: number;
    currency: string;
    concept: string | null;
    payment_intent_id: string | null;
    approved_at: string;
    simulated: boolean;
  } | null;
}

export const PREP_LABEL: Record<PrepStatus, string> = {
  draft: 'Sin enviar',
  queued: 'En cola',
  accepted: 'Aceptado',
  preparing: 'En preparación',
  ready: 'Listo',
  delivered: 'Entregado',
};
export const ORDER_STATUS_LABEL: Record<DiningOrder['status'], string> = {
  pending_acceptance: 'Por aceptar',
  open: 'Abierto',
  bill_requested: 'Cuenta pedida',
  closed: 'Pagado y cerrado',
  cancelled: 'Anulado',
  rejected: 'Rechazado',
};
export const MODE_LABEL: Record<DiningOrder['mode'], string> = {
  dine_in: 'En mesa',
  takeaway: 'Para llevar',
  pickup: 'Recoger',
};
export const CHARGE_LABEL: Record<Bill['allocations'][number]['charge'], string> = {
  none: 'Sin cobrar',
  failed: 'Rechazado — se puede reintentar',
  in_progress: 'Cobro en curso o incierto',
  charged: 'Cobrado',
};

/** Clave de idempotencia legible para el teléfono (sobrevive al reintento). */
export const newClientKey = (prefix: string) =>
  `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
