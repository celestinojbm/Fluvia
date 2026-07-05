-- ============================================================================
-- FLUVIA 0016_api_key_hmac.sql  (AUD-P2-015 — HMAC server-side para API keys)
--
-- Problema: con SHA-256 puro, un dump de la tabla permite validar claves
-- candidatas offline (mitigado hoy solo por los 24 bytes de entropia).
-- Solucion: HMAC-SHA256 con un secreto de servidor (pepper) que NO vive en la
-- base — un dump deja de ser suficiente para verificar nada offline.
--
-- Versionado y migracion perezosa (sin downtime ni re-emision):
--   key_hash_version 1 = sha256(secret)          (legado)
--   key_hash_version 2 = hmac_sha256(pepper, secret)
-- En cada autenticacion el caller (unico con el plaintext en mano) computa
-- AMBOS hashes; si la fila matchea por la via legada, se promueve a v2 EN la
-- misma llamada. Las claves nuevas nacen v2. Cuando no queden filas v1, una
-- migracion futura eliminara la via legada.
-- ============================================================================

ALTER TABLE api_keys
  ADD COLUMN key_hash_version INT NOT NULL DEFAULT 1 CHECK (key_hash_version IN (1, 2));

-- Nueva firma: DROP + CREATE (cambia la aridad).
DROP FUNCTION authenticate_api_key(TEXT);

CREATE FUNCTION authenticate_api_key(p_hmac_hash TEXT, p_legacy_hash TEXT)
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
         ak.environment AS k_env, ak.last_used_at AS k_last,
         ak.key_hash_version AS k_version
  INTO k
  FROM api_keys ak
  JOIN organizations o ON o.id = ak.tenant_id AND o.deleted_at IS NULL
  WHERE ((ak.key_hash_version = 2 AND ak.key_hash = p_hmac_hash)
      OR (ak.key_hash_version = 1 AND ak.key_hash = p_legacy_hash))
    AND ak.revoked_at IS NULL
    AND ak.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Upgrade perezoso: solo tras un match legado exitoso (el caller demostro
  -- conocer el plaintext) y solo si el HMAC recibido tiene forma valida.
  IF k.k_version = 1 AND p_hmac_hash ~ '^[0-9a-f]{64}$' THEN
    UPDATE api_keys SET key_hash = p_hmac_hash, key_hash_version = 2 WHERE id = k.k_id;
  END IF;

  -- last_used_at con throttle de 60s para no amplificar escrituras.
  IF k.k_last IS NULL OR k.k_last < now() - interval '60 seconds' THEN
    UPDATE api_keys SET last_used_at = now() WHERE id = k.k_id;
  END IF;

  RETURN QUERY SELECT k.t_id, k.k_id, k.k_scopes, k.k_env;
END;
$$;

REVOKE ALL ON FUNCTION authenticate_api_key(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_api_key(TEXT, TEXT) TO fluvia_app;
