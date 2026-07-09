-- ============================================================================
-- FLUVIA 0037_dispute_provider_ref.sql  (F4-08c — idempotencia de la apertura
-- de disputas por el webhook del banco)
--
-- El inbox (F2-12) es AT-LEAST-ONCE: el handler aplica su efecto y el marcado
-- del evento como procesado NO son atómicos, así que un `dispute.opened`
-- reprocesado tras un crash (o el banco reenviando con otro event_id) NO debe
-- DOBLE-abrir la disputa — eso sería un doble-hold de fondos (V4 Nivel A: jamás
-- un doble efecto de dinero). La referencia del banco (`provider_ref`) es la
-- clave natural de la disputa: única por (tenant, provider). Este índice es el
-- backstop DURO; `DisputeService.openFromProvider` es el camino rápido idempotente.
--
-- Parcial (WHERE provider_ref IS NOT NULL): las disputas abiertas por el motor
-- directamente (p. ej. tests, o sin referencia del banco) no se constriñen.
-- ============================================================================

CREATE UNIQUE INDEX disputes_provider_ref_uniq
  ON disputes (tenant_id, provider, provider_ref)
  WHERE provider_ref IS NOT NULL;
