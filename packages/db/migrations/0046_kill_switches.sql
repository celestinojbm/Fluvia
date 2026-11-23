-- ============================================================================
-- FLUVIA 0046_kill_switches.sql  (issue #91 — kill switch por país o contraparte)
--
-- Interruptor operativo para CORTAR el movimiento de dinero nuevo por:
--   * country  — país del comercio (ISO 3166-1 alfa-2 de merchants.country);
--   * merchant — un comercio concreto (contraparte);
--   * provider — un proveedor/socio/banco (payment_attempts.provider, payouts.provider).
--
-- Motivación (docs de riesgo Venezuela, borrador): las licencias generales de
-- OFAC se enmiendan o revocan con poca antelación y un socio puede hacer
-- de-risking de un día para otro. El corte tiene que ser inmediato, atómico y
-- no depender de que cada servicio recuerde comprobarlo: por eso lo hace
-- cumplir el MOTOR, igual que las FSM (0017) y la inmutabilidad del ledger.
--
-- Qué corta (BEFORE INSERT, SQLSTATE dedicado FV451):
--   * payment_intents  — no nacen cobros nuevos (API key, dashboard, payment links);
--   * payment_attempts — no se envían intentos nuevos al proveedor (confirmar);
--   * payouts          — no sale dinero hacia el comercio.
-- Qué NO corta, a propósito:
--   * la resolución de lo que YA está en vuelo (webhooks, conciliación, watchdog):
--     son hechos ocurridos en el proveedor y el ledger debe reflejarlos;
--   * refunds: devolver el dinero al pagador es la salida ordenada del corte.
--     Si un dictamen exige congelar también devoluciones, se añade en otra
--     migración (decisión explícita, no efecto colateral).
--
-- Gobierno:
--   * NINGÚN rol de runtime tiene privilegios sobre kill_switches. Activar y
--     liberar solo es posible por el plano de plataforma (pool admin) con
--     razón obligatoria y auditoría atómica (`withPlatformOperation`).
--   * Filas jamás se borran; liberar es un UPDATE único que fija released_*.
--     El historial completo queda en la tabla y en audit_events.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tabla
-- ----------------------------------------------------------------------------
CREATE TABLE kill_switches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope          TEXT NOT NULL CHECK (scope IN ('country', 'merchant', 'provider')),
  target         TEXT NOT NULL,
  reason         TEXT NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 1000),
  -- Operador: id (uuid) del usuario de plataforma, igual que audit_events.actor_id.
  engaged_by     UUID NOT NULL,
  engaged_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at    TIMESTAMPTZ,
  released_by    UUID,
  release_reason TEXT,
  -- Formato del objetivo por alcance: el guard compara por igualdad exacta, así
  -- que un 'co' o un uuid en mayúsculas sería un interruptor que no corta nada.
  CONSTRAINT kill_switches_target_format CHECK (
    (scope = 'country'  AND target ~ '^[A-Z]{2}$') OR
    (scope = 'merchant' AND target ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') OR
    (scope = 'provider' AND target ~ '^[a-z0-9][a-z0-9_.-]{0,63}$')
  ),
  -- Liberar exige SIEMPRE su propia razón; las dos columnas van juntas.
  CONSTRAINT kill_switches_release_coherent CHECK (
    (released_at IS NULL AND release_reason IS NULL AND released_by IS NULL) OR
    (released_at IS NOT NULL AND release_reason IS NOT NULL AND released_by IS NOT NULL
       AND length(btrim(release_reason)) > 0 AND length(release_reason) <= 1000)
  )
);

-- Como máximo UN interruptor activo por (scope, target): activar dos veces es
-- un no-op del servicio, no dos filas. También es el índice del guard.
CREATE UNIQUE INDEX kill_switches_one_active
  ON kill_switches (scope, target) WHERE released_at IS NULL;

