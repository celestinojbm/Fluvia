-- ============================================================================
-- FLUVIA 0042_ledger_hash_chain.sql  (F6 — tamper-evidence del ledger)
--
-- Threat model §5 (Ledger): el append-only del ledger vive en TRIGGERS
-- (fluvia_forbid_mutation) y un superusuario puede saltarlos (DISABLE TRIGGER)
-- — el tier de confianza superior del §4. Esta migración añade TAMPER-EVIDENCE:
-- un hash-chain por CHECKPOINTS sobre `ledger_entries` (+ los campos de su
-- cabecera `ledger_transactions`) que hace DETECTABLE editar, borrar o
-- reordenar asientos ya sellados — incluso el encubrimiento "perfecto" que
-- borra una transacción balanceada completa y deja verdes los checks [1..6]
-- de `verify-ledger-invariants.sql`.
--
-- Diseño (por qué así):
--   · `seq` (identity) da el ORDEN TOTAL que el chain necesita (los ids son
--     UUID aleatorios — no ordenan). GENERATED ALWAYS: nadie lo elige.
--   · El sellado es LAZY por checkpoints (ningún trigger en el camino caliente
--     de postTransaction — cero contención nueva por asiento).
--   · DOS FASES con horizonte de txid: la fase 1 registra un CANDIDATO
--     (upto_seq = max(seq) visible, horizon_txid = pg_snapshot_xmax(now)); la
--     fase 2 (una corrida posterior) solo FINALIZA cuando
--     pg_snapshot_xmin(actual) >= horizon_txid — es decir, cuando TODA
--     transacción que estaba en vuelo al registrar el candidato terminó. Sin
--     esto, un INSERT concurrente con seq <= upto que commitea DESPUÉS de
--     sellar haría que la verificación recompute un segmento distinto → falso
--     positivo SEV-1. Con el horizonte, imposible por construcción (los seq
--     nuevos tras el candidato son > upto porque la secuencia ya avanzó).
--     Cinturón adicional: el candidato debe tener una edad mínima (default
--     60 s) que cubre la ventana microscópica nextval→txid dentro de un
--     INSERT en curso.
--   · La VERIFICACIÓN vive INLINE en scripts/verify-ledger-invariants.sql
--     (check [7]) — autocontenida, corre en CI por commit y sobre la copia del
--     restore drill. El test de dientes cruza AMBAS implementaciones (sella la
--     función de aquí, verifica el script): si sus canónicos derivan, rompe.
--
-- Límite HONESTO (documentado en threat-model §5): esto es tamper-EVIDENCE,
-- no tamper-prevention. Un superusuario que conozca el esquema puede recomputar
-- la cadena entera. El valor: corrupción accidental, tampering parcial, y la
-- base para anclaje EXTERNO (exportar chain_hash fuera de la BD) como
-- extensión futura. Tras un restore lógico a un cluster NUEVO, un candidato
-- pendiente trae un horizon_txid del cluster ORIGINAL (inalcanzable en el xid8
-- del nuevo, que arranca pequeño); la función lo detecta (horizon > xmax actual)
-- y lo evicta → el sellado se auto-sana en vez de quedar atascado para siempre.
--
-- NOTA DE DEPLOY: ADD COLUMN ... IDENTITY reescribe `ledger_entries` bajo
-- ACCESS EXCLUSIVE. Instantáneo en sandbox; contra una tabla grande en
-- producción, ventana de mantenimiento (mismo criterio que la nota de 0041).
-- ============================================================================

-- sha256 en SQL (digest). Contrib estándar; el runner de migraciones corre
-- como admin del cluster, y pg_dump/restore recrea la extensión en la copia.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Orden total de asientos. GENERATED ALWAYS: solo el motor lo asigna (un
-- INSERT normal no puede elegirlo; restaurar filas exactas exige OVERRIDING
-- SYSTEM VALUE — deliberadamente ruidoso).
ALTER TABLE ledger_entries ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX ledger_entries_seq_idx ON ledger_entries (seq);

