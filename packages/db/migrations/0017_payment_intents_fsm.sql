-- ============================================================================
-- FLUVIA 0017_payment_intents_fsm.sql  (F3-01 — diseño: docs/design/f3-01-*)
--
-- Rediseño de payment_intents (cierra AUD-P2-002) + FSM hecha cumplir EN el
-- motor (base de AUD-P2-011): las transiciones legales viven en tablas de
-- referencia INMUTABLES sembradas desde el mapa TS de @fluvia/payments-core
-- (seed generado por scripts/gen-fsm-seed.ts — patrón golden). Un UPDATE de
-- status fuera del mapa es imposible de commitear incluso como superusuario.
--
-- Decisión del propietario (2026-07-05): F3-01 se adelanta a la re-auditoría.
-- Los endpoints públicos de pagos (F3-02+) SIGUEN congelados.
-- ============================================================================

-- La tabla actual es un placeholder sin consumidores: el rediseño exige que
-- siga vacía (si alguien la pobló, este es un fallo RUIDOSO, no un ALTER a ciegas).
DO $$
BEGIN
  IF (SELECT count(*) FROM payment_intents) > 0 THEN
    RAISE EXCEPTION 'FLUVIA_MIGRATION: payment_intents must be empty before the F3-01 redesign';
  END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. payment_intents: modelo real
-- ----------------------------------------------------------------------------
-- FK compuesta (patrón AUD-P1-001): un intent jamás puede apuntar al merchant
-- de otro tenant, ni siquiera con SQL crudo.
ALTER TABLE merchants ADD CONSTRAINT merchants_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_id_tenant_key UNIQUE (id, tenant_id);

ALTER TABLE payment_intents
  ADD COLUMN merchant_id UUID NOT NULL,
  ADD COLUMN capture_method TEXT NOT NULL DEFAULT 'automatic'
    CHECK (capture_method IN ('automatic', 'manual')),
  ADD COLUMN amount_captured BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN amount_refunded BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN failure_code TEXT,
  ADD CONSTRAINT payment_intents_merchant_coherence_fk
    FOREIGN KEY (merchant_id, tenant_id) REFERENCES merchants (id, tenant_id),
  ADD CONSTRAINT payment_intents_captured_le_amount CHECK (amount_captured BETWEEN 0 AND amount),
  ADD CONSTRAINT payment_intents_refunded_le_captured
    CHECK (amount_refunded BETWEEN 0 AND amount_captured);

ALTER TABLE payment_intents ALTER COLUMN status SET DEFAULT 'created';
ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_status_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_status_check
  CHECK (status IN (
    'created', 'requires_payment_method', 'requires_confirmation', 'requires_action',
    'processing', 'authorized', 'partially_captured', 'succeeded', 'failed',
    'canceled', 'partially_refunded', 'refunded'
  ));

CREATE INDEX payment_intents_merchant_idx ON payment_intents (tenant_id, merchant_id, created_at);

-- ----------------------------------------------------------------------------
-- 2. Tablas de transiciones (referencia inmutable; fuente = mapa TS)
-- ----------------------------------------------------------------------------
CREATE TABLE payment_intent_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

CREATE TABLE payment_attempt_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

-- Seed GENERADO por @fluvia/payments-core scripts/gen-fsm-seed.ts — no editar
-- a mano (el meta-test compara la tabla contra el mapa TS).
INSERT INTO payment_intent_transitions (from_status, to_status) VALUES
  ('authorized', 'canceled'),
  ('authorized', 'partially_captured'),
  ('authorized', 'succeeded'),
  ('created', 'canceled'),
  ('created', 'requires_payment_method'),
  ('partially_captured', 'succeeded'),
  ('partially_refunded', 'partially_refunded'),
  ('partially_refunded', 'refunded'),
  ('processing', 'authorized'),
  ('processing', 'failed'),
  ('processing', 'requires_action'),
  ('processing', 'succeeded'),
  ('requires_action', 'failed'),
  ('requires_action', 'processing'),
  ('requires_confirmation', 'canceled'),
  ('requires_confirmation', 'processing'),
  ('requires_payment_method', 'canceled'),
  ('requires_payment_method', 'requires_confirmation'),
  ('succeeded', 'partially_refunded'),
  ('succeeded', 'refunded');

