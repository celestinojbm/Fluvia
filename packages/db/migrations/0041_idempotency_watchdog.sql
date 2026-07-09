-- ============================================================================
-- FLUVIA 0041_idempotency_watchdog.sql  (F6 — salud de la capa de idempotencia)
--
-- Threat model §5 (Idempotencia): filas `in_progress` huérfanas sin barrido ni
-- alerta. La capa de idempotencia (0008/0013) commitea el claim y el efecto en
-- UNA transacción, así que NUNCA deja un `in_progress` COMMITEADO — pero un
-- flujo multi-paso ajeno a esta capa (o un futuro bug) SÍ podría, y hoy eso
-- bloquearía esa (tenant, endpoint, key) con `processing_in_flight` hasta la
-- purga (24h) SIN que nadie lo vea.
--
-- Espeja sweep_disputes (0038): SOLO SURFACEA la salud (no transiciona nada —
-- un `in_progress` podría ser una operación externa legítimamente en vuelo;
-- borrarlo automáticamente arriesgaría doble ejecución). SECURITY DEFINER sin
-- parámetros (alcance imposible de ensanchar), EXECUTE solo para fluvia_worker
-- (cascarón sin privilegios de tabla — no puede SELECT `idempotency_keys` bajo
-- RLS; el definer cuenta cross-tenant por él).
--
-- Umbral (Nivel C; cambiarlo = migración nueva deliberada):
--   envejecido = `in_progress` con created_at > 1 hora (una request real
--   completa en segundos; lock_timeout es 3 s — un `in_progress` de más de una
--   hora es inequívocamente un huérfano o una operación externa atascada).
-- ============================================================================

-- Índice parcial: el barrido (cada intervalo) toca solo las filas vivas
-- `in_progress`, no la tabla entera (que puede tener millones de `completed`
-- hasta la purga) — sin él, cada conteo sería un seq scan completo.
-- NOTA DE DEPLOY: no-CONCURRENTLY (el runner envuelve cada migración en una
-- transacción, y CREATE INDEX CONCURRENTLY no corre en un bloque tx). El build
-- toma un ShareLock que bloquea INSERT/UPDATE de `idempotency_keys` durante el
-- scan; con la tabla pequeña (sandbox) es instantáneo, pero contra una tabla
-- grande en producción hay que aplicarlo en ventana de mantenimiento (o crear
-- el índice CONCURRENTLY fuera del runner). Mismo patrón que 0013.
CREATE INDEX IF NOT EXISTS idempotency_keys_in_progress_idx
  ON idempotency_keys (created_at)
  WHERE status = 'in_progress';

CREATE OR REPLACE FUNCTION sweep_idempotency_orphans()
RETURNS TABLE (metric TEXT, value BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_total BIGINT;
  n_aged BIGINT;
BEGIN
  -- Vivas `in_progress` (cross-tenant; el definer ve todas).
  SELECT count(*) INTO n_total
  FROM idempotency_keys
  WHERE status = 'in_progress';

  -- Envejecidas: `in_progress` más allá del umbral — huérfano o atasco.
  SELECT count(*) INTO n_aged
  FROM idempotency_keys
  WHERE status = 'in_progress'
    AND created_at < now() - interval '1 hour';

  RETURN QUERY VALUES
    ('in_progress_total', n_total),
    ('in_progress_aged', n_aged);
END;
$$;

REVOKE ALL ON FUNCTION sweep_idempotency_orphans() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_idempotency_orphans() TO fluvia_worker;
