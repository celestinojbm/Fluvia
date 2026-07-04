-- ============================================================================
-- FLUVIA 0009_outbox_relay_role.sql  (F2-11 + cierre de AUD-P1-007; ADR-0011)
--
-- 1. fluvia_relay: rol DEDICADO del outbox relay, privilegio minimo:
--      - SIN BYPASSRLS. La visibilidad cross-tenant se declara con politicas
--        RLS explicitas SOLO sobre outbox_events (auditables en pg_policy).
--      - SELECT sobre outbox_events + UPDATE restringido POR COLUMNA a los
--        campos de despacho. No puede tocar payload/topic/tenant_id, ni
--        insertar, ni borrar, ni ver ninguna otra tabla.
-- 2. fluvia_worker queda como cascaron de proceso (solo conectar/SELECT 1):
--      - pierde BYPASSRLS (hallazgo AUD-P1-007),
--      - pierde TODOS los privilegios restantes y los default privileges
--        que 0002 le regalaba sobre tablas futuras.
-- ============================================================================

ALTER TABLE outbox_events ADD COLUMN locked_by TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fluvia_relay') THEN
    -- Password SOLO para desarrollo local (mismo regimen R-12 que 0002;
    -- aprovisionamiento gestionado fuera de local llega con F1-09).
    CREATE ROLE fluvia_relay LOGIN PASSWORD 'fluvia_relay_dev_password';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO fluvia_relay;
GRANT SELECT ON outbox_events TO fluvia_relay;
GRANT UPDATE (status, attempts, next_attempt_at, locked_by, delivered_at, last_error)
  ON outbox_events TO fluvia_relay;

-- Visibilidad cross-tenant EXPLICITA y acotada a esta tabla (sin BYPASSRLS):
CREATE POLICY outbox_relay_read ON outbox_events
  FOR SELECT TO fluvia_relay USING (true);
CREATE POLICY outbox_relay_update ON outbox_events
  FOR UPDATE TO fluvia_relay USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- Cierre de AUD-P1-007: fluvia_worker sin BYPASSRLS y sin privilegios.
-- ----------------------------------------------------------------------------
ALTER ROLE fluvia_worker NOBYPASSRLS;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM fluvia_worker;
REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public FROM fluvia_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE ON TABLES FROM fluvia_worker;
