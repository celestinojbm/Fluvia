-- ============================================================================
-- FLUVIA 0013_idempotency_expiry.sql  (F2-09 — capa de idempotencia API)
--
-- expires_at: retencion configurable exigida por idempotency.md §2 (Nivel C,
-- default 24 h en sandbox). La purga de filas expiradas es un JOB administrado
-- (F1-09, excepcion documentada al no-DELETE por clasificacion de datos
-- tecnicos); mientras una fila exista — expirada o no — se comporta igual:
-- el PK sigue deduplicando y un completed sigue replayando.
-- ============================================================================

ALTER TABLE idempotency_keys
  ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours');

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);
