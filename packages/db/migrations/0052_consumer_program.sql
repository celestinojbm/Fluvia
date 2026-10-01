-- ============================================================================
-- FLUVIA 0052_consumer_program.sql  (Fluvia Personal + Operaciones — SANDBOX)
--
-- Programa de consumo: wallet, garantía, crédito, tarjetas y operación.
-- Especificación: docs/product/fluvia-integral/ESPECIFICACION.md.
--
-- Principios aplicados en el MOTOR (no solo en el servicio):
--  - El ledger es la fuente de verdad del dinero. Aquí solo hay estado de
--    dominio + enlaces (ledger_tx_id). Ningún saldo editable.
--  - Aislamiento doble: RLS FORZADO por tenant (organización programa) y, si
--    la transacción fija `app.consumer_id`, por cliente. El plano del
--    consumidor SIEMPRE lo fija; el de operación no.
--  - Credenciales y sesiones del consumidor: solo rol fluvia_auth.
--  - Sin PAN ni CVV: la tarjeta guarda `last4` y referencias opacas del
--    emisor; el token de pago se guarda como hash.
--  - Reserva de crédito: un BEFORE trigger bloquea la línea y verifica
--    deuda (ledger) + reservas vivas + nueva reserva ≤ límite aprobado.
--
-- Aditiva: no toca tablas ni datos existentes salvo ampliar las causas
-- contables permitidas del ledger.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Causas contables del programa
-- ----------------------------------------------------------------------------
ALTER TABLE ledger_transactions DROP CONSTRAINT IF EXISTS ledger_transactions_reason_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_reason_check CHECK (
  reason IN (
    'payment', 'refund', 'fee', 'payout', 'transfer',
    'adjustment', 'settlement', 'reversal', 'reconciliation', 'reserve', 'dispute',
    'funding', 'withdrawal', 'collateral', 'card', 'credit', 'repayment'
  )
);

-- Contexto de cliente (RLS). '' tras revertir set_config ⇒ NULLIF.
CREATE OR REPLACE FUNCTION fluvia_consumer_visible(p_consumer_id UUID)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.consumer_id', true), '') IS NULL
      OR p_consumer_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid;
$$;

-- ----------------------------------------------------------------------------
-- 1. Programa y clientes
-- ----------------------------------------------------------------------------
CREATE TABLE consumer_programs (
  tenant_id             UUID PRIMARY KEY REFERENCES organizations(id),
  name                  TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  currencies            TEXT[] NOT NULL CHECK (cardinality(currencies) BETWEEN 1 AND 8),
  issuer_adapter        TEXT NOT NULL DEFAULT 'simulated',
  funding_adapter       TEXT NOT NULL DEFAULT 'simulated',
  -- Días entre la captura y el desembolso al comercio (configurable; la
  -- política de liquidación real depende de acuerdos con la red/adquirente).
  settlement_delay_days INT NOT NULL DEFAULT 1 CHECK (settlement_delay_days BETWEEN 0 AND 60),
  sandbox               BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE consumers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  email          TEXT NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  display_name   TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  -- Perfil de riesgo DECLARADO y SINTÉTICO (sandbox): nunca verificado.
  synthetic_risk_profile CHAR(1) NOT NULL DEFAULT 'B' CHECK (synthetic_risk_profile IN ('A', 'B', 'C', 'D')),
  synthetic      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, email)
);
-- RLS de consumers: id = consumer_id.
CREATE TABLE consumer_credentials (
  consumer_id     UUID PRIMARY KEY REFERENCES consumers(id),
  tenant_id       UUID NOT NULL,
  password_hash   TEXT NOT NULL,
  failed_attempts INT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE consumer_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id  UUID NOT NULL REFERENCES consumers(id),
  tenant_id    UUID NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ
);
CREATE INDEX consumer_sessions_consumer_idx ON consumer_sessions (consumer_id);

-- ----------------------------------------------------------------------------
-- 2. Wallet: ingresos, transferencias y retiros
-- ----------------------------------------------------------------------------
CREATE TABLE wallet_fundings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id  UUID NOT NULL,
  currency     CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount       BIGINT NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
  method       TEXT NOT NULL CHECK (method IN ('bank_transfer', 'mobile_payment', 'cash_agent')),
  provider     TEXT NOT NULL,
  -- Referencia que da el proveedor de fondeo (concilia y deduplica).
  provider_ref TEXT NOT NULL CHECK (char_length(provider_ref) BETWEEN 4 AND 120),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  failure_code TEXT,
  ledger_tx_id UUID,
  client_key   TEXT NOT NULL CHECK (char_length(client_key) BETWEEN 8 AND 200),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, consumer_id, client_key),
  UNIQUE (provider, provider_ref),
  CONSTRAINT wallet_fundings_consumer_fk FOREIGN KEY (consumer_id, tenant_id) REFERENCES consumers (id, tenant_id),
  CONSTRAINT wallet_fundings_confirmed_chk CHECK ((status = 'confirmed') = (ledger_tx_id IS NOT NULL))
);
CREATE INDEX wallet_fundings_consumer_idx ON wallet_fundings (tenant_id, consumer_id, created_at DESC);

