-- ============================================================================
-- FLUVIA 0043_ledger_chain_anchor.sql  (F6 — anclaje EXTERNO del chain_hash)
--
-- Threat model §5 (Ledger): el hash-chain de tamper-evidence (0042) hace
-- DETECTABLE editar, borrar o reordenar asientos YA SELLADOS (check [7] de
-- verify-ledger-invariants.sql). Pero tiene un LÍMITE HONESTO documentado: [7]
-- solo recorre los checkpoints que EXISTEN, así que borrar la cadena ENTERA o
-- TRUNCAR su sufijo deja [7] verde TRIVIALMENTE (menos/cero checkpoints que
-- verificar, y los que queden siguen encadenando entre sí). Hoy ese hueco solo
-- lo cubre el gauge `unsealed_seq` que "deja de decrecer" — una señal blanda que
-- también dispara con un sellador simplemente atascado.
--
-- Esta migración añade ANCLAJE: un registro append-only del TIP de la cadena
-- (`upto_seq`, `chain_hash`) en una tabla SEPARADA de los checkpoints. La
-- verificación [8] compara cada anchor contra la cadena VIVA: si el checkpoint
-- de ese `upto_seq` desapareció (truncado/borrado) o su `chain_hash` difiere
-- (cadena re-sellada/forjada), [8] ROMPE — justo lo que [7] no ve. Un atacante
-- que quiera ocultar un tampering ahora debe manipular DOS almacenes append-only
-- independientes (los checkpoints Y los anchors) en vez de uno.
--
-- ¿DÓNDE anclar? (verificado primero, V4 Nivel A — no declarar capacidad
-- simulada): NO hay infraestructura externa en el sandbox (ni objeto/KMS/log
-- remoto append-only). Construir un sumidero "externo" falso simularía una
-- capacidad inexistente. El realizable-y-probable HOY es un almacén append-only
-- DENTRO de la BD pero FUERA del subsistema de la cadena:
--   (a) tabla dedicada `ledger_chain_anchors` (esta migración) — consultable,
--       exportable, y sobrevive pg_dump/restore (como los checkpoints), y
--   (b) un evento de auditoría `ledger.chain_anchored` en `audit_events` (otro
--       almacén append-only, tres capas de inmutabilidad) — que fluye por el
--       MISMO canal de exportación de auditoría que el operador ya archiva.
-- La pata TRULY-offsite (un archivo/objeto que el operador guarde fuera del
-- cluster) es responsabilidad del OPERADOR: el `LedgerChainAnchorer` del worker
-- LOGUEA el tip anclado (artefacto exportable) y el evento de auditoría viaja
-- offsite con el resto. Límite honesto documentado en threat-model §5: un
-- superusuario que manipule los TRES almacenes a la vez sigue siendo indetectable
-- sin una copia offsite del anchor — pero el hueco común (truncar/borrar la
-- cadena) queda cerrado.
--
-- Mínimo privilegio: como 0042, ningún rol de app toca la tabla; el worker entra
-- SOLO por la función DEFINER; la verificación [8] corre como admin.
-- ============================================================================

