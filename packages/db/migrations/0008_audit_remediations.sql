-- ============================================================================
-- FLUVIA 0008_audit_remediations.sql  (Lote AUD-1 — Independent Audit v1)
--
-- AUD-P1-001: invariante de MOTOR — todo ledger_entry debe referenciar una
--             cuenta del MISMO tenant y MISMA moneda (FK compuesta).
-- AUD-P1-009: idempotency_keys aislada por endpoint (PK compuesta), como
--             especifica docs/architecture/idempotency.md.
-- AUD-P2-004 (parcial) / adelanto AUD-P1-007: el rol worker pierde TODO
--             privilegio sobre tablas del ledger y proyecciones — el relay
--             (F2-11) solo necesita outbox_events.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. AUD-P1-001 — coherencia cuenta-tenant-moneda a nivel de motor
-- ----------------------------------------------------------------------------
-- Validacion previa de datos existentes: si hubiera filas incoherentes la
-- migracion DEBE fallar ruidosamente, no enmascarar.
DO $$
DECLARE
  bad INT;
BEGIN
  SELECT count(*) INTO bad
  FROM ledger_entries e
  JOIN ledger_accounts a ON a.id = e.account_id
  WHERE a.tenant_id <> e.tenant_id OR a.currency <> e.currency;
  IF bad > 0 THEN
    RAISE EXCEPTION
      'FLUVIA_MIGRATION_BLOCKED: % ledger_entries rows violate account tenant/currency coherence',
      bad;
  END IF;
END;
$$;

ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_id_tenant_currency_key UNIQUE (id, tenant_id, currency);

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_account_coherence_fk
  FOREIGN KEY (account_id, tenant_id, currency)
  REFERENCES ledger_accounts (id, tenant_id, currency);

-- ----------------------------------------------------------------------------
-- 2. AUD-P1-009 — idempotencia aislada por endpoint
--    (tabla aun sin consumidores: cambio de PK seguro)
-- ----------------------------------------------------------------------------
ALTER TABLE idempotency_keys ADD COLUMN endpoint TEXT NOT NULL DEFAULT '';
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
ALTER TABLE idempotency_keys ADD PRIMARY KEY (tenant_id, endpoint, key);
ALTER TABLE idempotency_keys ALTER COLUMN endpoint DROP DEFAULT;

-- ----------------------------------------------------------------------------
-- 3. Reduccion de privilegios del worker (adelanto de AUD-P1-007;
--    el rediseno completo del rol llega con el relay en F2-11 + ADR-0011)
-- ----------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON ledger_accounts, ledger_transactions, ledger_entries,
  balance_projections, api_keys
  FROM fluvia_worker;