CREATE TABLE wallet_transfers (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id              UUID NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('p2p', 'withdrawal')),
  counterparty_consumer_id UUID,
  -- Destino del retiro (enmascarado; el dato bancario completo vive en el proveedor real).
  destination_masked       TEXT CHECK (destination_masked IS NULL OR char_length(destination_masked) <= 40),
  currency                 CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount                   BIGINT NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
  status                   TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed', 'indeterminate')),
  provider_ref             TEXT,
  failure_code             TEXT,
  note                     TEXT CHECK (note IS NULL OR char_length(note) <= 140),
  client_key               TEXT NOT NULL CHECK (char_length(client_key) BETWEEN 8 AND 200),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, consumer_id, client_key),
  CONSTRAINT wallet_transfers_consumer_fk FOREIGN KEY (consumer_id, tenant_id) REFERENCES consumers (id, tenant_id),
  CONSTRAINT wallet_transfers_cp_fk FOREIGN KEY (counterparty_consumer_id, tenant_id) REFERENCES consumers (id, tenant_id),
  CONSTRAINT wallet_transfers_kind_chk CHECK (
    (kind = 'p2p' AND counterparty_consumer_id IS NOT NULL AND counterparty_consumer_id <> consumer_id)
    OR (kind = 'withdrawal' AND counterparty_consumer_id IS NULL AND destination_masked IS NOT NULL))
);
CREATE INDEX wallet_transfers_consumer_idx ON wallet_transfers (tenant_id, consumer_id, created_at DESC);
CREATE INDEX wallet_transfers_cp_idx ON wallet_transfers (tenant_id, counterparty_consumer_id)
  WHERE counterparty_consumer_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. Política, solicitudes, líneas y garantía
-- ----------------------------------------------------------------------------
CREATE TABLE credit_policies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  code                TEXT NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  version             INT NOT NULL CHECK (version >= 1),
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  params              JSONB NOT NULL,
  is_reference        BOOLEAN NOT NULL DEFAULT false,
  synthetic           BOOLEAN NOT NULL DEFAULT true,
  pending_commercial_validation BOOLEAN NOT NULL DEFAULT true,
  -- NULL = creada por el sistema (seed de la política de referencia).
  created_by_user_id  UUID,
  approved_by_user_id UUID,
  activated_at        TIMESTAMPTZ,
  retired_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, code, version),
  -- Doble aprobación: quien activa no es quien propuso (si la propuso una persona).
  CONSTRAINT credit_policies_four_eyes_chk CHECK (
    created_by_user_id IS NULL OR approved_by_user_id IS NULL OR approved_by_user_id <> created_by_user_id),
  CONSTRAINT credit_policies_active_chk CHECK (status <> 'active' OR activated_at IS NOT NULL)
);
CREATE UNIQUE INDEX credit_policies_one_active_uq ON credit_policies (tenant_id) WHERE status = 'active';

CREATE TABLE credit_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id     UUID NOT NULL,
  currency        CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  approved_limit  BIGINT NOT NULL CHECK (approved_limit >= 0 AND approved_limit <= 9007199254740991),
  multiplier_bps  INT NOT NULL CHECK (multiplier_bps BETWEEN 1 AND 100000),
  risk_tier       CHAR(1) NOT NULL CHECK (risk_tier IN ('A', 'B', 'C')),
  policy_id       UUID NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  version         INT NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, consumer_id, currency),
  CONSTRAINT credit_lines_consumer_fk FOREIGN KEY (consumer_id, tenant_id) REFERENCES consumers (id, tenant_id),
  CONSTRAINT credit_lines_policy_fk FOREIGN KEY (policy_id, tenant_id) REFERENCES credit_policies (id, tenant_id)
);

