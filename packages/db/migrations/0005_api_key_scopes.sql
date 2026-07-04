-- ============================================================================
-- FLUVIA 0005_api_key_scopes.sql  (F1-04c)
--
-- API keys con scopes, entorno (test/live), prefijo visible y last_used_at.
-- authenticate_api_key se recrea para devolver scopes+environment y tocar
-- last_used_at (throttled) en una sola llamada.
-- ============================================================================

ALTER TABLE api_keys
  ADD COLUMN scopes TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN environment TEXT NOT NULL DEFAULT 'test' CHECK (environment IN ('test', 'live')),
  ADD COLUMN key_prefix TEXT NOT NULL DEFAULT '',
  ADD COLUMN created_by_user_id UUID REFERENCES users(id),
  ADD COLUMN last_used_at TIMESTAMPTZ;

-- El tipo de retorno cambia: DROP + CREATE (no se puede OR REPLACE).
DROP FUNCTION authenticate_api_key(TEXT);

CREATE FUNCTION authenticate_api_key(p_key_hash TEXT)
RETURNS TABLE (tenant_id UUID, api_key_id UUID, scopes TEXT[], environment TEXT)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k RECORD;
BEGIN
  SELECT ak.tenant_id AS t_id, ak.id AS k_id, ak.scopes AS k_scopes,
         ak.environment AS k_env, ak.last_used_at AS k_last
  INTO k
  FROM api_keys ak
  JOIN organizations o ON o.id = ak.tenant_id AND o.deleted_at IS NULL
  WHERE ak.key_hash = p_key_hash
    AND ak.revoked_at IS NULL
    AND ak.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- last_used_at con throttle de 60s para no amplificar escrituras.
  IF k.k_last IS NULL OR k.k_last < now() - interval '60 seconds' THEN
    UPDATE api_keys SET last_used_at = now() WHERE id = k.k_id;
  END IF;

  RETURN QUERY SELECT k.t_id, k.k_id, k.k_scopes, k.k_env;
END;
$$;

REVOKE ALL ON FUNCTION authenticate_api_key(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_api_key(TEXT) TO fluvia_app;
