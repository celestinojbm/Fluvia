-- ============================================================================
-- FLUVIA 0025_payment_links.sql  (F3-06 — payment links)
--
-- Un payment link es una PLANTILLA reutilizable "págame": cada vez que un
-- comprador lo abre se genera un payment_intent + checkout_session frescos
-- (reutiliza TODO el recurso de checkout de F3-05). El link en sí es público
-- (cualquiera con la URL puede pagar); no lleva secreto — el secreto vive en
-- la sesión que genera.
--
-- La resolución link -> tenant/merchant/monto es cross-tenant (la request del
-- comprador no trae contexto de tenant), así que va por una función SECURITY
-- DEFINER (como checkout_session_authenticate / authenticate_api_key).
-- ============================================================================

CREATE TABLE payment_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  merchant_id UUID NOT NULL,
  amount      BIGINT NOT NULL CHECK (amount > 0),
  currency    CHAR(3) NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  UNIQUE (id, tenant_id),
  -- Patrón AUD-P1-001: un link jamás cruza tenant hacia su merchant.
  CONSTRAINT payment_links_merchant_coherence_fk
    FOREIGN KEY (merchant_id, tenant_id) REFERENCES merchants (id, tenant_id)
);

CREATE INDEX payment_links_tenant_idx ON payment_links (tenant_id, created_at);

-- Append-only: sin DELETE/TRUNCATE; baja vía disabled_at + status.
CREATE TRIGGER payment_links_no_delete
  BEFORE DELETE ON payment_links
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER payment_links_no_truncate
  BEFORE TRUNCATE ON payment_links
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_links
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON payment_links TO fluvia_app;

-- ----------------------------------------------------------------------------
-- Resolución pública (cross-tenant): link activo -> datos para generar sesión.
-- Solo devuelve links ACTIVOS; un link inexistente o deshabilitado se comporta
-- igual (0 filas) — anti-enumeración.
-- ----------------------------------------------------------------------------
CREATE FUNCTION payment_link_resolve(p_link_id UUID)
RETURNS TABLE (tenant_id UUID, merchant_id UUID, amount BIGINT, currency TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT pl.tenant_id, pl.merchant_id, pl.amount, pl.currency::text
  FROM payment_links pl
  JOIN organizations o ON o.id = pl.tenant_id AND o.deleted_at IS NULL
  WHERE pl.id = p_link_id AND pl.status = 'active';
END;
$$;

REVOKE ALL ON FUNCTION payment_link_resolve(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payment_link_resolve(UUID) TO fluvia_app;