-- Anchors SELLADOS del tip de la cadena. Append-only como los checkpoints y el
-- ledger. Sin datos contables — solo el fingerprint criptográfico del tip.
CREATE TABLE ledger_chain_anchors (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- El tip anclado: `upto_seq` es UNIQUE porque el `chain_hash` de un `upto_seq`
  -- es determinista e inmutable (la cadena es append-only) — anclar el mismo tip
  -- dos veces es un no-op, no un duplicado.
  upto_seq      BIGINT NOT NULL UNIQUE CHECK (upto_seq > 0),
  chain_hash    TEXT   NOT NULL,
  checkpoint_id BIGINT NOT NULL,
  entry_count   BIGINT NOT NULL CHECK (entry_count >= 0),
  anchored_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER ledger_chain_anchors_no_update
  BEFORE UPDATE ON ledger_chain_anchors
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER ledger_chain_anchors_no_delete
  BEFORE DELETE ON ledger_chain_anchors
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER ledger_chain_anchors_no_truncate
  BEFORE TRUNCATE ON ledger_chain_anchors
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- Mínimo privilegio (mismo criterio que 0042): el ALTER DEFAULT PRIVILEGES
-- concede a `fluvia_app` sobre toda tabla NUEVA — el REVOKE debe nombrar al rol,
-- no solo a PUBLIC. El worker NO recibe privilegio de tabla (default privileges
-- solo tocan a fluvia_app): entra por la función DEFINER, como en el sellado.
REVOKE ALL ON ledger_chain_anchors FROM PUBLIC, fluvia_app;

-- ----------------------------------------------------------------------------
-- Publicación del tip. Idempotente y monótona: solo registra un anchor cuando la
-- cadena AVANZÓ más allá del último anclado (el `upto_seq` UNIQUE lo respalda).
-- El worker la invoca en un intervalo (LedgerChainAnchorer); es cross-tenant a
-- nivel plataforma (la cadena cubre TODOS los tenants por `seq`).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION anchor_ledger_chain()
RETURNS TABLE (metric TEXT, value BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tip_upto   BIGINT;
  tip_hash   TEXT;
  tip_cpid   BIGINT;
  tip_count  BIGINT;
  last_upto  BIGINT;
  anchored   BIGINT := 0;
BEGIN
  -- Serializa anchoradores CONCURRENTES a nivel de tx (mismo criterio que el
  -- sellado): sin él, dos workers podrían leer el mismo tip y chocar contra el
  -- UNIQUE(upto_seq) — inofensivo, pero el lock evita el error y el ruido. Se
  -- libera al COMMIT (el worker invoca la función como una query autocommit).
  PERFORM pg_advisory_xact_lock(4242000000043);

  -- Tip de la cadena VIVA: el checkpoint sellado de mayor `upto_seq`.
  SELECT c.upto_seq, c.chain_hash, c.id, c.entry_count
  INTO tip_upto, tip_hash, tip_cpid, tip_count
  FROM ledger_checkpoints c ORDER BY c.upto_seq DESC LIMIT 1;

  SELECT max(a.upto_seq) INTO last_upto FROM ledger_chain_anchors a;

  -- Ancla SOLO si hay tip y avanzó (monótono; re-anclar el mismo tip = no-op,
  -- sin ruido append-only — mismo criterio que la purga que solo audita efectos).
  IF tip_upto IS NOT NULL AND (last_upto IS NULL OR tip_upto > last_upto) THEN
    INSERT INTO ledger_chain_anchors (upto_seq, chain_hash, checkpoint_id, entry_count)
    VALUES (tip_upto, tip_hash, tip_cpid, tip_count);

    -- Segundo almacén append-only + canal de exportación offsite del operador.
    -- tenant_id NULL (hecho de plataforma, cross-tenant); actor 'system'.
    INSERT INTO audit_events
      (actor_type, auth_method, action, resource_type, resource_id, risk_level, reason, after_summary)
    VALUES
      ('system', 'platform', 'ledger.chain_anchored', 'ledger_chain', tip_upto::text, 'low',
       'external anchor of the ledger hash-chain tip (F6): append-only record outside the chain tables; lets check [8] detect truncation/deletion of the chain UP TO this tip (which leaves [7] trivially green); the still-unanchored horizon above it is covered by the anchor-lag alert',
       jsonb_build_object(
         'upto_seq', tip_upto, 'chain_hash', tip_hash,
         'checkpoint_id', tip_cpid, 'entry_count', tip_count));
    anchored := 1;
  END IF;

  -- NOTA (revisión adversarial): NO se expone un `anchor_gap` propio. El
  -- anchorador ancla el tip ACTUAL en la MISMA llamada, así que su rezago
  -- auto-reportado es SIEMPRE 0 (una métrica inerte no puede alertar de su propia
  -- caída). El estancamiento del anchorador se detecta CRUZANDO gauges: el
  -- `sealed_upto_seq` del SELLADOR sigue creciendo aunque el anchorador esté caído
  -- ⇒ `fluvia_ledger_chain_sealed_upto_seq - fluvia_ledger_chain_anchored_upto_seq`
  -- crece (alerta en observability §4). Aquí solo el estado observable del anclaje.
  RETURN QUERY VALUES
    ('anchors_total',     (SELECT count(*) FROM ledger_chain_anchors)),
    ('anchored_upto_seq', coalesce((SELECT max(a.upto_seq) FROM ledger_chain_anchors a), 0)),
    ('anchored_this_run', anchored);
END;
$$;

REVOKE ALL ON FUNCTION anchor_ledger_chain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION anchor_ledger_chain() TO fluvia_worker;
