-- ============================================================================
-- FLUVIA — Verificacion EXTERNA de invariantes del ledger (F2-06, Gate Ledger
-- V4 §51, AUD-P2-012).
--
-- Proposito: auditar la base SIN pasar por el codigo de la aplicacion. Se
-- ejecuta con psql (CI tras la suite, cron en entornos vivos, y tras un
-- restore de backup — F4-06):
--
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-ledger-invariants.sql
--
-- El script es AUTOCONTENIDO (no depende de funciones creadas por
-- migraciones) para poder auditarse a si mismo y correr sobre una copia
-- restaurada. Cualquier violacion => EXCEPTION FLUVIA_INVARIANT_VIOLATION
-- con el detalle de todos los checks fallidos; exit code != 0 bajo
-- ON_ERROR_STOP. Sin violaciones => NOTICE FLUVIA_INVARIANTS_OK.
-- ============================================================================

DO $$
DECLARE
  bad BIGINT;
  problems TEXT := '';
BEGIN
  -- 1. Doble partida: cada (transaccion, moneda) suma cero.
  SELECT count(*) INTO bad FROM (
    SELECT tx_root_id, currency
    FROM ledger_entries
    GROUP BY tx_root_id, currency
    HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0
  ) unbalanced;
  IF bad > 0 THEN
    problems := problems || format(' [1] unbalanced (tx,currency) pairs: %s;', bad);
  END IF;

  -- 2. Montos estrictamente positivos (el signo vive en direction).
  SELECT count(*) INTO bad FROM ledger_entries WHERE amount <= 0;
  IF bad > 0 THEN
    problems := problems || format(' [2] non-positive entry amounts: %s;', bad);
  END IF;

  -- 3. Coherencia cuenta-tenant-moneda (redundante con la FK compuesta de
  --    0008: si esto falla, alguien elimino la constraint).
  SELECT count(*) INTO bad
  FROM ledger_entries e
  JOIN ledger_accounts a ON a.id = e.account_id
  WHERE a.tenant_id <> e.tenant_id OR a.currency <> e.currency;
  IF bad > 0 THEN
    problems := problems || format(' [3] entries violating account tenant/currency: %s;', bad);
  END IF;

  -- 4. Sin cabeceras huerfanas: toda transaccion tiene asientos.
  SELECT count(*) INTO bad
  FROM ledger_transactions t
  WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.tx_root_id = t.id);
  IF bad > 0 THEN
    problems := problems || format(' [4] transactions without entries: %s;', bad);
  END IF;

  -- 5. Reversiones bien formadas: reverses_tx_id apunta a una tx del MISMO tenant.
  SELECT count(*) INTO bad
  FROM ledger_transactions t
  JOIN ledger_transactions orig ON orig.id = t.reverses_tx_id
  WHERE t.reverses_tx_id IS NOT NULL AND orig.tenant_id <> t.tenant_id;
  IF bad > 0 THEN
    problems := problems || format(' [5] cross-tenant reversal links: %s;', bad);
  END IF;

  -- 6. Toda proyeccion EXISTENTE == recomputo desde asientos (por bucket,
  --    con normal_side). Una cuenta sin fila de proyeccion no es corrupcion
  --    silenciosa (getBalance falla visible; rebuild la materializa).
  -- V2-R4 (re-auditoria v2): el recomputo se mantiene en `numeric`. `SUM(bigint)`
  -- ya devuelve numeric (sin overflow), pero un `::bigint` explicito abortaria
  -- con "bigint out of range" en el borde; en numeric la comparacion contra la
  -- proyeccion (bigint) sigue siendo exacta y jamas lanza por un cast.
  WITH recomputed AS (
    SELECT e.account_id,
      COALESCE(SUM(CASE WHEN e.bucket = 'available'
        THEN CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END
        ELSE 0 END), 0)::numeric AS available,
      COALESCE(SUM(CASE WHEN e.bucket = 'pending'
        THEN CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END
        ELSE 0 END), 0)::numeric AS pending
    FROM ledger_entries e
    JOIN ledger_accounts a ON a.id = e.account_id
    GROUP BY e.account_id
  )
  SELECT count(*) INTO bad
  FROM balance_projections p
  LEFT JOIN recomputed r ON r.account_id = p.account_id
  WHERE p.available <> COALESCE(r.available, 0)
     OR p.pending <> COALESCE(r.pending, 0);
  IF bad > 0 THEN
    problems := problems || format(' [6] projection drift accounts: %s;', bad);
  END IF;

  -- 7. Hash-chain de tamper-evidence (F6, 0042): cada checkpoint SELLADO debe
  --    reproducir EXACTAMENTE su segmento (asientos con seq en (prev_upto,
  --    upto], canonico identico al de seal_ledger_checkpoints — CONTRATO:
  --    cambiar uno exige cambiar el otro) y encadenar al checkpoint anterior.
  --    Detecta lo que [1..6] no ven: editar/borrar/reordenar asientos ya
  --    sellados — incluso borrar una transaccion balanceada COMPLETA (que
  --    deja [1..6] verdes). Los asientos posteriores al ultimo checkpoint son
  --    el horizonte pendiente (los cubre el proximo sellado). Requiere
  --    pgcrypto (0042); con cero checkpoints el check pasa trivialmente.
  SELECT count(*) INTO bad
  FROM ledger_checkpoints c
  LEFT JOIN LATERAL (
    SELECT count(*) AS n,
           encode(digest(coalesce(string_agg(s.canon, ',' ORDER BY s.seq), ''), 'sha256'), 'hex') AS seg
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
      WHERE e.seq > coalesce(
              (SELECT max(p.upto_seq) FROM ledger_checkpoints p WHERE p.upto_seq < c.upto_seq), 0)
        AND e.seq <= c.upto_seq
    ) s
  ) r ON true
  WHERE r.n <> c.entry_count
     OR r.seg <> c.segment_hash
     OR c.prev_chain_hash <> coalesce(
          (SELECT p.chain_hash FROM ledger_checkpoints p
           WHERE p.upto_seq < c.upto_seq ORDER BY p.upto_seq DESC LIMIT 1),
          'FLUVIA_CHAIN_GENESIS')
     OR c.chain_hash <> encode(digest(
          c.prev_chain_hash || '|' || c.upto_seq::text || '|' || r.n::text || '|' || r.seg,
          'sha256'), 'hex');
  IF bad > 0 THEN
    problems := problems || format(' [7] hash-chain checkpoints broken (tampered/deleted sealed entries or checkpoints): %s;', bad);
  END IF;

  IF problems <> '' THEN
    RAISE EXCEPTION 'FLUVIA_INVARIANT_VIOLATION:%', problems;
  END IF;
  RAISE NOTICE 'FLUVIA_INVARIANTS_OK: all ledger invariants hold';
END;
$$;