CREATE TABLE credit_applications (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id             UUID NOT NULL,
  currency                CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  requested_limit         BIGINT NOT NULL CHECK (requested_limit > 0 AND requested_limit <= 9007199254740991),
  collateral_at_evaluation BIGINT NOT NULL CHECK (collateral_at_evaluation >= 0),
  policy_id               UUID NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('approved', 'rejected', 'manual_review')),
  risk_tier               CHAR(1) NOT NULL CHECK (risk_tier IN ('A', 'B', 'C', 'D')),
  proposed_limit          BIGINT NOT NULL CHECK (proposed_limit >= 0),
  approved_limit          BIGINT CHECK (approved_limit IS NULL OR approved_limit >= 0),
  -- Explicación: entradas, reglas aplicadas y motivos legibles.
  decision                JSONB NOT NULL,
  decided_by              TEXT NOT NULL CHECK (decided_by IN ('engine', 'operator')),
  decided_by_user_id      UUID,
  client_key              TEXT NOT NULL CHECK (char_length(client_key) BETWEEN 8 AND 200),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at              TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, consumer_id, client_key),
  CONSTRAINT credit_applications_consumer_fk FOREIGN KEY (consumer_id, tenant_id) REFERENCES consumers (id, tenant_id),
  CONSTRAINT credit_applications_policy_fk FOREIGN KEY (policy_id, tenant_id) REFERENCES credit_policies (id, tenant_id),
  CONSTRAINT credit_applications_decided_chk CHECK ((status = 'manual_review') = (decided_at IS NULL)),
  CONSTRAINT credit_applications_approved_chk CHECK ((status = 'approved') = (approved_limit IS NOT NULL))
);
CREATE INDEX credit_applications_review_idx ON credit_applications (tenant_id, created_at)
  WHERE status = 'manual_review';
CREATE UNIQUE INDEX credit_applications_one_review_uq ON credit_applications (tenant_id, consumer_id, currency)
  WHERE status = 'manual_review';

CREATE TABLE credit_limit_changes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id    UUID NOT NULL,
  line_id        UUID NOT NULL,
  old_limit      BIGINT,
  new_limit      BIGINT NOT NULL CHECK (new_limit >= 0),
  source         TEXT NOT NULL CHECK (source IN ('application', 'operator', 'collateral_release', 'status')),
  reason         TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 280),
  actor_user_id  UUID,
  application_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_limit_changes_line_fk FOREIGN KEY (line_id, tenant_id) REFERENCES credit_lines (id, tenant_id)
);
CREATE INDEX credit_limit_changes_line_idx ON credit_limit_changes (line_id, created_at DESC);

CREATE TABLE collateral_movements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id   UUID NOT NULL,
  currency      CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  kind          TEXT NOT NULL CHECK (kind IN ('lock', 'release', 'apply')),
  amount        BIGINT NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
  ledger_tx_id  UUID NOT NULL,
  actor         TEXT NOT NULL CHECK (actor IN ('consumer', 'operator')),
  actor_user_id UUID,
  reason        TEXT CHECK (reason IS NULL OR char_length(reason) <= 280),
  client_key    TEXT NOT NULL CHECK (char_length(client_key) BETWEEN 8 AND 200),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, consumer_id, client_key),
  CONSTRAINT collateral_movements_consumer_fk FOREIGN KEY (consumer_id, tenant_id) REFERENCES consumers (id, tenant_id),
  CONSTRAINT collateral_apply_operator_chk CHECK (kind <> 'apply' OR (actor = 'operator' AND reason IS NOT NULL))
);
CREATE INDEX collateral_movements_consumer_idx ON collateral_movements (tenant_id, consumer_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 4. Tarjetas
-- ----------------------------------------------------------------------------
CREATE TABLE cards (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id      UUID NOT NULL,
  currency         CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  form             TEXT NOT NULL CHECK (form IN ('virtual', 'physical')),
  status           TEXT NOT NULL CHECK (status IN ('requested', 'inactive', 'active', 'blocked', 'replaced', 'closed')),
  issuer           TEXT NOT NULL,
  -- Referencia OPACA del emisor. Jamás un PAN.
  issuer_ref       TEXT CHECK (issuer_ref IS NULL OR issuer_ref !~ '[0-9]{12,}'),
  last4            CHAR(4) CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  exp_month        INT CHECK (exp_month IS NULL OR exp_month BETWEEN 1 AND 12),
  exp_year         INT CHECK (exp_year IS NULL OR exp_year BETWEEN 2024 AND 2100),
  funding_mode     TEXT NOT NULL DEFAULT 'wallet_first' CHECK (funding_mode IN ('wallet_first', 'wallet_only', 'credit_only')),
  limit_per_tx     BIGINT CHECK (limit_per_tx IS NULL OR limit_per_tx > 0),
  limit_daily      BIGINT CHECK (limit_daily IS NULL OR limit_daily > 0),
  blocked_by       TEXT CHECK (blocked_by IS NULL OR blocked_by IN ('consumer', 'operator')),
  replaces_card_id UUID,
  version          INT NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at     TIMESTAMPTZ,
  closed_at        TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  CONSTRAINT cards_consumer_fk FOREIGN KEY (consumer_id, tenant_id) REFERENCES consumers (id, tenant_id),
  CONSTRAINT cards_replaces_fk FOREIGN KEY (replaces_card_id, tenant_id) REFERENCES cards (id, tenant_id),
  CONSTRAINT cards_blocked_chk CHECK ((status = 'blocked') = (blocked_by IS NOT NULL))
);
CREATE INDEX cards_consumer_idx ON cards (tenant_id, consumer_id, created_at DESC);

CREATE TABLE card_shipments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id   UUID NOT NULL,
  card_id       UUID NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('requested', 'produced', 'shipped', 'delivered', 'returned')),
  address_line  TEXT NOT NULL CHECK (char_length(address_line) BETWEEN 5 AND 200),
  city          TEXT NOT NULL CHECK (char_length(city) BETWEEN 2 AND 80),
  shipment_ref  TEXT,
  history       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (card_id),
  CONSTRAINT card_shipments_card_fk FOREIGN KEY (card_id, tenant_id) REFERENCES cards (id, tenant_id),
  CONSTRAINT card_shipments_consumer_fk FOREIGN KEY (consumer_id, tenant_id) REFERENCES consumers (id, tenant_id)
);