INSERT INTO payment_attempt_transitions (from_status, to_status) VALUES
  ('created', 'expired'),
  ('created', 'submitting'),
  ('indeterminate', 'failed'),
  ('indeterminate', 'succeeded'),
  ('requires_action', 'expired'),
  ('requires_action', 'submitted'),
  ('submitted', 'expired'),
  ('submitted', 'failed'),
  ('submitted', 'indeterminate'),
  ('submitted', 'succeeded'),
  ('submitting', 'failed'),
  ('submitting', 'indeterminate'),
  ('submitting', 'requires_action'),
  ('submitting', 'submitted'),
  ('submitting', 'succeeded');

-- Inmutables: cambiar la FSM exige una migración nueva, jamás un UPDATE.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_intent_transitions', 'payment_attempt_transitions']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_update', t
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_delete', t
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_truncate', t
    );
    -- Solo lectura y SOLO para fluvia_app: el trigger de validacion corre con
    -- los privilegios del invocador. fluvia_worker sigue siendo cascaron
    -- (ADR-0011: cero privilegios de tabla — meta-test lo hace cumplir).
    EXECUTE format('GRANT SELECT ON %I TO fluvia_app', t);
    EXECUTE format(
      'REVOKE ALL ON %I FROM fluvia_worker, fluvia_relay, fluvia_inbox, fluvia_auth',
      t
    );
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I FROM fluvia_app', t);
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Triggers de validación de transición (el MOTOR decide, no el servicio)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluvia_validate_intent_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_intent_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'FLUVIA_INVALID_TRANSITION: payment_intent % -> % is not a legal transition',
      OLD.status, NEW.status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fluvia_validate_attempt_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_attempt_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'FLUVIA_INVALID_TRANSITION: payment_attempt % -> % is not a legal transition',
      OLD.status, NEW.status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

-- Nota: UPDATE OF status dispara cuando la columna aparece en el SET; una
-- "transición" al MISMO estado también debe estar en el mapa (solo
-- partially_refunded la tiene — refund parcial adicional).
CREATE TRIGGER payment_intents_fsm_guard
  BEFORE UPDATE OF status ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION fluvia_validate_intent_transition();

-- ----------------------------------------------------------------------------
-- 4. payment_attempts (uno por intento real contra el proveedor)
-- ----------------------------------------------------------------------------
CREATE TABLE payment_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id),
  intent_id       UUID NOT NULL,
  attempt_number  INT NOT NULL CHECK (attempt_number >= 1),
  provider        TEXT NOT NULL,
  provider_ref    TEXT,
  status          TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'submitting', 'submitted', 'requires_action',
    'indeterminate', 'succeeded', 'failed', 'expired'
  )),
  amount          BIGINT NOT NULL CHECK (amount > 0),
  currency        CHAR(3) NOT NULL,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at    TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  UNIQUE (intent_id, attempt_number),
  CONSTRAINT payment_attempts_intent_coherence_fk
    FOREIGN KEY (intent_id, tenant_id) REFERENCES payment_intents (id, tenant_id)
);

CREATE INDEX payment_attempts_tenant_intent_idx ON payment_attempts (tenant_id, intent_id);

CREATE TRIGGER payment_attempts_fsm_guard
  BEFORE UPDATE OF status ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION fluvia_validate_attempt_transition();

CREATE TRIGGER payment_attempts_no_delete
  BEFORE DELETE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER payment_attempts_no_truncate
  BEFORE TRUNCATE ON payment_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_attempts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON payment_attempts TO fluvia_app;