-- Tabla de TRABAJO (fase 1): a lo sumo un candidato pendiente. NO es
-- append-only (el ciclo la consume); sin datos contables — solo coordenadas.
CREATE TABLE ledger_checkpoint_candidates (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upto_seq     BIGINT NOT NULL CHECK (upto_seq > 0),
  horizon_txid XID8   NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Checkpoints SELLADOS (fase 2): la cadena. Append-only como el ledger.
CREATE TABLE ledger_checkpoints (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upto_seq        BIGINT NOT NULL UNIQUE CHECK (upto_seq > 0),
  entry_count     BIGINT NOT NULL CHECK (entry_count >= 0),
  segment_hash    TEXT   NOT NULL,
  prev_chain_hash TEXT   NOT NULL,
  chain_hash      TEXT   NOT NULL,
  sealed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER ledger_checkpoints_no_update
  BEFORE UPDATE ON ledger_checkpoints
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER ledger_checkpoints_no_delete
  BEFORE DELETE ON ledger_checkpoints
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER ledger_checkpoints_no_truncate
  BEFORE TRUNCATE ON ledger_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- Mínimo privilegio: ningún rol de app toca estas tablas; el worker entra
-- SOLO por la función DEFINER; la verificación corre como admin (invariantes).
-- OJO: existe un ALTER DEFAULT PRIVILEGES que concede a `fluvia_app` sobre
-- toda tabla NUEVA — el REVOKE debe nombrar al rol, no solo a PUBLIC.
REVOKE ALL ON ledger_checkpoint_candidates FROM PUBLIC, fluvia_app;
REVOKE ALL ON ledger_checkpoints FROM PUBLIC, fluvia_app;

-- ----------------------------------------------------------------------------
-- Sellado en dos fases. El CANÓNICO de un asiento (jsonb_build_array — mismo
-- razonamiento que V2-R2: JSON escapa todo, imposible colisionar por
-- separadores; NULL se preserva como null JSON, distinto de '') incluye los
-- campos del asiento Y de su cabecera: una sola cadena cubre AMBAS tablas
-- (toda transacción tiene >= 1 asiento por el trigger nonempty). Timestamps
-- SIEMPRE via to_char AT TIME ZONE 'UTC' — el ::text de un timestamptz depende
-- del TimeZone de la sesión y daría falsos positivos entre entornos.
-- ESTE CANÓNICO ES CONTRATO: scripts/verify-ledger-invariants.sql [7] lo
-- duplica textualmente; cambiarlo = cambiar ambos + resellar (migración).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION seal_ledger_checkpoints(
  min_candidate_age INTERVAL DEFAULT '60 seconds'
)
RETURNS TABLE (metric TEXT, value BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  last_upto  BIGINT;
  last_chain TEXT;
  cand       RECORD;
  seg_count  BIGINT;
  seg_hash   TEXT;
  new_chain  TEXT;
  new_upto   BIGINT;
  max_seq    BIGINT;
  sealed_now BIGINT := 0;
BEGIN
  IF min_candidate_age < INTERVAL '0' THEN
    RAISE EXCEPTION 'min_candidate_age must be >= 0';
  END IF;

  -- Serializa selladores CONCURRENTES (advisory lock a nivel de tx). Sin él, dos
  -- workers bajo READ COMMITTED pueden leer una cabeza y un candidato que se
  -- CRUZAN a ambos lados del commit del otro y forjar un checkpoint con el
  -- prev_chain_hash del abuelo equivocado — un [7] roto PERMANENTE sobre una
  -- tabla append-only (hallazgo de la revisión adversarial; UNIQUE(upto_seq) no
  -- lo impide porque los upto difieren). El lock se libera al COMMIT del
  -- statement (el worker invoca la función como UNA sola query autocommit).
  PERFORM pg_advisory_xact_lock(4242000000042);

  SELECT c.upto_seq, c.chain_hash INTO last_upto, last_chain
  FROM ledger_checkpoints c ORDER BY c.upto_seq DESC LIMIT 1;
  IF NOT FOUND THEN
    last_upto := 0;
    last_chain := 'FLUVIA_CHAIN_GENESIS';
  END IF;

  SELECT * INTO cand
  FROM ledger_checkpoint_candidates ORDER BY id DESC LIMIT 1;

  IF FOUND THEN
    IF cand.upto_seq <= last_upto
       OR cand.horizon_txid > pg_snapshot_xmax(pg_current_snapshot()) THEN
      -- Candidato inservible: (a) su upto ya está sellado, o (b) su horizon_txid
      -- es INALCANZABLE en este cluster — su valor va por DELANTE del contador
      -- xid8 actual, imposible en el mismo cluster (allí el horizon fue un xmax
      -- PASADO, siempre <= el actual): señal inequívoca de un restore lógico a un
      -- cluster NUEVO (cuyo xid8 arranca pequeño). Se EVICTA y la fase 1 registra
      -- uno fresco con el horizonte de ESTE cluster → el sellado AUTO-SANA tras
      -- un DR (sin esto la cadena quedaba atascada para siempre, en silencio).
      DELETE FROM ledger_checkpoint_candidates WHERE id <= cand.id;
    ELSIF pg_snapshot_xmin(pg_current_snapshot()) >= cand.horizon_txid
          AND clock_timestamp() - cand.created_at >= min_candidate_age THEN
      -- Fase 2: toda tx en vuelo al registrar el candidato terminó → el
      -- segmento (last_upto, upto] es INMUTABLE de aquí en adelante.
      SELECT count(*),
             encode(digest(coalesce(string_agg(s.canon, ',' ORDER BY s.seq), ''), 'sha256'), 'hex')
      INTO seg_count, seg_hash
      FROM (
        SELECT e.seq,
               jsonb_build_array(
                 e.seq, e.id::text, e.tenant_id::text, e.tx_root_id::text,
                 e.account_id::text, e.direction, e.amount, e.currency::text,
                 e.bucket, e.reason,
                 to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
                 t.tenant_id::text,
                 t.idempotency_key, t.reason, t.source_type, t.source_id,
                 t.reverses_tx_id::text,
                 to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
               )::text AS canon
        FROM ledger_entries e
        JOIN ledger_transactions t ON t.id = e.tx_root_id
        WHERE e.seq > last_upto AND e.seq <= cand.upto_seq
      ) s;

      new_chain := encode(digest(
        last_chain || '|' || cand.upto_seq::text || '|' || seg_count::text || '|' || seg_hash,
        'sha256'), 'hex');

      INSERT INTO ledger_checkpoints (upto_seq, entry_count, segment_hash, prev_chain_hash, chain_hash)
      VALUES (cand.upto_seq, seg_count, seg_hash, last_chain, new_chain);

      DELETE FROM ledger_checkpoint_candidates WHERE id <= cand.id;
      last_upto := cand.upto_seq;
      sealed_now := 1;
    END IF;
  END IF;

  -- Fase 1: registrar el siguiente candidato (si hay asientos sin sellar y no
  -- quedó ninguno pendiente). created_at = clock_timestamp(), NO now() (que es el
  -- inicio de ESTA tx): la fase 2 hashea ANTES de este INSERT, así que now()
  -- dejaría el candidato "envejecido" por el tiempo de hasheo y erosionaría el
  -- cinturón min_candidate_age (el hasheo del backlog histórico completo puede
  -- durar segundos). El horizonte de txid sigue siendo la garantía PRIMARIA.
  IF NOT EXISTS (SELECT 1 FROM ledger_checkpoint_candidates) THEN
    SELECT max(e.seq) INTO new_upto FROM ledger_entries e;
    IF new_upto IS NOT NULL AND new_upto > last_upto THEN
      INSERT INTO ledger_checkpoint_candidates (upto_seq, horizon_txid, created_at)
      VALUES (new_upto, pg_snapshot_xmax(pg_current_snapshot()), clock_timestamp());
    END IF;
  END IF;

  SELECT coalesce(max(e.seq), 0) INTO max_seq FROM ledger_entries e;

  RETURN QUERY VALUES
    ('checkpoints_total', (SELECT count(*) FROM ledger_checkpoints)),
    ('sealed_upto_seq',   coalesce(last_upto, 0)),
    ('sealed_this_run',   sealed_now),
    ('candidate_upto_seq', coalesce((SELECT c.upto_seq FROM ledger_checkpoint_candidates c
                                     ORDER BY c.id DESC LIMIT 1), 0)),
    -- Rezago de detección: seq máximos aún NO cubiertos por la cadena. Un valor
    -- que NO decrece = sellador atascado o caído (su fallo es SILENCIOSO — los
    -- gauges se congelan, la alerta delta<0 no dispara); la alerta de
    -- estancamiento cuelga de aquí (observability §4, cierra el punto ciego).
    ('unsealed_seq',      greatest(coalesce(max_seq, 0) - coalesce(last_upto, 0), 0));
END;
$$;

REVOKE ALL ON FUNCTION seal_ledger_checkpoints(INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seal_ledger_checkpoints(INTERVAL) TO fluvia_worker;