-- Código de pago de un solo uso (token de red). Se guarda el HASH.
CREATE TABLE card_payment_tokens (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id        UUID NOT NULL,
  card_id            UUID NOT NULL,
  token_hash         TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  mode               TEXT NOT NULL CHECK (mode IN ('wallet', 'installments')),
  installments_count INT CHECK (installments_count IS NULL OR installments_count BETWEEN 1 AND 24),
  -- Oferta aceptada (política, inicial, intervalo, tasa) — snapshot inmutable.
  terms              JSONB,
  max_amount         BIGINT CHECK (max_amount IS NULL OR max_amount > 0),
  expires_at         TIMESTAMPTZ NOT NULL,
  used_at            TIMESTAMPTZ,
  authorization_id   UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT card_payment_tokens_card_fk FOREIGN KEY (card_id, tenant_id) REFERENCES cards (id, tenant_id),
  CONSTRAINT card_payment_tokens_consumer_fk FOREIGN KEY (consumer_id, tenant_id) REFERENCES consumers (id, tenant_id),
  CONSTRAINT card_payment_tokens_mode_chk CHECK (
    (mode = 'wallet' AND installments_count IS NULL AND terms IS NULL)
    OR (mode = 'installments' AND installments_count IS NOT NULL AND terms IS NOT NULL)),
  CONSTRAINT card_payment_tokens_used_chk CHECK ((used_at IS NULL) = (authorization_id IS NULL))
);

CREATE TABLE card_authorizations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id        UUID NOT NULL,
  card_id            UUID NOT NULL,
  currency           CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount             BIGINT NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
  status             TEXT NOT NULL CHECK (status IN ('approved', 'partially_captured', 'captured', 'reversed', 'expired', 'declined')),
  decline_code       TEXT,
  -- Reparto decidido al autorizar (saldo propio / crédito).
  wallet_amount      BIGINT NOT NULL DEFAULT 0 CHECK (wallet_amount >= 0),
  credit_amount      BIGINT NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  captured_wallet    BIGINT NOT NULL DEFAULT 0 CHECK (captured_wallet >= 0),
  captured_credit    BIGINT NOT NULL DEFAULT 0 CHECK (captured_credit >= 0),
  released_wallet    BIGINT NOT NULL DEFAULT 0 CHECK (released_wallet >= 0),
  released_credit    BIGINT NOT NULL DEFAULT 0 CHECK (released_credit >= 0),
  refunded_wallet    BIGINT NOT NULL DEFAULT 0 CHECK (refunded_wallet >= 0),
  refunded_credit    BIGINT NOT NULL DEFAULT 0 CHECK (refunded_credit >= 0),
  credit_line_id     UUID,
  installments_count INT CHECK (installments_count IS NULL OR installments_count BETWEEN 1 AND 24),
  terms              JSONB,
  source             TEXT NOT NULL CHECK (source IN ('fluvia_checkout', 'network')),
  merchant_name      TEXT NOT NULL CHECK (char_length(merchant_name) BETWEEN 1 AND 120),
  merchant_ref       TEXT,
  -- Idempotencia de red: misma referencia ⇒ misma respuesta.
  network_ref        TEXT NOT NULL CHECK (char_length(network_ref) BETWEEN 4 AND 200),
  payment_token_id   UUID,
  hold_ledger_tx_id  UUID,
  expires_at         TIMESTAMPTZ NOT NULL,
  version            INT NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, network_ref),
  CONSTRAINT card_authorizations_card_fk FOREIGN KEY (card_id, tenant_id) REFERENCES cards (id, tenant_id),
  CONSTRAINT card_authorizations_consumer_fk FOREIGN KEY (consumer_id, tenant_id) REFERENCES consumers (id, tenant_id),
  CONSTRAINT card_authorizations_line_fk FOREIGN KEY (credit_line_id, tenant_id) REFERENCES credit_lines (id, tenant_id),
  CONSTRAINT card_authorizations_split_chk CHECK (
    status = 'declined' OR wallet_amount + credit_amount = amount),
  CONSTRAINT card_authorizations_declined_chk CHECK (
    (status = 'declined') = (decline_code IS NOT NULL)
    AND (status <> 'declined' OR (wallet_amount = 0 AND credit_amount = 0))),
  CONSTRAINT card_authorizations_wallet_flow_chk CHECK (captured_wallet + released_wallet <= wallet_amount),
  CONSTRAINT card_authorizations_credit_flow_chk CHECK (captured_credit + released_credit <= credit_amount),
  CONSTRAINT card_authorizations_refund_chk CHECK (refunded_wallet <= captured_wallet AND refunded_credit <= captured_credit),
  CONSTRAINT card_authorizations_line_chk CHECK (credit_amount = 0 OR credit_line_id IS NOT NULL)
);
CREATE INDEX card_authorizations_consumer_idx ON card_authorizations (tenant_id, consumer_id, created_at DESC);
CREATE INDEX card_authorizations_card_idx ON card_authorizations (card_id, created_at DESC);
CREATE INDEX card_authorizations_live_credit_idx ON card_authorizations (credit_line_id)
  WHERE status IN ('approved', 'partially_captured');

