-- ============================================================================
-- FLUVIA 0030_case_adjustments.sql  (F4-03b — ajuste monetario con four-eyes)
--
-- Cierra el §30: "todo ajuste pasa por asiento en recon.differences con caso,
-- razón, actor y aprobación (four-eyes para montos sobre umbral, Nivel C)".
-- Un `case_adjustment` es la AUTORIZACIÓN de un ajuste monetario sobre un
-- `operational_case`: lo PROPONE un humano y, sobre umbral, lo APRUEBA un
-- SEGUNDO humano distinto (four-eyes). Al aprobarse se postea un asiento
-- compensatorio real (recon.differences ↔ suspense) enlazado al caso, y el caso
-- queda `resolved` — todo en UNA transacción (onPosted del ledger).
--
-- Invariante Nivel A: ni la IA ni un solo humano autorizan dinero real sobre
-- umbral. El `proposed_by_user_id` es NOT NULL (proponer es un acto humano) y el
-- guard four-eyes es un CHECK en la BD, no solo en el servicio.
-- ============================================================================

-- FK compuesta por tenant (AUD-P1-001): un ajuste jamás cruza tenant hacia su caso.
ALTER TABLE operational_cases
  ADD CONSTRAINT operational_cases_id_tenant_key UNIQUE (id, tenant_id);

CREATE TABLE case_adjustments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES organizations(id),
  case_id               UUID NOT NULL,
  amount                BIGINT NOT NULL CHECK (amount > 0),
  currency              CHAR(3) NOT NULL,
  -- Dirección del asiento: reconoce (debit recon.differences) o revierte
  -- (credit recon.differences) la diferencia. El otro lado es `suspense`.
  direction             TEXT NOT NULL CHECK (direction IN ('debit_differences', 'credit_differences')),
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed', 'applied', 'rejected')),
  -- Sobre umbral => exige un segundo aprobador distinto (four-eyes).
  requires_second_approval BOOLEAN NOT NULL,
  proposed_by_user_id   UUID NOT NULL,
  approved_by_user_id   UUID,
  rejected_by_user_id   UUID,
  rejection_reason      TEXT,
  ledger_transaction_id UUID,
  version               BIGINT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at           TIMESTAMPTZ,
  CONSTRAINT case_adjustments_case_coherence_fk
    FOREIGN KEY (case_id, tenant_id) REFERENCES operational_cases (id, tenant_id),
  -- FOUR-EYES EN LA BD: si requiere segunda aprobación, el aprobador jamás es
  -- el proponente (ni siquiera un bug del servicio puede saltárselo).
  CONSTRAINT case_adjustments_four_eyes_ck
    CHECK (NOT requires_second_approval
           OR approved_by_user_id IS NULL
           OR approved_by_user_id <> proposed_by_user_id),
  -- `applied` exige el asiento posteado + el aprobador.
  CONSTRAINT case_adjustments_applied_ck
    CHECK (status <> 'applied'
           OR (ledger_transaction_id IS NOT NULL AND approved_by_user_id IS NOT NULL)),
  -- `rejected` exige quién y por qué.
  CONSTRAINT case_adjustments_rejected_ck
    CHECK (status <> 'rejected'
           OR (rejected_by_user_id IS NOT NULL AND rejection_reason IS NOT NULL))
);
CREATE INDEX case_adjustments_case_idx ON case_adjustments (case_id);
-- A lo sumo UN ajuste vivo (proposed/applied) por caso; uno rechazado puede
-- reemplazarse por una nueva propuesta.
CREATE UNIQUE INDEX case_adjustments_one_active ON case_adjustments (case_id)
  WHERE status <> 'rejected';

-- RLS por tenant (mutable por el ciclo; sin DELETE/TRUNCATE — registro auditable).
ALTER TABLE case_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON case_adjustments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE TRIGGER case_adjustments_no_delete
  BEFORE DELETE ON case_adjustments
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER case_adjustments_no_truncate
  BEFORE TRUNCATE ON case_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

GRANT SELECT, INSERT, UPDATE ON case_adjustments TO fluvia_app;
