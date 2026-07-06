-- ============================================================================
-- FLUVIA 0027_reconciliation.sql  (F4-01a — motor de conciliación)
--
-- Concilia lo que Fluvia CREE que se liquidó (intentos `succeeded` con
-- `provider_ref` en payment_attempts) contra el REPORTE DE LIQUIDACIÓN del
-- proveedor (settlement report: líneas con provider_ref + monto + fee). El motor
-- clasifica cada referencia como matched / amount_mismatch / missing_in_ledger /
-- missing_at_provider — el siguiente invariante de dinero real tras refunds.
--
-- Alcance per-tenant (bajo RLS, sin definer): cada tenant concilia su propia
-- liquidación. La liquidación cross-tenant a nivel plataforma es un refinamiento
-- futuro. Todas las tablas son append-only (clase auditable).
-- ============================================================================

-- 1. Reporte de liquidación (un lote del proveedor para un tenant/moneda/periodo).
CREATE TABLE settlement_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES organizations(id),
  provider      TEXT NOT NULL,
  currency      CHAR(3) NOT NULL,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reconciled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  CONSTRAINT settlement_reports_period_ck CHECK (period_end > period_start)
);
CREATE INDEX settlement_reports_tenant_idx ON settlement_reports (tenant_id, created_at);

-- 2. Líneas del reporte (lo que el proveedor dice que liquidó).
CREATE TABLE settlement_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    UUID NOT NULL,
  tenant_id    UUID NOT NULL REFERENCES organizations(id),
  provider     TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  amount       BIGINT NOT NULL CHECK (amount > 0),
  currency     CHAR(3) NOT NULL,
  fee          BIGINT NOT NULL DEFAULT 0 CHECK (fee >= 0),
  settled_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Coherencia AUD-P1-001: una línea jamás cruza tenant hacia su reporte.
  CONSTRAINT settlement_lines_report_coherence_fk
    FOREIGN KEY (report_id, tenant_id) REFERENCES settlement_reports (id, tenant_id),
  -- Una referencia del proveedor aparece a lo sumo una vez por reporte.
  UNIQUE (report_id, provider, provider_ref)
);
CREATE INDEX settlement_lines_report_idx ON settlement_lines (report_id);

-- 3. Resultado de la conciliación (una fila por referencia comparada).
CREATE TABLE reconciliation_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id         UUID NOT NULL,
  tenant_id         UUID NOT NULL REFERENCES organizations(id),
  provider          TEXT NOT NULL,
  provider_ref      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN (
    'matched', 'amount_mismatch', 'missing_in_ledger', 'missing_at_provider'
  )),
  ledger_amount     BIGINT,
  provider_amount   BIGINT,
  payment_intent_id UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_entries_report_coherence_fk
    FOREIGN KEY (report_id, tenant_id) REFERENCES settlement_reports (id, tenant_id),
  UNIQUE (report_id, provider, provider_ref)
);
CREATE INDEX reconciliation_entries_report_idx ON reconciliation_entries (report_id, status);

-- Append-only + RLS por tenant en las tres tablas.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['settlement_reports', 'settlement_lines', 'reconciliation_entries']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_delete', t
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_truncate', t
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$CREATE POLICY tenant_isolation ON %I
           USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
           WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$,
      t
    );
  END LOOP;
END;
$$;

-- El plano de integración (fluvia_app) ingesta reportes/líneas y corre el motor
-- (todo per-tenant bajo RLS). SELECT/INSERT vienen de los privilegios por
-- defecto de 0002; el UPDATE de estado del reporte también. reconciliation_entries
-- es solo INSERT + SELECT desde la app (nunca UPDATE: cada corrida es inmutable).
REVOKE UPDATE ON reconciliation_entries FROM fluvia_app;
REVOKE UPDATE ON settlement_lines FROM fluvia_app;
GRANT SELECT, INSERT, UPDATE ON settlement_reports TO fluvia_app;
GRANT SELECT, INSERT ON settlement_lines TO fluvia_app;
GRANT SELECT, INSERT ON reconciliation_entries TO fluvia_app;
