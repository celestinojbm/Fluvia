-- ============================================================================
-- FLUVIA 0023_checkout_session_auth.sql  (F3-05c — flujo alojado, backend)
--
-- Autenticación de la página alojada por `client_secret` (sin API key: la
-- credencial ES el secreto, mismo modelo que la ingesta de webhooks del
-- proveedor). Cross-tenant por diseño — la request alojada no trae contexto de
-- tenant —, así que va por una función SECURITY DEFINER (como
-- `authenticate_api_key`): resuelve (session_id + hash) -> tenant_id, y NADA
-- más (no expone la fila; el servicio hace el resto ya con el tenant scoped).
-- ============================================================================

CREATE FUNCTION checkout_session_authenticate(p_session_id UUID, p_secret_hash TEXT)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  -- El secreto es de alta entropía (36 bytes): comparar su hash con `=` no es
  -- un vector de timing práctico (igual que `authenticate_api_key`).
  SELECT cs.tenant_id INTO v_tenant
  FROM checkout_sessions cs
  JOIN organizations o ON o.id = cs.tenant_id AND o.deleted_at IS NULL
  WHERE cs.id = p_session_id
    AND cs.client_secret_hash = p_secret_hash;
  RETURN v_tenant; -- NULL si no hay match (id inexistente o secreto equivocado)
END;
$$;

REVOKE ALL ON FUNCTION checkout_session_authenticate(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION checkout_session_authenticate(UUID, TEXT) TO fluvia_app;
