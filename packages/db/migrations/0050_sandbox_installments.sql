-- ============================================================================
-- FLUVIA 0050_sandbox_installments.sql  («Pagar en cuotas» — SIMULACIÓN)
--
-- Motor de cuotas de DEMOSTRACIÓN con proveedor SIMULADO. No hay financiador,
-- ni crédito real, ni cobro externo, ni intereses, ni mora, ni scoring.
--
-- Separación de la contabilidad real (decisión de diseño, verificable):
--  - Tablas propias con prefijo `sandbox_`. Ninguna referencia al ledger,
--    a payment_intents/attempts ni a saldos. Un plan APROBADO no cambia el
--    estado de pago del pedido (que se deriva SOLO de payment_intents) ni
--    incrementa saldo alguno.
--  - Las cuotas cambian de estado SOLO por un evento simulado explícito
--    (registrado en sandbox_installment_events). Nada se deduce ni se marca
--    por el paso del tiempo.
--
-- Garantía contra doble cobro (la única interacción con pagos): mientras un
-- plan del pedido esté `pending`/`approved`, el payment link del pedido NO
-- puede empezar un cobro con tarjeta/transferencia (trigger sobre
-- payment_intents → processing). Al revés, el servicio solo crea un plan si
-- la venta no tiene un cobro en curso o hecho, bajo el lock del link. Esto
-- NO altera importes ni el ledger: solo impide empezar un segundo cobro.
--
-- Importes en unidades menores; Σ cuotas = total (constraint diferido).
-- ============================================================================

CREATE TABLE sandbox_installment_plans (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES organizations(id),
  order_id            UUID NOT NULL,
  payment_link_id     UUID NOT NULL,
  checkout_session_id UUID NOT NULL,
  currency            CHAR(3) NOT NULL,
  total               BIGINT NOT NULL CHECK (total > 0),
  installments_count  INT NOT NULL CHECK (installments_count BETWEEN 2 AND 12),
  interval_days       INT NOT NULL CHECK (interval_days BETWEEN 1 AND 62),
  -- Versión de los parámetros de DEMOSTRACIÓN aplicados (no política comercial).
  terms_version       TEXT NOT NULL,
  -- Escenario elegido en el checkout de prueba (como tok_approve/tok_decline).
  scenario            TEXT NOT NULL CHECK (scenario IN ('approve', 'decline', 'pending')),
  status              TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
  buyer_confirmed_at  TIMESTAMPTZ NOT NULL,
  decided_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT sandbox_plans_order_fk
    FOREIGN KEY (order_id, tenant_id) REFERENCES commerce_orders (id, tenant_id),
  CONSTRAINT sandbox_plans_link_fk
    FOREIGN KEY (payment_link_id, tenant_id) REFERENCES payment_links (id, tenant_id),
  CONSTRAINT sandbox_plans_session_fk
    FOREIGN KEY (checkout_session_id, tenant_id) REFERENCES checkout_sessions (id, tenant_id),
  CONSTRAINT sandbox_plans_decided_chk CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- Como máximo UN plan vivo por pedido.
CREATE UNIQUE INDEX sandbox_plans_active_uq ON sandbox_installment_plans (order_id)
  WHERE status IN ('pending', 'approved');
CREATE INDEX sandbox_plans_tenant_idx ON sandbox_installment_plans (tenant_id, created_at DESC);
CREATE INDEX sandbox_plans_link_idx ON sandbox_installment_plans (payment_link_id);

CREATE TABLE sandbox_installments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES organizations(id),
  plan_id           UUID NOT NULL,
  seq               INT NOT NULL CHECK (seq BETWEEN 1 AND 12),
  amount            BIGINT NOT NULL CHECK (amount > 0),
  due_date          DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled', 'paid_simulated', 'overdue_simulated')),
  status_changed_at TIMESTAMPTZ,
  UNIQUE (plan_id, seq),
  CONSTRAINT sandbox_installments_plan_fk
    FOREIGN KEY (plan_id, tenant_id) REFERENCES sandbox_installment_plans (id, tenant_id)
);

-- Registro append-only de los eventos SIMULADOS (decisión del proveedor
-- simulado, cuota pagada/vencida simulada). Rastro para comercio y comprador.
CREATE TABLE sandbox_installment_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES organizations(id),
  plan_id       UUID NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'plan_requested', 'plan_approved', 'plan_declined',
                  'installment_paid_simulated', 'installment_overdue_simulated')),
  seq           INT,
  actor         TEXT NOT NULL CHECK (actor IN ('buyer', 'simulated_provider', 'operator')),
  actor_user_id UUID,
  -- clock_timestamp(): varios eventos en la MISMA transacción quedan ordenados.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT sandbox_events_plan_fk
    FOREIGN KEY (plan_id, tenant_id) REFERENCES sandbox_installment_plans (id, tenant_id)
);
CREATE INDEX sandbox_events_plan_idx ON sandbox_installment_events (plan_id, created_at);

