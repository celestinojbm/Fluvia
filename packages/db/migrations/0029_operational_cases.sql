-- ============================================================================
-- FLUVIA 0029_operational_cases.sql  (F4-03a — casos operativos de conciliación)
--
-- Cada DISCREPANCIA de conciliación (una `reconciliation_entry` cuyo estado no es
-- `matched`) se materializa como un `operational_case`: severidad, evidencia
-- (snapshot de la entry), estado del ciclo y resolución. Lleva la conciliación de
-- "detectar + alertar" (F4-02) a "casos rastreables que un operador trabaja".
--
-- La materialización es un TRIGGER AFTER INSERT sobre reconciliation_entries: se
-- dispara automáticamente para AMBAS vías de conciliación (el motor per-tenant
-- F4-01a bajo fluvia_app, y el barrido F4-02 dentro del SECURITY DEFINER como
-- postgres) sin duplicar lógica y de forma atómica con la entry. Idempotente: un
-- caso por entry (UNIQUE + ON CONFLICT DO NOTHING).
--
-- IMPORTANTE (Nivel A): resolver un caso es DOCUMENTAL — registra la disposición
-- del operador; NO mueve dinero ni ajusta ningún saldo. El ajuste monetario
-- (asiento compensatorio) con control de doble aprobación (four-eyes sobre
-- umbral) es un incremento aparte (F4-03b): la IA/automatización jamás autoriza
-- dinero real por sí sola (V4 §30: prohibida la corrección silenciosa).
-- ============================================================================

-- Necesario para la FK compuesta de coherencia por tenant (AUD-P1-001).
ALTER TABLE reconciliation_entries
  ADD CONSTRAINT reconciliation_entries_id_tenant_key UNIQUE (id, tenant_id);

CREATE TABLE operational_cases (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES organizations(id),
  case_type             TEXT NOT NULL DEFAULT 'reconciliation_discrepancy'
                          CHECK (case_type IN ('reconciliation_discrepancy')),
  severity              TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'acknowledged', 'resolved')),
  -- Evidencia: la entry de conciliación que originó el caso + snapshot inmutable
  -- de sus datos (para no depender de un JOIN y dejar el caso auto-contenido).
  reconciliation_entry_id UUID NOT NULL,
  report_id             UUID,
  provider              TEXT,
  provider_ref          TEXT,
  discrepancy_status    TEXT,
  ledger_amount         BIGINT,
  provider_amount       BIGINT,
  -- Ciclo de vida (el "quién" fino vive en audit_events; estas columnas son el
  -- estado actual). No FK a users: users es global y el actor puede ser api_key.
  assignee_user_id      UUID,
  resolution            TEXT,
  resolved_by_user_id   UUID,
  version               BIGINT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at      TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  -- Un caso por discrepancia (materialización idempotente).
  UNIQUE (reconciliation_entry_id),
  CONSTRAINT operational_cases_entry_coherence_fk
    FOREIGN KEY (reconciliation_entry_id, tenant_id)
      REFERENCES reconciliation_entries (id, tenant_id),
  -- Un caso resuelto EXIGE resolución documentada + marca temporal.
  CONSTRAINT operational_cases_resolution_ck
    CHECK (status <> 'resolved' OR (resolution IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX operational_cases_tenant_idx ON operational_cases (tenant_id, status, created_at DESC);

-- RLS por tenant (mutable: el ciclo de vida hace UPDATE; el borrado sí se prohíbe).
ALTER TABLE operational_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operational_cases
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Sin DELETE/TRUNCATE: registro operativo auditable (defensa en profundidad
-- además de la ausencia de GRANT DELETE).
CREATE TRIGGER operational_cases_no_delete
  BEFORE DELETE ON operational_cases
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER operational_cases_no_truncate
  BEFORE TRUNCATE ON operational_cases
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- fluvia_app: leer + materializar (trigger) + transicionar el ciclo. Los grants
-- por defecto (0002) ya dan a/r/w a fluvia_app y NADA a fluvia_worker; se declara
-- explícito para que el privilegio sea legible en el propio módulo.
GRANT SELECT, INSERT, UPDATE ON operational_cases TO fluvia_app;

-- Trigger de materialización: cada discrepancia -> un caso. NO es SECURITY
-- DEFINER; corre en el contexto del INSERT (fluvia_app con RLS en la vía manual,
-- postgres dentro del definer en el barrido). Solo entries != matched.
CREATE OR REPLACE FUNCTION materialize_reconciliation_case()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'matched' THEN
    INSERT INTO operational_cases
      (tenant_id, case_type, severity, reconciliation_entry_id, report_id,
       provider, provider_ref, discrepancy_status, ledger_amount, provider_amount)
    VALUES (
      NEW.tenant_id,
      'reconciliation_discrepancy',
      CASE NEW.status
        -- Dinero que el proveedor liquidó y Fluvia no ve: lo más peligroso.
        WHEN 'missing_in_ledger' THEN 'critical'
        -- Montos que difieren / cobros que el proveedor no reporta: alto.
        WHEN 'amount_mismatch' THEN 'high'
        WHEN 'missing_at_provider' THEN 'high'
        ELSE 'medium'
      END,
      NEW.id, NEW.report_id, NEW.provider, NEW.provider_ref, NEW.status,
      NEW.ledger_amount, NEW.provider_amount
    )
    ON CONFLICT (reconciliation_entry_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER reconciliation_entries_materialize_case
  AFTER INSERT ON reconciliation_entries
  FOR EACH ROW EXECUTE FUNCTION materialize_reconciliation_case();
