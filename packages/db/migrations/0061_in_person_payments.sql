-- ============================================================================
-- FLUVIA 0061_in_person_payments.sql  (jornada restaurantes y cobro presencial)
--
-- COBRO PRESENCIAL (Tap to Pay en el teléfono del cobrador, o lector externo)
-- sobre ventas y pagos EXISTENTES: cada cobro presencial apunta a un payment
-- link de cobro único (una venta POS, una fracción de cuenta o un importe del
-- independiente) y usa su intent/attempt — mismo ledger, fees, liquidación y
-- devoluciones. No hay backend ni contabilidad paralelos.
--
-- Estados del cobro presencial:
--   device_incompatible · preparing · ready · waiting_card · processing
--   approved · declined · canceled · uncertain
-- El cliente (app) solo puede avanzar los estados de PREPARACIÓN y cancelar
-- antes de procesar. approved / declined / uncertain los fija el SERVIDOR a
-- partir del intent y su attempt, resueltos por el proveedor (respuesta
-- síncrona o webhook firmado vía inbox). Una animación o un callback del
-- cliente nunca aprueban.
--
-- Idempotencia: (tenant_id, client_key) único — un reintento del teléfono
-- devuelve el MISMO cobro, no crea otro. El índice único de 0046 impide dos
-- cobros de la misma venta.
--
-- Fluvia NO guarda PAN ni CVV: la lectura de la tarjeta la hace el SDK
-- certificado del proveedor; aquí solo hay referencias.
-- ============================================================================

CREATE TABLE in_person_devices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  platform    TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'other')),
  model       TEXT CHECK (model IS NULL OR char_length(model) <= 80),
  os_version  TEXT CHECK (os_version IS NULL OR char_length(os_version) <= 40),
  nfc         BOOLEAN,
  -- Veredicto de compatibilidad del SERVIDOR (no lo decide la app).
  capability  TEXT NOT NULL CHECK (capability IN ('compatible', 'incompatible', 'unknown')),
  reasons     TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE in_person_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id),
  merchant_id     UUID NOT NULL,
  payment_link_id UUID NOT NULL,
  intent_id       UUID,
  attempt_id      UUID,
  device_id       UUID,
  -- `simulator`: terminal de SANDBOX explícito (solo local/test). Queda
  -- registrado como tal: nunca se confunde con una lectura NFC real.
  method          TEXT NOT NULL CHECK (method IN ('tap_to_pay', 'external_reader', 'simulator')),
  provider        TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  state           TEXT NOT NULL CHECK (state IN (
                    'device_incompatible', 'preparing', 'ready', 'waiting_card',
                    'processing', 'approved', 'declined', 'canceled', 'uncertain')),
  amount          BIGINT NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
  currency        CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  concept         TEXT CHECK (concept IS NULL OR char_length(concept) <= 80),
  client_key      TEXT NOT NULL CHECK (char_length(client_key) BETWEEN 8 AND 80),
  failure_code    TEXT CHECK (failure_code IS NULL OR char_length(failure_code) <= 60),
  version         INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, client_key),
  FOREIGN KEY (merchant_id, tenant_id) REFERENCES merchants (id, tenant_id),
  FOREIGN KEY (payment_link_id, tenant_id) REFERENCES payment_links (id, tenant_id),
  FOREIGN KEY (intent_id, tenant_id) REFERENCES payment_intents (id, tenant_id),
  FOREIGN KEY (device_id, tenant_id) REFERENCES in_person_devices (id, tenant_id)
);
CREATE INDEX in_person_payments_link_idx ON in_person_payments (payment_link_id, created_at DESC);

-- Transiciones permitidas (el MOTOR valida; el servicio decide quién).
CREATE OR REPLACE FUNCTION fluvia_in_person_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok BOOLEAN;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  ok := CASE OLD.state
    WHEN 'device_incompatible' THEN false
    WHEN 'preparing'    THEN NEW.state IN ('ready', 'device_incompatible', 'canceled')
    WHEN 'ready'        THEN NEW.state IN ('waiting_card', 'canceled')
    WHEN 'waiting_card' THEN NEW.state IN ('processing', 'canceled', 'approved', 'declined', 'uncertain')
    WHEN 'processing'   THEN NEW.state IN ('approved', 'declined', 'uncertain')
    WHEN 'uncertain'    THEN NEW.state IN ('approved', 'declined')
    ELSE false  -- approved, declined, canceled: terminales
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FLUVIA_INVALID_TRANSITION: in-person payment % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.payment_link_id IS DISTINCT FROM OLD.payment_link_id
     OR (OLD.intent_id IS NOT NULL AND NEW.intent_id IS DISTINCT FROM OLD.intent_id) THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: in-person payment amount and binding cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER in_person_payments_transition
  BEFORE UPDATE ON in_person_payments
  FOR EACH ROW EXECUTE FUNCTION fluvia_in_person_transition();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['in_person_devices', 'in_person_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_delete', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO fluvia_app', t);
  END LOOP;
END $$;
