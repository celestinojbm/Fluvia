/** Formas públicas (snake_case) de `/v1/programs/:orgId/*`. Importes: string en unidades menores. */
export interface Overview {
  consumers: { total: number; active: number; suspended: number };
  queues: {
    manual_reviews: number;
    open_cases: number;
    uncertain: number;
    unmatched_events: number;
    pending_approvals: number;
  };
  cards: { active: number; blocked: number; in_transit: number };
  by_currency: {
    currency: string;
    wallet_available: string;
    wallet_held: string;
    collateral: string;
    debt: string;
    approved_limits: string;
    reserved: string;
    network_payable: string;
    overdue: string;
  }[];
  authorizations_last24h: { approved: number; declined: number };
}
export interface Program {
  tenant_id: string;
  name: string;
  currencies: string[];
  issuer_adapter: string;
  funding_adapter: string;
  settlement_delay_days: number;
  sandbox: boolean;
}
export interface ConsumerRow {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'suspended' | 'closed';
  synthetic_risk_profile: string;
  created_at: string;
  open_cases: number;
  overdue_installments: number;
}
export interface CaseRow {
  id: string;
  consumer_id: string | null;
  case_type: string;
  severity: string;
  status: 'open' | 'acknowledged' | 'resolved';
  subject_type: string;
  subject_id: string;
  summary: string;
  evidence: Record<string, unknown>;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}
export interface EventRow {
  id: string;
  source: string;
  event_id: string;
  event_type: string;
  status: string;
  detail: string | null;
  occurred_at: string;
  received_at: string;
  payload: Record<string, unknown>;
}
export interface PolicyRow {
  id: string;
  code: string;
  version: number;
  status: 'draft' | 'active' | 'retired';
  params: Record<string, unknown>;
  is_reference: boolean;
  synthetic: boolean;
  pending_commercial_validation: boolean;
  created_by_user_id: string | null;
  approved_by_user_id: string | null;
  activated_at: string | null;
  created_at: string;
}
export interface ApprovalRow {
  id: string;
  action: string;
  subject_id: string;
  payload: Record<string, unknown>;
  reason: string;
  status: string;
  proposed_by_user_id: string;
  decided_by_user_id: string | null;
  created_at: string;
}
