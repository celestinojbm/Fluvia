-- ============================================================================
-- FLUVIA 0001_foundation.sql
-- DDL fundacional: tenants, auth, Ledger de doble partida, Outbox transaccional,
-- idempotencia, payment intents (FSM) y DLQ de payloads de proveedores.
--
-- Invariantes duras (Directivas V3):
--   * DELETE prohibido a nivel de base de datos en TODAS las tablas core
--     (triggers fluvia_forbid_mutation). Bajas logicas via deleted_at.
--   * ledger_entries y ledger_transactions son INMUTABLES (ni UPDATE ni DELETE).
--   * Los montos son BIGINT en unidades menores (nunca float / numeric ambiguo).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tenancy y autenticacion
-- ----------------------------------------------------------------------------
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  -- SHA-256 hex de la clave. La clave en claro jamas se persiste.
  key_hash    TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);

-- ----------------------------------------------------------------------------
-- Ledger de doble partida
-- ----------------------------------------------------------------------------
CREATE TABLE ledger_accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  name               TEXT NOT NULL,
  currency           CHAR(3) NOT NULL,
  -- Lado natural de la cuenta: un debito sobre cuenta 'debit' incrementa saldo.
  normal_side        TEXT NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  -- Rollups cacheados (unidades menores). La fuente de verdad es ledger_entries;
  -- estos valores se protegen con sequence_version (bloqueo optimista).
  balance_available  BIGINT NOT NULL DEFAULT 0,
  balance_pending    BIGINT NOT NULL DEFAULT 0,
  sequence_version   BIGINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  UNIQUE (tenant_id, name, currency)
);

CREATE INDEX ledger_accounts_tenant_idx ON ledger_accounts (tenant_id);

CREATE TABLE ledger_transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  idempotency_key  TEXT NOT NULL,
  reason           TEXT NOT NULL CHECK (
    reason IN ('payment', 'refund', 'fee', 'payout', 'transfer', 'adjustment')
  ),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- La idempotencia del asiento vive en la base de datos, no en Redis:
  -- sobrevive caidas de RAM y expiraciones de lock (correccion V3 a la V2).
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE ledger_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  tx_root_id  UUID NOT NULL REFERENCES ledger_transactions(id),
  account_id  UUID NOT NULL REFERENCES ledger_accounts(id),
  direction   TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  -- Siempre positivo: el signo lo determina direction + normal_side.
  amount      BIGINT NOT NULL CHECK (amount > 0),
  currency    CHAR(3) NOT NULL,
  bucket      TEXT NOT NULL DEFAULT 'available' CHECK (bucket IN ('available', 'pending')),
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, created_at);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (tx_root_id);
CREATE INDEX ledger_entries_tenant_idx ON ledger_entries (tenant_id);

-- ----------------------------------------------------------------------------
-- Transactional Outbox (Directiva A.1: prohibido llamar APIs externas dentro
-- de transacciones SQL; los eventos se escriben aqui en la MISMA transaccion
-- del cambio de negocio y un Relay Worker los publica asincronamente).
-- ----------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  topic            TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);

CREATE INDEX outbox_events_pending_idx
  ON outbox_events (next_attempt_at, id)
  WHERE status = 'pending';

-- ----------------------------------------------------------------------------
-- Idempotencia de la capa API (persistente, transaccional)
-- ----------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  key              TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_status  INT,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- ----------------------------------------------------------------------------
-- Payment Intents (Maquina de Estados Finita)
-- Las transiciones validas viven en apps/api/src/fsm.ts y estan documentadas
-- en docs/Product/Payment_State_Transitions.md (deben mapear exactamente).
-- ----------------------------------------------------------------------------
CREATE TABLE payment_intents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  amount        BIGINT NOT NULL CHECK (amount > 0),
  currency      CHAR(3) NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'requires_confirmation' CHECK (
    status IN ('requires_confirmation', 'processing', 'succeeded', 'failed', 'canceled')
  ),
  version       BIGINT NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  canceled_at   TIMESTAMPTZ,
  succeeded_at  TIMESTAMPTZ
);

CREATE INDEX payment_intents_tenant_idx ON payment_intents (tenant_id, created_at);

-- ----------------------------------------------------------------------------
-- DLQ de payloads crudos de proveedores (Directiva C: si la respuesta del
-- proveedor no calza con el schema Zod, se rechaza y se archiva aqui).
-- ----------------------------------------------------------------------------
CREATE TABLE raw_provider_payloads_dlq (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         UUID REFERENCES tenants(id),
  provider          TEXT NOT NULL,
  payload           JSONB NOT NULL,
  validation_error  TEXT NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Inmutabilidad y prohibicion de DELETE a nivel de motor
-- ----------------------------------------------------------------------------
CREATE FUNCTION fluvia_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FLUVIA_IMMUTABLE: % is forbidden on table % (soft-delete / append-only policy)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$;

-- DELETE prohibido en TODAS las tablas core.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants', 'api_keys', 'ledger_accounts', 'ledger_transactions',
    'ledger_entries', 'outbox_events', 'idempotency_keys',
    'payment_intents', 'raw_provider_payloads_dlq'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_delete', t
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_truncate', t
    );
  END LOOP;
END;
$$;

-- El Ledger es append-only: tampoco se permite UPDATE.
CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();

CREATE TRIGGER ledger_transactions_no_update
  BEFORE UPDATE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();

CREATE TRIGGER raw_provider_payloads_dlq_no_update
  BEFORE UPDATE ON raw_provider_payloads_dlq
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