CREATE TABLE card_authorization_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id      UUID NOT NULL,
  authorization_id UUID NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('capture', 'reverse', 'expire', 'refund')),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  wallet_part      BIGINT NOT NULL CHECK (wallet_part >= 0),
  credit_part      BIGINT NOT NULL CHECK (credit_part >= 0),
  idempotency_key  TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 4 AND 200),
  ledger_tx_id     UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, authorization_id, idempotency_key),
  CONSTRAINT card_auth_events_auth_fk FOREIGN KEY (authorization_id, tenant_id) REFERENCES card_authorizations (id, tenant_id),
  CONSTRAINT card_auth_events_split_chk CHECK (wallet_part + credit_part = amount)
);
CREATE INDEX card_auth_events_auth_idx ON card_authorization_events (authorization_id, created_at);

-- ----------------------------------------------------------------------------
-- 5. Planes de cuotas del crédito y pagos
-- ----------------------------------------------------------------------------
CREATE TABLE credit_plans (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id        UUID NOT NULL,
  line_id            UUID NOT NULL,
  authorization_id   UUID NOT NULL,
  capture_event_id   UUID NOT NULL UNIQUE,
  currency           CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  principal          BIGINT NOT NULL CHECK (principal > 0),
  down_payment       BIGINT NOT NULL DEFAULT 0 CHECK (down_payment >= 0),
  installments_count INT NOT NULL CHECK (installments_count BETWEEN 1 AND 24),
  interval_days      INT NOT NULL CHECK (interval_days BETWEEN 1 AND 92),
  interest_bps       INT NOT NULL DEFAULT 0 CHECK (interest_bps >= 0),
  policy_id          UUID NOT NULL,
  terms              JSONB NOT NULL,
  merchant_name      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paid', 'cancelled')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  CONSTRAINT credit_plans_line_fk FOREIGN KEY (line_id, tenant_id) REFERENCES credit_lines (id, tenant_id),
  CONSTRAINT credit_plans_auth_fk FOREIGN KEY (authorization_id, tenant_id) REFERENCES card_authorizations (id, tenant_id),
  CONSTRAINT credit_plans_event_fk FOREIGN KEY (capture_event_id, tenant_id) REFERENCES card_authorization_events (id, tenant_id),
  CONSTRAINT credit_plans_consumer_fk FOREIGN KEY (consumer_id, tenant_id) REFERENCES consumers (id, tenant_id)
);
CREATE INDEX credit_plans_consumer_idx ON credit_plans (tenant_id, consumer_id, created_at DESC);

