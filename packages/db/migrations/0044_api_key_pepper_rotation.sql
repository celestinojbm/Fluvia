-- ============================================================================
-- FLUVIA 0044_api_key_pepper_rotation.sql  (F6, ADR-0012 — rotación del pepper
-- HMAC de API keys, TERCERA pata de rotación de secretos)
--
-- El pepper (`API_KEY_HMAC_SECRET`) es HMAC ONE-WAY: a diferencia de las claves
-- AES-GCM de webhooks/MFA, un hash guardado NO se puede re-hashear a un pepper
-- nuevo sin el secreto en claro (que solo el llamador tiene, al autenticar). Por
-- eso el re-hash es forzosamente PEREZOSO — la misma mecánica del upgrade
-- v1(sha256)→v2(hmac) que ya existe (0016), extendida a pepper-viejo→pepper-nuevo.
--
-- Para poder RETIRAR un pepper viejo con seguridad VERIFICABLE (el gate `--check`
-- que tuvieron las otras dos patas) hace falta saber qué filas siguen bajo él, y
-- eso exige una marca por-fila. Se añade `key_hash_pepper_fp`: una HUELLA one-way
-- del pepper que produjo el `key_hash` (no el pepper). Límite honesto (Nivel A): a
-- diferencia de `key_hash = hmac(pepper, secret)` (que exige un secreto en claro para
-- probar un pepper candidato), la huella es un ORÁCULO de verificación derivado SOLO
-- del pepper — con un dump se puede CONFIRMAR un pepper adivinado offline sin conocer
-- ningún secreto. NO es explotable contra un pepper aleatorio de 256 bits (confirmar
-- exige adivinar los 256 bits; la huella no estrecha la búsqueda), pero es una
-- exposición NUEVA respecto al `key_hash` — un trade-off aceptado por el gate de retiro
-- verificable. La calcula la APP (tiene el pepper) y la pasa; la BD nunca la deriva.
--
--   key_hash_version 1 = sha256(secret)            (legado, sin pepper → fp NULL)
--   key_hash_version 2 = hmac_sha256(pepper, secret) + key_hash_pepper_fp = huella
--
-- Rotación (runbook api-key-pepper-rotation.md): pepper nuevo = ACTUAL, viejo =
-- RETIRADO en config. Al autenticar, el caller computa el hmac con el actual y con
-- cada retirado; la fila matchea por cualquiera y se RE-HASHEA al actual (fijando
-- la huella nueva). El gate `--check` cuenta las filas bajo el pepper retirado; se
-- retira cuando llega a 0 (las keys dormidas se revocan+re-emiten).
-- ============================================================================

ALTER TABLE api_keys
  ADD COLUMN key_hash_pepper_fp TEXT;

COMMENT ON COLUMN api_keys.key_hash_pepper_fp IS
  'Huella one-way (no secreta) del pepper que produjo key_hash, para el gate de rotación. '
  'NULL en filas v1 (sha256) y en filas v2 previas a esta migración (hasta backfill o re-hash perezoso).';

-- Nueva firma (cambia la aridad): DROP + CREATE. Añade el vector de hashes bajo
-- peppers RETIRADOS y la huella del pepper actual (para fijarla en el upgrade).
DROP FUNCTION authenticate_api_key(TEXT, TEXT);

CREATE FUNCTION authenticate_api_key(
  p_hmac_hash TEXT,          -- hmac(pepper ACTUAL, secret)
  p_legacy_hash TEXT,        -- sha256(secret) (legado v1)
  p_retired_hashes TEXT[],   -- hmac(pepper_retirado_i, secret) por cada retirado
  p_pepper_fp TEXT           -- huella del pepper ACTUAL (se fija en el re-hash)
)
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
         ak.key_hash AS k_hash
  INTO k
  FROM api_keys ak
  JOIN organizations o ON o.id = ak.tenant_id AND o.deleted_at IS NULL
  WHERE ak.revoked_at IS NULL
    AND ak.deleted_at IS NULL
    AND (
      (ak.key_hash_version = 2
        AND (ak.key_hash = p_hmac_hash OR ak.key_hash = ANY(p_retired_hashes)))
      OR (ak.key_hash_version = 1 AND ak.key_hash = p_legacy_hash)
    );

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Re-hash perezoso al pepper ACTUAL: solo cuando el hash guardado NO es ya el
  -- actual (matcheó vía un pepper RETIRADO o el sha256 legado) y el hash/huella
  -- actuales tienen forma válida (el caller demostró conocer el plaintext). Sube
  -- a v2 y fija la huella del pepper actual, para que el gate de retiro sea exacto.
  IF k.k_hash <> p_hmac_hash AND p_hmac_hash ~ '^[0-9a-f]{64}$' THEN
    UPDATE api_keys
       SET key_hash = p_hmac_hash,
           key_hash_version = 2,
           key_hash_pepper_fp = p_pepper_fp
     WHERE id = k.k_id;
  END IF;

  -- last_used_at con throttle de 60s para no amplificar escrituras.
  IF k.k_last IS NULL OR k.k_last < now() - interval '60 seconds' THEN
    UPDATE api_keys SET last_used_at = now() WHERE id = k.k_id;
  END IF;

  RETURN QUERY SELECT k.t_id, k.k_id, k.k_scopes, k.k_env;
END;
$$;

REVOKE ALL ON FUNCTION authenticate_api_key(TEXT, TEXT, TEXT[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_api_key(TEXT, TEXT, TEXT[], TEXT) TO fluvia_app;