-- ----------------------------------------------------------------------------
-- Máquinas de estado (el MOTOR decide; sin transiciones por tiempo)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluvia_sandbox_plan_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.order_id <> OLD.order_id
     OR NEW.total <> OLD.total OR NEW.currency <> OLD.currency
     OR NEW.installments_count <> OLD.installments_count
     OR NEW.payment_link_id <> OLD.payment_link_id
     OR NEW.scenario <> OLD.scenario OR NEW.terms_version <> OLD.terms_version
     OR NEW.buyer_confirmed_at <> OLD.buyer_confirmed_at THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: installment plan terms cannot change'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('approved', 'declined')) THEN
    RAISE EXCEPTION 'FLUVIA_INVALID_TRANSITION: installment plan % -> %', OLD.status, NEW.status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sandbox_plans_guard
  BEFORE UPDATE ON sandbox_installment_plans
  FOR EACH ROW EXECUTE FUNCTION fluvia_sandbox_plan_guard();

CREATE OR REPLACE FUNCTION fluvia_sandbox_installment_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_plan_status TEXT;
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.due_date <> OLD.due_date OR NEW.seq <> OLD.seq
     OR NEW.plan_id <> OLD.plan_id THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: installment schedule cannot change'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT status INTO v_plan_status FROM sandbox_installment_plans WHERE id = NEW.plan_id;
    IF v_plan_status <> 'approved' THEN
      RAISE EXCEPTION 'FLUVIA_INVALID_TRANSITION: installments move only in an approved plan'
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NOT ((OLD.status = 'scheduled' AND NEW.status IN ('paid_simulated', 'overdue_simulated'))
         OR (OLD.status = 'overdue_simulated' AND NEW.status = 'paid_simulated')) THEN
      RAISE EXCEPTION 'FLUVIA_INVALID_TRANSITION: installment % -> %', OLD.status, NEW.status
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sandbox_installments_guard
  BEFORE UPDATE ON sandbox_installments
  FOR EACH ROW EXECUTE FUNCTION fluvia_sandbox_installment_guard();

-- Σ cuotas = total y nº de cuotas = installments_count (al COMMIT).
CREATE OR REPLACE FUNCTION fluvia_sandbox_assert_plan_sum(p_plan_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_total BIGINT;
  v_count INT;
  v_sum   NUMERIC;
  v_n     INT;
BEGIN
  SELECT total, installments_count INTO v_total, v_count
  FROM sandbox_installment_plans WHERE id = p_plan_id;
  SELECT coalesce(sum(amount), 0), count(*) INTO v_sum, v_n
  FROM sandbox_installments WHERE plan_id = p_plan_id;
  IF v_sum <> v_total OR v_n <> v_count THEN
    RAISE EXCEPTION 'FLUVIA_INSTALLMENTS_INVARIANT: installments must add up to the plan total'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION fluvia_sandbox_plan_sum_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM fluvia_sandbox_assert_plan_sum(NEW.id);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION fluvia_sandbox_installment_sum_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM fluvia_sandbox_assert_plan_sum(NEW.plan_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER sandbox_plans_sum
  AFTER INSERT ON sandbox_installment_plans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fluvia_sandbox_plan_sum_check();
CREATE CONSTRAINT TRIGGER sandbox_installments_sum
  AFTER INSERT ON sandbox_installments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fluvia_sandbox_installment_sum_check();

-- ----------------------------------------------------------------------------
-- Guarda de doble cobro: con un plan vivo, el pedido no empieza otro cobro.
-- Corre DESPUÉS de que el servicio de pagos tome el lock del link (beginIn):
-- un plan confirmado antes es visible aquí (READ COMMITTED).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluvia_sandbox_plan_blocks_charge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.payment_link_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM sandbox_installment_plans p
    WHERE p.payment_link_id = NEW.payment_link_id
      AND p.tenant_id = NEW.tenant_id
      AND p.status IN ('pending', 'approved')
  ) THEN
    RAISE EXCEPTION 'FLUVIA_INSTALLMENT_PLAN_ACTIVE: this sale has an active installment plan'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_intents_sandbox_plan_guard
  BEFORE UPDATE OF status ON payment_intents
  FOR EACH ROW
  WHEN (NEW.status = 'processing' AND OLD.status IS DISTINCT FROM 'processing')
  EXECUTE FUNCTION fluvia_sandbox_plan_blocks_charge();

-- ----------------------------------------------------------------------------
-- Append-only + RLS forzado
-- ----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sandbox_installment_plans', 'sandbox_installments',
                           'sandbox_installment_events'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_truncate', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END;
$$;

CREATE TRIGGER sandbox_installment_events_no_update
  BEFORE UPDATE ON sandbox_installment_events
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();

GRANT SELECT, INSERT, UPDATE ON sandbox_installment_plans, sandbox_installments TO fluvia_app;
GRANT SELECT, INSERT ON sandbox_installment_events TO fluvia_app;