CREATE TABLE credit_installments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id      UUID NOT NULL,
  plan_id          UUID NOT NULL,
  seq              INT NOT NULL CHECK (seq BETWEEN 1 AND 24),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  paid_amount      BIGINT NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  cancelled_amount BIGINT NOT NULL DEFAULT 0 CHECK (cancelled_amount >= 0),
  due_date         DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled', 'partially_paid', 'paid', 'overdue', 'cancelled')),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, seq),
  CONSTRAINT credit_installments_plan_fk FOREIGN KEY (plan_id, tenant_id) REFERENCES credit_plans (id, tenant_id),
  CONSTRAINT credit_installments_amount_chk CHECK (paid_amount + cancelled_amount <= amount),
  CONSTRAINT credit_installments_status_chk CHECK (
    (status = 'paid') = (paid_amount + cancelled_amount = amount AND paid_amount > 0)
    OR (status = 'cancelled' AND paid_amount = 0 AND cancelled_amount = amount))
);
CREATE INDEX credit_installments_due_idx ON credit_installments (tenant_id, consumer_id, due_date)
  WHERE status IN ('scheduled', 'partially_paid', 'overdue');

CREATE TABLE credit_repayments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id  UUID NOT NULL,
  line_id      UUID NOT NULL,
  plan_id      UUID,
  currency     CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount       BIGINT NOT NULL CHECK (amount > 0),
  source       TEXT NOT NULL CHECK (source IN ('wallet', 'collateral')),
  ledger_tx_id UUID NOT NULL,
  allocation   JSONB NOT NULL,
  client_key   TEXT NOT NULL CHECK (char_length(client_key) BETWEEN 8 AND 200),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, consumer_id, client_key),
  CONSTRAINT credit_repayments_line_fk FOREIGN KEY (line_id, tenant_id) REFERENCES credit_lines (id, tenant_id),
  CONSTRAINT credit_repayments_plan_fk FOREIGN KEY (plan_id, tenant_id) REFERENCES credit_plans (id, tenant_id),
  CONSTRAINT credit_repayments_consumer_fk FOREIGN KEY (consumer_id, tenant_id) REFERENCES consumers (id, tenant_id)
);

-- ----------------------------------------------------------------------------
-- 6. Eventos de proveedores, casos y aprobaciones
-- ----------------------------------------------------------------------------
CREATE TABLE program_provider_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  source      TEXT NOT NULL CHECK (source IN ('funding', 'withdrawal', 'issuer', 'network')),
  event_id    TEXT NOT NULL CHECK (char_length(event_id) BETWEEN 4 AND 200),
  event_type  TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 3 AND 80),
  occurred_at TIMESTAMPTZ NOT NULL,
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'received'
                CHECK (status IN ('received', 'applied', 'ignored_out_of_order', 'unmatched', 'failed')),
  detail      TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, source, event_id)
);
CREATE INDEX program_provider_events_status_idx ON program_provider_events (tenant_id, status, received_at DESC);

CREATE TABLE program_cases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  consumer_id   UUID,
  case_type     TEXT NOT NULL CHECK (case_type IN (
                  'uncertain_withdrawal', 'uncertain_authorization', 'uncertain_refund',
                  'unmatched_provider_event', 'reconciliation_mismatch', 'overdue_debt',
                  'customer_incident')),
  severity      TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  summary       TEXT NOT NULL CHECK (char_length(summary) BETWEEN 3 AND 280),
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,
  assignee_user_id    UUID,
  resolution          TEXT,
  resolved_by_user_id UUID,
  version       INT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  CONSTRAINT program_cases_resolution_chk
    CHECK (status <> 'resolved' OR (resolution IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX program_cases_open_subject_uq ON program_cases (tenant_id, case_type, subject_type, subject_id)
  WHERE status <> 'resolved';
CREATE INDEX program_cases_queue_idx ON program_cases (tenant_id, status, created_at DESC);

-- Doble aprobación de acciones sensibles (propone uno, aprueba otro).
CREATE TABLE program_approvals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES consumer_programs(tenant_id),
  action              TEXT NOT NULL CHECK (action IN ('policy.activate', 'collateral.apply')),
  subject_id          UUID NOT NULL,
  payload             JSONB NOT NULL,
  reason              TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 280),
  status              TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'executed', 'rejected')),
  proposed_by_user_id UUID NOT NULL,
  decided_by_user_id  UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at          TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  CONSTRAINT program_approvals_four_eyes_chk CHECK (
    decided_by_user_id IS NULL OR decided_by_user_id <> proposed_by_user_id),
  CONSTRAINT program_approvals_decided_chk CHECK ((status = 'proposed') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX program_approvals_open_uq ON program_approvals (tenant_id, action, subject_id)
  WHERE status = 'proposed';

-- Estado «externo» del proveedor SIMULADO: lo que el proveedor decidió, para
-- que la consulta de un resultado incierto sea verificable (no por asunción).
-- No es dato de tenant: simula el sistema del proveedor.
CREATE TABLE sandbox_provider_operations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT NOT NULL,
  operation     TEXT NOT NULL CHECK (operation IN ('payment', 'refund', 'payout', 'withdrawal', 'funding')),
  operation_ref TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('approved', 'declined', 'pending')),
  provider_ref  TEXT NOT NULL,
  failure_code  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, operation, operation_ref)
);

