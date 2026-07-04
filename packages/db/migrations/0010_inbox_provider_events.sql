-- ============================================================================
-- FLUVIA 0010_inbox_provider_events.sql  (F2-12 — inbox durable; AUD-P1-005)
--
-- provider_events: buzon durable de webhooks entrantes de proveedores.
--  - Dedup a nivel de motor: UNIQUE (provider, provider_event_id).
--  - SIN tenant_id: el evento llega ANTES de conocer el tenant; la atribucion
--    ocurre al procesar, en los efectos de dominio (F3). Por eso no aplica la
--    politica estandar de RLS por tenant; el aislamiento es por GRANTS minimos.
--  - append-only para DELETE/TRUNCATE; el UPDATE de despacho es por columna.
--
-- Roles (mismo patron ADR-0011 que el relay):
--  - fluvia_app (ingesta, endpoint de webhooks en F3): SOLO INSERT (+ SELECT
--    de la columna id para RETURNING). No puede leer ni alterar el buzon.
--  - fluvia_inbox (procesador): SELECT + UPDATE por columna de los campos de
--    despacho + INSERT en la DLQ (politica RLS explicita: la DLQ tiene FORCE
--    RLS y el payload invalido llega sin tenant conocido).
-- ============================================================================

CREATE TABLE provider_events (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider           TEXT NOT NULL,
  provider_event_id  TEXT NOT NULL,
  event_type         TEXT,
  raw_body           TEXT NOT NULL,
  headers            JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processed', 'ignored', 'dead')),
  result             TEXT,
  attempts           INT NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by          TEXT,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  last_error         TEXT,
  CONSTRAINT provider_events_dedup UNIQUE (provider, provider_event_id)
);

CREATE INDEX provider_events_pending_idx
  ON provider_events (next_attempt_at, id)
  WHERE status = 'pending';

CREATE TRIGGER provider_events_no_delete
  BEFORE DELETE ON provider_events
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER provider_events_no_truncate
  BEFORE TRUNCATE ON provider_events
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- Los default privileges de 0002 regalarian SELECT/INSERT/UPDATE a fluvia_app
-- sobre esta tabla nueva; se revoca y se otorga SOLO lo minimo.
-- Nota: ON CONFLICT exige SELECT sobre las columnas del arbitro (el indice de
-- dedup); id se necesita para RETURNING. Nada mas es legible por la API.
REVOKE ALL PRIVILEGES ON provider_events FROM fluvia_app, fluvia_worker;
GRANT INSERT ON provider_events TO fluvia_app;
GRANT SELECT (id, provider, provider_event_id) ON provider_events TO fluvia_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fluvia_inbox') THEN
    -- Password SOLO para desarrollo local (regimen R-12, igual que 0002/0009).
    CREATE ROLE fluvia_inbox LOGIN PASSWORD 'fluvia_inbox_dev_password';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO fluvia_inbox;
GRANT SELECT ON provider_events TO fluvia_inbox;
GRANT UPDATE (status, result, attempts, next_attempt_at, locked_by, processed_at, last_error)
  ON provider_events TO fluvia_inbox;

-- DLQ de payloads invalidos: INSERT con politica explicita (tenant desconocido
-- en ese punto; la tabla tiene FORCE RLS con politica por tenant desde 0002).
GRANT INSERT ON raw_provider_payloads_dlq TO fluvia_inbox;
CREATE POLICY dlq_inbox_write ON raw_provider_payloads_dlq
  FOR INSERT TO fluvia_inbox WITH CHECK (true);
