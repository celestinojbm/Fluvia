-- ============================================================================
-- FLUVIA 0067_capabilities_verifications.sql
--
-- Jornada «ecosistema»: dos registros ADITIVOS, sin tocar dinero.
--
-- 1. capability_withdrawals — Operaciones RETIRA una capacidad de un mercado
--    (freno). El techo vive en el catálogo versionado (@fluvia/capabilities):
--    esta tabla solo puede BAJAR una capacidad a «no ofrecida», nunca subirla.
--    Cada retirada lleva motivo y autor; levantarla exige OTRA persona
--    (cuatro ojos) y su motivo. Sin DELETE: el historial queda.
--    Tenant = organización programa (Fluvia Operaciones).
--
-- 2. uncertain_verifications — bitácora APPEND-ONLY de cada consulta
--    verificable de un cobro o devolución incierto (quién/qué la pidió, cuándo
--    y qué respondió el proveedor). Solo se aplica lo que el proveedor afirma. Permite mostrar «última verificación» con
--    un hecho registrado, no con una suposición. Tenant = comercio.
-- ============================================================================

CREATE TABLE capability_withdrawals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES organizations(id),
  market                CHAR(2) NOT NULL CHECK (market ~ '^[A-Z]{2}$'),
  capability            TEXT NOT NULL CHECK (capability ~ '^[a-z]+\.[a-z_]+$'),
  reason                TEXT NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 280),
  withdrawn_by_user_id  UUID NOT NULL,
  withdrawn_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_by_user_id     UUID,
  lifted_at             TIMESTAMPTZ,
  lift_reason           TEXT CHECK (lift_reason IS NULL OR char_length(lift_reason) BETWEEN 5 AND 280),
  CONSTRAINT capability_withdrawals_lift_chk CHECK (
    (lifted_at IS NULL) = (lifted_by_user_id IS NULL)
    AND (lifted_at IS NULL) = (lift_reason IS NULL)),
  -- Cuatro ojos: quien retiró no puede levantar su propia retirada.
  CONSTRAINT capability_withdrawals_four_eyes_chk CHECK (
    lifted_by_user_id IS NULL OR lifted_by_user_id <> withdrawn_by_user_id)
);
-- Una sola retirada VIGENTE por (programa, mercado, capacidad).
CREATE UNIQUE INDEX capability_withdrawals_open_uq
  ON capability_withdrawals (tenant_id, market, capability) WHERE lifted_at IS NULL;

-- Solo se puede LEVANTAR (una vez); el resto de columnas es inmutable.
CREATE OR REPLACE FUNCTION fluvia_capability_withdrawal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.lifted_at IS NOT NULL THEN
    RAISE EXCEPTION 'FLUVIA_CAPABILITY_WITHDRAWAL: already lifted';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.market <> OLD.market
     OR NEW.capability <> OLD.capability OR NEW.reason <> OLD.reason
     OR NEW.withdrawn_by_user_id <> OLD.withdrawn_by_user_id
     OR NEW.withdrawn_at <> OLD.withdrawn_at THEN
    RAISE EXCEPTION 'FLUVIA_CAPABILITY_WITHDRAWAL: only lifting is allowed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capability_withdrawals_guard
  BEFORE UPDATE ON capability_withdrawals
  FOR EACH ROW EXECUTE FUNCTION fluvia_capability_withdrawal_guard();
CREATE TRIGGER capability_withdrawals_no_delete
  BEFORE DELETE ON capability_withdrawals
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();

CREATE TABLE uncertain_verifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES organizations(id),
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('payment_attempt', 'refund')),
  subject_id    UUID NOT NULL,
  -- Qué contestó la consulta al proveedor.
  verdict       TEXT NOT NULL CHECK (verdict IN ('approved', 'declined', 'pending', 'unknown', 'no_response')),
  -- Si el veredicto se aplicó (cerró el incierto) o el sujeto sigue incierto.
  applied       BOOLEAN NOT NULL,
  -- Quién la disparó: el worker (automática), una persona del comercio o
  -- una persona de Operaciones. Ninguna decide el resultado: lo da el proveedor.
  triggered_by  TEXT NOT NULL CHECK (triggered_by IN ('automatic', 'merchant_user', 'operator_user')),
  actor_user_id UUID,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((triggered_by <> 'automatic') = (actor_user_id IS NOT NULL))
);
CREATE INDEX uncertain_verifications_subject_idx
  ON uncertain_verifications (tenant_id, subject_type, subject_id, checked_at DESC);

CREATE TRIGGER uncertain_verifications_no_mutation
  BEFORE UPDATE OR DELETE ON uncertain_verifications
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['capability_withdrawals', 'uncertain_verifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON capability_withdrawals TO fluvia_app;
GRANT SELECT, INSERT ON uncertain_verifications TO fluvia_app;
