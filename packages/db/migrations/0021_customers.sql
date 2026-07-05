-- ============================================================================
-- FLUVIA 0021_customers.sql  (F3-05a — customers)
--
-- Recurso `customers` (diferido desde F3-02: su primer consumidor real es el
-- checkout de F3-05). Semántica tipo Stripe: el email NO es único — un mismo
-- correo puede tener varios customers (personas/negocios distintos comparten
-- correo). Clave compuesta (id, tenant_id) para los FK futuros de checkout
-- sessions y payment links (patrón AUD-P1-001). Metadata validada en el
-- servicio (Zod), nunca datos crudos.
-- ============================================================================

CREATE TABLE customers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  email       TEXT,
  name        TEXT,
  phone       TEXT,
  description TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  -- FK futura (checkout_sessions/payment_links): un customer jamás cruza tenant.
  UNIQUE (id, tenant_id)
);

CREATE INDEX customers_tenant_idx ON customers (tenant_id, created_at);
-- Búsqueda por email dentro del tenant (no único, pero sí indexado).
CREATE INDEX customers_tenant_email_idx ON customers (tenant_id, email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;

-- Append-only: sin DELETE/TRUNCATE; baja lógica vía deleted_at.
CREATE TRIGGER customers_no_delete
  BEFORE DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER customers_no_truncate
  BEFORE TRUNCATE ON customers
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON customers TO fluvia_app;