-- ----------------------------------------------------------------------------
-- 7. Guardas del motor
-- ----------------------------------------------------------------------------

-- 7.1 Reserva de crédito: deuda (ledger) + reservas vivas + nueva ≤ límite.
CREATE OR REPLACE FUNCTION fluvia_credit_reservation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_limit    BIGINT;
  v_status   TEXT;
  v_consumer UUID;
  v_currency TEXT;
  v_debt     BIGINT;
  v_reserved BIGINT;
  v_new      BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := NEW.credit_amount;
  ELSE
    v_new := NEW.credit_amount - OLD.credit_amount;
  END IF;
  IF NEW.status = 'declined' OR v_new <= 0 THEN
    RETURN NEW;
  END IF;
  SELECT approved_limit, status, consumer_id, currency
    INTO v_limit, v_status, v_consumer, v_currency
    FROM credit_lines WHERE id = NEW.credit_line_id FOR UPDATE;
  IF NOT FOUND OR v_status <> 'active' THEN
    RAISE EXCEPTION 'FLUVIA_CREDIT_LINE_NOT_ACTIVE' USING ERRCODE = 'check_violation';
  END IF;
  IF v_consumer <> NEW.consumer_id OR v_currency <> NEW.currency THEN
    RAISE EXCEPTION 'FLUVIA_CREDIT_LINE_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(p.available), 0) INTO v_debt
    FROM ledger_accounts a JOIN balance_projections p ON p.account_id = a.id
   WHERE a.tenant_id = NEW.tenant_id AND a.currency = NEW.currency
     AND a.name = 'consumer.credit.receivable:' || NEW.consumer_id::text;
  SELECT COALESCE(SUM(credit_amount - captured_credit - released_credit), 0) INTO v_reserved
    FROM card_authorizations
   WHERE credit_line_id = NEW.credit_line_id
     AND status IN ('approved', 'partially_captured')
     AND id <> NEW.id;
  IF v_debt + v_reserved + NEW.credit_amount - NEW.captured_credit - NEW.released_credit > v_limit THEN
    RAISE EXCEPTION 'FLUVIA_CREDIT_LIMIT_EXCEEDED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER card_authorizations_credit_guard
  BEFORE INSERT OR UPDATE OF credit_amount ON card_authorizations
  FOR EACH ROW EXECUTE FUNCTION fluvia_credit_reservation_guard();

-- 7.2 Disponibilidad de la línea calculada en el servidor (vista; RLS de las
-- tablas base aplica: security_invoker).
CREATE VIEW credit_line_availability WITH (security_invoker = true) AS
SELECT l.id AS line_id, l.tenant_id, l.consumer_id, l.currency, l.status,
       l.approved_limit,
       COALESCE(debt.amount, 0)     AS utilized,
       COALESCE(res.amount, 0)      AS reserved,
       GREATEST(l.approved_limit - COALESCE(debt.amount, 0) - COALESCE(res.amount, 0), 0) AS available
  FROM credit_lines l
  LEFT JOIN LATERAL (
    SELECT SUM(p.available) AS amount
      FROM ledger_accounts a JOIN balance_projections p ON p.account_id = a.id
     WHERE a.tenant_id = l.tenant_id AND a.currency = l.currency
       AND a.name = 'consumer.credit.receivable:' || l.consumer_id::text
  ) debt ON true
  LEFT JOIN LATERAL (
    SELECT SUM(credit_amount - captured_credit - released_credit) AS amount
      FROM card_authorizations ca
     WHERE ca.credit_line_id = l.id AND ca.status IN ('approved', 'partially_captured')
  ) res ON true;

-- ----------------------------------------------------------------------------
-- 8. Inmutabilidad, RLS y privilegios
-- ----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  -- Append-only (sin UPDATE ni DELETE).
  FOREACH t IN ARRAY ARRAY['collateral_movements', 'card_authorization_events',
                           'credit_limit_changes', 'credit_repayments'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
                   t || '_no_update', t);
  END LOOP;
  -- Sin DELETE ni TRUNCATE en todo el programa.
  FOREACH t IN ARRAY ARRAY['consumer_programs', 'consumers', 'consumer_credentials', 'consumer_sessions',
                           'wallet_fundings', 'wallet_transfers', 'credit_policies', 'credit_lines',
                           'credit_applications', 'credit_limit_changes', 'collateral_movements',
                           'cards', 'card_shipments', 'card_payment_tokens', 'card_authorizations',
                           'card_authorization_events', 'credit_plans', 'credit_installments',
                           'credit_repayments', 'program_provider_events', 'program_cases',
                           'program_approvals', 'sandbox_provider_operations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
                   t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation()',
                   t || '_no_truncate', t);
  END LOOP;

  -- RLS por tenant (tablas sin cliente).
  FOREACH t IN ARRAY ARRAY['consumer_programs', 'credit_policies', 'program_provider_events',
                           'program_approvals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;

  -- RLS por tenant + cliente.
  FOREACH t IN ARRAY ARRAY['wallet_fundings', 'credit_lines', 'credit_applications',
                           'credit_limit_changes', 'collateral_movements', 'cards', 'card_shipments',
                           'card_payment_tokens', 'card_authorizations', 'card_authorization_events',
                           'credit_plans', 'credit_installments', 'credit_repayments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_consumer_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid
                AND fluvia_consumer_visible(consumer_id))
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid
                AND fluvia_consumer_visible(consumer_id))', t);
  END LOOP;
