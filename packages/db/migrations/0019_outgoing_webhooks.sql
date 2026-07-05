-- ============================================================================
-- FLUVIA 0019_outgoing_webhooks.sql  (F3-07 — webhooks salientes)
--
-- Espejo del contrato webhook-delivery.md:
--   webhook_endpoints  (url, secreto activo + anterior durante rotacion,
--                       eventos suscritos, estado)
--   webhook_events     (instancia a entregar; id publico whe_<uuid>)
--   webhook_attempts   (uno por intento: status HTTP, latencia, error, IP
--                       resuelta — registro del destino en cada intento, §4)
--
-- Origen EXCLUSIVO: el outbox. El relay hace fan-out (INSERT en
-- webhook_events); un rol dedicado de entrega procesa la cola. Patron
-- ADR-0011: cada rol ve exactamente lo que su trabajo exige, via politicas
-- RLS explicitas — jamas BYPASSRLS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Rol de entrega (guard AUD-P2-008 como 0002/0004/0009/0010)
-- ----------------------------------------------------------------------------
-- Redeclaracion IDENTICA a 0002 (CREATE OR REPLACE): las bases que aplicaron
-- 0002 antes de F1-09 no tienen la funcion; en bases frescas es un no-op.
CREATE OR REPLACE FUNCTION fluvia_assert_dev_role_creation(role_name TEXT)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(NULLIF(current_setting('fluvia.environment', true), ''), 'local')
     NOT IN ('local', 'test') THEN
    RAISE EXCEPTION
      'FLUVIA_CONFIG: role % does not exist and this is a non-local environment — provision it with managed credentials BEFORE migrating (AUD-P2-008); development passwords are forbidden outside local/test',
      role_name
      USING ERRCODE = 'raise_exception';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fluvia_webhook') THEN
    -- Password SOLO para desarrollo local (regimen R-12; guard AUD-P2-008).
    PERFORM fluvia_assert_dev_role_creation('fluvia_webhook');
    CREATE ROLE fluvia_webhook LOGIN PASSWORD 'fluvia_webhook_dev_password';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO fluvia_webhook;

-- ----------------------------------------------------------------------------
-- 2. Tablas
-- ----------------------------------------------------------------------------
CREATE TABLE webhook_endpoints (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES organizations(id),
  url                    TEXT NOT NULL,
  -- Secretos cifrados en reposo (AES-256-GCM, WEBHOOK_SECRET_ENC_KEY): un
  -- dump no permite forjar webhooks hacia los comercios.
  secret_enc             TEXT NOT NULL,
  prev_secret_enc        TEXT,
  prev_secret_expires_at TIMESTAMPTZ,
  -- Topics suscritos; '{}' = todos (catalogo en @fluvia/webhooks events.ts).
  events                 TEXT[] NOT NULL DEFAULT '{}',
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  description            TEXT,
  created_by_user_id     UUID REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at            TIMESTAMPTZ,
  UNIQUE (id, tenant_id)
);
CREATE INDEX webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id);

CREATE TABLE webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id),
  endpoint_id     UUID NOT NULL,
  topic           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by       TEXT,
  last_error      TEXT,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_events_endpoint_coherence_fk
    FOREIGN KEY (endpoint_id, tenant_id) REFERENCES webhook_endpoints (id, tenant_id)
);
CREATE INDEX webhook_events_claim_idx ON webhook_events (next_attempt_at, id)
  WHERE status = 'pending';
CREATE INDEX webhook_events_tenant_idx ON webhook_events (tenant_id, created_at);

CREATE TABLE webhook_attempts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES organizations(id),
  webhook_event_id UUID NOT NULL REFERENCES webhook_events(id),
  attempt_number   INT NOT NULL CHECK (attempt_number >= 1),
  status_code      INT,
  error            TEXT,
  latency_ms       INT,
  resolved_ip      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (webhook_event_id, attempt_number)
);
CREATE INDEX webhook_attempts_event_idx ON webhook_attempts (webhook_event_id);

-- Append-only / sin DELETE (clase auditable).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_endpoints', 'webhook_events', 'webhook_attempts']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_delete', t
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_truncate', t
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$CREATE POLICY tenant_isolation ON %I
           USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
           WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$,
      t
    );
  END LOOP;
END;
$$;
-- El historial de attempts lo escribe SOLO el deliverer.
REVOKE INSERT, UPDATE ON webhook_attempts FROM fluvia_app;
-- La cola la escribe el relay (fan-out) y la actualiza el deliverer.
REVOKE INSERT, UPDATE ON webhook_events FROM fluvia_app;

-- ----------------------------------------------------------------------------
-- 3. Ventanas del relay (fan-out) — cross-tenant explicito, ADR-0011
-- ----------------------------------------------------------------------------
GRANT SELECT (id, tenant_id, events, status) ON webhook_endpoints TO fluvia_relay;
GRANT INSERT (tenant_id, endpoint_id, topic, payload) ON webhook_events TO fluvia_relay;
CREATE POLICY relay_fanout_read ON webhook_endpoints FOR SELECT TO fluvia_relay USING (true);
CREATE POLICY relay_fanout_insert ON webhook_events FOR INSERT TO fluvia_relay WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- 4. Ventanas del deliverer — cross-tenant explicito, ADR-0011
-- ----------------------------------------------------------------------------
GRANT SELECT ON webhook_events TO fluvia_webhook;
GRANT UPDATE (status, attempts, next_attempt_at, locked_by, last_error, delivered_at)
  ON webhook_events TO fluvia_webhook;
GRANT SELECT (id, tenant_id, url, secret_enc, prev_secret_enc, prev_secret_expires_at, status)
  ON webhook_endpoints TO fluvia_webhook;
GRANT INSERT ON webhook_attempts TO fluvia_webhook;
-- ON CONFLICT exige SELECT sobre las columnas del arbitro (leccion F2-12) y
-- una politica SELECT bajo FORCE RLS para evaluar el conflicto.
GRANT SELECT (webhook_event_id, attempt_number) ON webhook_attempts TO fluvia_webhook;
-- La columna IDENTITY exige USAGE sobre su secuencia (los defaults de 0002 no
-- cubren secuencias nuevas).
GRANT USAGE ON SEQUENCE webhook_attempts_id_seq TO fluvia_webhook;
CREATE POLICY webhook_deliverer_events ON webhook_events
  FOR ALL TO fluvia_webhook USING (true) WITH CHECK (true);
CREATE POLICY webhook_deliverer_endpoints ON webhook_endpoints
  FOR SELECT TO fluvia_webhook USING (true);
CREATE POLICY webhook_deliverer_attempts ON webhook_attempts
  FOR INSERT TO fluvia_webhook WITH CHECK (true);
CREATE POLICY webhook_deliverer_attempts_read ON webhook_attempts
  FOR SELECT TO fluvia_webhook USING (true);
