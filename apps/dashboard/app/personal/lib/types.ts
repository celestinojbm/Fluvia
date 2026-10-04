/** Formas públicas (snake_case) de la API de Fluvia Personal. Importes: string en unidades menores. */
export interface CreditView {
  line_id: string;
  status: string;
  approved_limit: string;
  utilized: string;
  reserved: string;
  available: string;
}
export interface Balance {
  currency: string;
  available: string;
  held: string;
  collateral: string;
  debt: string;
  credit: CreditView | null;
}
export interface Installment {
  id: string;
  plan_id: string;
  seq: number;
  amount: string;
  paid_amount: string;
  cancelled_amount: string;
  outstanding: string;
  due_date: string;
  status: 'scheduled' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled';
  currency?: string;
  merchant_name?: string;
}
export interface Plan {
  id: string;
  authorization_id: string;
  currency: string;
  principal: string;
  down_payment: string;
  installments_count: number;
  interval_days: number;
  interest_bps: number;
  merchant_name: string;
  status: 'active' | 'paid' | 'cancelled';
  outstanding: string;
  created_at: string;
  installments: Installment[];
}
export interface Card {
  id: string;
  currency: string;
  form: 'virtual' | 'physical';
  status: 'requested' | 'inactive' | 'active' | 'blocked' | 'replaced' | 'closed';
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  funding_mode: 'wallet_first' | 'wallet_only' | 'credit_only';
  limit_per_tx: string | null;
  limit_daily: string | null;
  blocked_by: 'consumer' | 'operator' | null;
  created_at: string;
  shipment: {
    status: string;
    city: string;
    address_line: string;
    history: { status: string; at: string }[];
  } | null;
}
export interface StatementLine {
  entry_id: string;
  transaction_id: string;
  created_at: string;
  account: 'available' | 'held' | 'collateral' | 'debt';
  direction: 'in' | 'out';
  amount: string;
  currency: string;
  reason: string;
  description: string;
}
export interface Authorization {
  /** Venta o pedido del comercio de esta compra (null si no hay enlace verificable). */
  journey_ref?: string | null;
  id: string;
  card_id: string;
  currency: string;
  amount: string;
  status: string;
  decline_code: string | null;
  wallet_amount: string;
  credit_amount: string;
  captured_wallet: string;
  captured_credit: string;
  refunded_wallet: string;
  refunded_credit: string;
  outstanding: string;
  installments_count: number | null;
  merchant_name: string;
  created_at: string;
}
export interface Application {
  id: string;
  currency: string;
  requested_limit: string;
  status: 'approved' | 'rejected' | 'manual_review';
  risk_tier: string;
  proposed_limit: string;
  approved_limit: string | null;
  decision: {
    reasons: { code: string; message: string }[];
    policy: { code: string; version: number };
  };
  created_at: string;
}
export interface Line {
  id: string;
  currency: string;
  status: string;
  approved_limit: string;
  utilized: string;
  reserved: string;
  available: string;
  multiplier_bps: number;
  risk_tier: string;
  collateral: string;
  required_collateral: string;
  releasable_collateral: string;
}
export interface Funding {
  id: string;
  currency: string;
  amount: string;
  method: string;
  reference: string;
  status: 'pending' | 'confirmed' | 'failed';
  created_at: string;
}
export interface Transfer {
  id: string;
  kind: 'p2p' | 'withdrawal';
  direction: 'in' | 'out';
  destination_masked: string | null;
  currency: string;
  amount: string;
  status: 'processing' | 'completed' | 'failed' | 'indeterminate';
  note: string | null;
  created_at: string;
}
export interface Me {
  consumer: { id: string; email: string; display_name: string; status: string };
  program: { id: string; name: string; currencies: string[]; sandbox: boolean };
  policy: {
    code: string;
    version: number;
    synthetic: boolean;
    pending_commercial_validation: boolean;
    installment_counts: number[];
    down_payment_bps: number;
    interval_days: number;
    interest_bps: number;
    /** Máximo ilustrativo del límite por garantía (×4 = 40000) y multiplicador por nivel. */
    max_multiplier_bps?: number;
    tiers?: Array<{ tier: string; multiplier_bps: number | null }>;
  };
}