END;
$$;

-- Transferencias: el cliente ve las suyas y las que recibe.
ALTER TABLE wallet_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_consumer_isolation ON wallet_transfers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         AND (fluvia_consumer_visible(consumer_id)
              OR (counterparty_consumer_id IS NOT NULL AND fluvia_consumer_visible(counterparty_consumer_id))))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND fluvia_consumer_visible(consumer_id));

-- Casos: el cliente solo ve los suyos (si los hubiera); operación ve todos.
ALTER TABLE program_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE program_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_consumer_isolation ON program_cases
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         AND (NULLIF(current_setting('app.consumer_id', true), '') IS NULL
              OR consumer_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- consumers: la app ve los del tenant (y solo el propio en plano consumidor);
-- el plano de auth (fluvia_auth) los resuelve antes de tener contexto.
ALTER TABLE consumers ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_consumer_isolation ON consumers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         AND fluvia_consumer_visible(id))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND fluvia_consumer_visible(id));
CREATE POLICY auth_plane_access ON consumers FOR ALL TO fluvia_auth USING (true) WITH CHECK (true);

ALTER TABLE consumer_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE consumer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_plane_access ON consumer_credentials FOR ALL TO fluvia_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_plane_access ON consumer_sessions FOR ALL TO fluvia_auth USING (true) WITH CHECK (true);

-- Privilegios: los DEFAULT PRIVILEGES de 0002 concedieron SELECT/INSERT/UPDATE a
-- app y worker sobre toda tabla nueva. Se ajusta tabla a tabla.
REVOKE ALL ON consumer_credentials, consumer_sessions FROM PUBLIC, fluvia_app, fluvia_worker;
GRANT SELECT, INSERT, UPDATE ON consumer_credentials, consumer_sessions TO fluvia_auth;
GRANT SELECT, INSERT ON consumers TO fluvia_auth;
GRANT SELECT ON consumer_programs TO fluvia_auth;
-- consumer_programs no tiene política para fluvia_auth: se le da una de lectura.
CREATE POLICY auth_plane_read ON consumer_programs FOR SELECT TO fluvia_auth USING (true);

-- Append-only para la app: sin UPDATE.
REVOKE UPDATE ON collateral_movements, card_authorization_events, credit_limit_changes,
  credit_repayments FROM fluvia_app;
-- El worker no toca tablas del programa (sus procesos usan el rol de la app
-- con contexto de tenant, como los demás motores por tenant).
REVOKE ALL ON consumer_programs, consumers, wallet_fundings, wallet_transfers, credit_policies,
  credit_lines, credit_applications, credit_limit_changes, collateral_movements, cards,
  card_shipments, card_payment_tokens, card_authorizations, card_authorization_events,
  credit_plans, credit_installments, credit_repayments, program_provider_events, program_cases,
  program_approvals, sandbox_provider_operations FROM fluvia_worker;
-- El proveedor simulado solo registra y consulta (sin reescribir su historia).
REVOKE UPDATE ON sandbox_provider_operations FROM fluvia_app;

-- ----------------------------------------------------------------------------
-- 9. Auditoría: el cliente (consumidor) es un actor propio, con su sesión.
-- ----------------------------------------------------------------------------
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_actor_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_type_check
  CHECK (actor_type IN ('user', 'api_key', 'system', 'consumer'));
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_auth_method_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_auth_method_check
  CHECK (auth_method IN ('session', 'api_key', 'platform', 'none', 'consumer_session'));

-- El plano de auth registra los eventos del CLIENTE con el tenant del programa
-- (para que Operaciones los vea), solo acciones `consumer.*`.
CREATE POLICY auth_plane_consumer_audit ON audit_events
  FOR INSERT TO fluvia_auth
  WITH CHECK (action LIKE 'consumer.%'
              AND tenant_id IN (SELECT tenant_id FROM consumer_programs));
