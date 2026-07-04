-- ============================================================================
-- FLUVIA 0002_enable_rls.sql  (P0-02: migracion fundacional de RLS)
--
-- Modelo multi-tenant: cada request corre con la variable de sesion
-- app.tenant_id (inyectada por withTenantTransaction via set_config(..., true),
-- es decir, SET LOCAL: el contexto muere con la transaccion).
--
-- Roles:
--   * fluvia_app    -> rol de la API. RLS FORZADO: solo ve/escribe su tenant.
--   * fluvia_worker -> rol del Outbox Relay Worker. BYPASSRLS: procesa la cola
--                      de todos los tenants. Sin DELETE (append-only).
--
-- Nota: los passwords de abajo son SOLO para desarrollo local. En produccion
-- los roles se aprovisionan por infraestructura con credenciales gestionadas.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fluvia_app') THEN
    CREATE ROLE fluvia_app LOGIN PASSWORD 'fluvia_app_dev_password';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fluvia_worker') THEN
    CREATE ROLE fluvia_worker LOGIN PASSWORD 'fluvia_worker_dev_password' BYPASSRLS;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO fluvia_app, fluvia_worker;
-- Sin GRANT DELETE: defensa en profundidad ademas de los triggers.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO fluvia_app, fluvia_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fluvia_app, fluvia_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO fluvia_app, fluvia_worker;

-- ----------------------------------------------------------------------------
-- RLS: habilitado y FORZADO en toda tabla con datos de tenant.
-- FORCE garantiza que ni siquiera el owner de la tabla se salta las politicas.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants', 'api_keys', 'ledger_accounts', 'ledger_transactions',
    'ledger_entries', 'outbox_events', 'idempotency_keys',
    'payment_intents', 'raw_provider_payloads_dlq'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END;
$$;

-- Nota empirica (validada por test): tras revertirse un set_config local,
-- current_setting(..., missing_ok) devuelve '' (no NULL) en la misma sesion;
-- sin NULLIF el cast a uuid rompe la consulta en vez de denegar filas.

-- tenants: un tenant solo puede LEERSE a si mismo. Altas/bajas de tenants son
-- operaciones administrativas (rol de plataforma), nunca del rol de API.
CREATE POLICY tenant_self_read ON tenants
  FOR SELECT
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Politica estandar de aislamiento para el resto de tablas tenant-scoped.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'api_keys', 'ledger_accounts', 'ledger_transactions', 'ledger_entries',
    'outbox_events', 'idempotency_keys', 'payment_intents',
    'raw_provider_payloads_dlq'
  ]
  LOOP
    EXECUTE format(
      $p$CREATE POLICY tenant_isolation ON %I
           USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
           WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$,
      t
    );
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- Autenticacion: resolver api_key -> tenant ANTES de tener contexto de tenant
-- (huevo-y-gallina con RLS). SECURITY DEFINER acotado y con search_path fijo.
-- ----------------------------------------------------------------------------
CREATE FUNCTION authenticate_api_key(p_key_hash TEXT)
RETURNS TABLE (tenant_id UUID, api_key_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ak.tenant_id, ak.id
  FROM api_keys ak
  JOIN tenants t ON t.id = ak.tenant_id AND t.deleted_at IS NULL
  WHERE ak.key_hash = p_key_hash
    AND ak.revoked_at IS NULL
    AND ak.deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION authenticate_api_key(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_api_key(TEXT) TO fluvia_app;
