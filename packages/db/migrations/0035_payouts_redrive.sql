-- ============================================================================
-- FLUVIA 0035_payouts_redrive.sql  (F4-07e — re-drive seguro de `requested` atascados)
--
-- Un payout que se queda en `requested` mas alla del lease significa que su
-- `execute` (fase 2, fire-and-forget del plano HTTP) NUNCA corrio: el proceso
-- murio tras crear la fila pero antes de emitir. Consecuencia clave: el asiento
-- de emision NO existe y el banco JAMAS fue contactado. Por eso re-ejecutar es
-- SEGURO POR DISENO — no puede doble-pagar (el emit es idempotente por su key y
-- el banco nunca vio una primera peticion porque no la hubo). F4-07c ya SURFACEA
-- estos payouts (`requested_stuck`); aqui los re-conducimos.
--
-- Esta funcion RECLAMA (no ejecuta: la fase 2 llama al proveedor, imposible en
-- SQL) los `requested` atascados y toma un LEASE tocando `updated_at` sin
-- cambiar `status`. El lease + `FOR UPDATE SKIP LOCKED` SERIALIZAN el re-drive:
-- dos workers jamas conducen el mismo payout a la vez — lo unico que podria
-- doble-contactar al banco, ya que tras el `emit` (idempotente) ambos llamarian
-- a `submitPayout`. El job TS (PayoutsRedriver) invoca PayoutService.execute por
-- cada fila reclamada; un re-drive que cae deja el payout en `requested` con el
-- lease vencido, y otra corrida lo reintenta (at-least-once acotado por lease).
--
-- Umbrales (Nivel C; identicos a sweep_payouts / 0034):
--   atascado: created_at > 5 min  (la fase 2 tarda milisegundos; 5 min excede
--             cualquier execute legitimo en vuelo — sin carrera con la API).
--   lease:    updated_at > 5 min  (un re-drive que cae reintenta al vencer).
--
-- Misma familia de definers que sweep_payouts()/sweep_payment_attempts():
-- SECURITY DEFINER, alcance imposible de ensanchar (solo un tope de lote),
-- auditoria atomica del claim, EXECUTE solo para fluvia_worker (sin privilegios
-- de tabla). El indice parcial payouts_requested_idx (0034) sirve el claim.
-- ============================================================================

CREATE OR REPLACE FUNCTION claim_stuck_payouts(max_batch INT DEFAULT 20)
RETURNS TABLE (id UUID, tenant_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed_ids UUID[];
BEGIN
  -- Claim atomico en un statement: candidatos bajo lock (SKIP LOCKED serializa
  -- claimers simultaneos) -> UPDATE que toma el lease (updated_at = now(), el
  -- status sigue `requested`). now() es constante en el statement, asi que la
  -- fila leaseada deja de cumplir el predicado del lease de inmediato.
  WITH candidate AS (
    SELECT p.id
    FROM payouts p
    WHERE p.status = 'requested'
      AND p.created_at < now() - interval '5 minutes'   -- atascado: execute nunca corrio
      AND p.updated_at < now() - interval '5 minutes'   -- lease libre
    ORDER BY p.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(max_batch, 0)
  ),
  leased AS (
    UPDATE payouts p
    SET updated_at = now()
    FROM candidate c
    WHERE p.id = c.id
    RETURNING p.id, p.tenant_id
  )
  SELECT array_agg(l.id) INTO claimed_ids FROM leased l;

  -- Auditoria EN la misma transaccion, solo cuando hubo claim. El desenlace de
  -- cada re-drive (paid/failed/indeterminate) lo audita el propio execute.
  IF claimed_ids IS NOT NULL THEN
    INSERT INTO audit_events
      (actor_type, auth_method, action, resource_type, risk_level, reason, after_summary)
    VALUES
      ('system', 'platform', 'payout.redrive_claimed', 'payout', 'medium',
       'stuck-requested re-drive (F4-07e): execute never ran (no emit, bank never contacted), re-executing under lease',
       jsonb_build_object('claimed', array_length(claimed_ids, 1), 'payout_ids', claimed_ids));
  END IF;

  RETURN QUERY
    SELECT p.id, p.tenant_id FROM payouts p WHERE p.id = ANY(claimed_ids);
END;
$$;

REVOKE ALL ON FUNCTION claim_stuck_payouts(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_stuck_payouts(INT) TO fluvia_worker;