-- Sin borrado ni truncado: el historial de cortes es evidencia regulatoria.
CREATE TRIGGER kill_switches_no_delete
  BEFORE DELETE ON kill_switches
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER kill_switches_no_truncate
  BEFORE TRUNCATE ON kill_switches
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- UPDATE: solo la liberación, una sola vez, sin tocar lo que se activó.
CREATE OR REPLACE FUNCTION fluvia_kill_switch_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: kill switch % was already released', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.target IS DISTINCT FROM OLD.target
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.engaged_by IS DISTINCT FROM OLD.engaged_by
     OR NEW.engaged_at IS DISTINCT FROM OLD.engaged_at THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: kill switch % can only be released, not edited', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kill_switches_update_guard
  BEFORE UPDATE ON kill_switches
  FOR EACH ROW EXECUTE FUNCTION fluvia_kill_switch_guard_update();

-- Ningún rol de runtime lee ni escribe la tabla (0002 concede por defecto
-- SELECT/INSERT/UPDATE a fluvia_app sobre tablas nuevas: se revoca).
REVOKE ALL ON kill_switches FROM PUBLIC;
REVOKE ALL ON kill_switches FROM fluvia_app, fluvia_worker, fluvia_relay, fluvia_inbox,
  fluvia_auth, fluvia_webhook;

-- ----------------------------------------------------------------------------
-- 2. Guard (el MOTOR decide, no el servicio)
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER: evalúa los interruptores (que el rol de runtime no puede
-- ver) y el país del comercio sin depender de la RLS del llamador. No se expone
-- como función invocable: solo la llaman los triggers de abajo (también
-- DEFINER), y se revoca EXECUTE a PUBLIC.
CREATE OR REPLACE FUNCTION fluvia_assert_flow_allowed(p_merchant_id UUID, p_provider TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_country TEXT;
  v_hit     RECORD;
BEGIN
  SELECT upper(btrim(m.country::text)) INTO v_country FROM merchants m WHERE m.id = p_merchant_id;

  SELECT k.id, k.scope, k.target INTO v_hit
  FROM kill_switches k
  WHERE k.released_at IS NULL
    AND (
      (k.scope = 'country'  AND v_country IS NOT NULL AND k.target = v_country) OR
      (k.scope = 'merchant' AND k.target = p_merchant_id::text) OR
      (k.scope = 'provider' AND p_provider IS NOT NULL AND k.target = p_provider)
    )
  ORDER BY k.engaged_at, k.id
  LIMIT 1;

  IF FOUND THEN
    -- El mensaje va solo a logs (la API responde el texto público del catálogo).
    -- La razón del corte NO se incluye: puede ser sensible (p. ej. sanciones).
    RAISE EXCEPTION 'FLUVIA_FLOW_SUSPENDED: % % is suspended (kill switch %)',
      v_hit.scope, v_hit.target, v_hit.id
      USING ERRCODE = 'FV451';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION fluvia_assert_flow_allowed(UUID, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION fluvia_kill_switch_intent_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM fluvia_assert_flow_allowed(NEW.merchant_id, NULL);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fluvia_kill_switch_attempt_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_merchant UUID;
BEGIN
  SELECT i.merchant_id INTO v_merchant FROM payment_intents i WHERE i.id = NEW.intent_id;
  PERFORM fluvia_assert_flow_allowed(v_merchant, NEW.provider);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fluvia_kill_switch_payout_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM fluvia_assert_flow_allowed(NEW.merchant_id, NEW.provider);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION fluvia_kill_switch_intent_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fluvia_kill_switch_attempt_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fluvia_kill_switch_payout_guard() FROM PUBLIC;

CREATE TRIGGER payment_intents_kill_switch
  BEFORE INSERT ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION fluvia_kill_switch_intent_guard();

CREATE TRIGGER payment_attempts_kill_switch
  BEFORE INSERT ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION fluvia_kill_switch_attempt_guard();

CREATE TRIGGER payouts_kill_switch
  BEFORE INSERT ON payouts
  FOR EACH ROW EXECUTE FUNCTION fluvia_kill_switch_payout_guard();
