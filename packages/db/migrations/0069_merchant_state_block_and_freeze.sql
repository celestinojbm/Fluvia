-- ============================================================================
-- FLUVIA 0069_merchant_state_block_and_freeze.sql
--   (issue #92 — bloqueo de comercios del Gobierno de Venezuela/PDVSA hasta
--    dictamen; y cierre del hueco "un comercio congelado aún puede cobrar")
--
-- Contexto (docs de riesgo Venezuela, borrador §1): hasta que haya dictamen de
-- sanciones, NO se dan de alta como comercios entidades del Gobierno ni con
-- participación estatal (PDVSA incluida). La revisión de #104 confirmó además
-- que `merchants.status = 'frozen'` existía desde 0003 pero NADIE lo leía: un
-- comercio congelado seguía cobrando y recibiendo payouts, y fluvia_app podía
-- reescribir su propio `status` (UPDATE a nivel de tabla, 0002). Esta migración
-- hace que las tres piezas las cumpla el MOTOR, igual que las FSM (0017):
--
-- (1) Declaración de afiliación estatal: `merchants.state_affiliation`
--     ('none' | 'government' | 'state_owned'; NULL = comercio legado sin
--     declarar). La API la exige al crear; el motor rechaza el alta (SQLSTATE
--     FV452) si es 'government' o 'state_owned'.
-- (2) Lista de bloqueo de nombres (`merchant_name_denylist`), solo del plano de
--     plataforma: un alta o un renombrado cuyo nombre normalizado contiene un
--     patrón activo (por palabras completas) se rechaza con FV452. La
--     autodeclaración se puede mentir; la lista atrapa lo evidente (PDVSA).
-- (3) `frozen` se hace cumplir (SQLSTATE FV453): sin intents, attempts ni
--     payouts nuevos, y sin EMITIR (requested -> in_transit) payouts pedidos
--     antes de congelar. Igual que el kill switch (#91/#104), NO se corta lo que
--     ya está en vuelo ni los refunds (devolver es la salida ordenada).
-- (4) Columnas protegidas: los roles de runtime no pueden cambiar `status`,
--     `state_affiliation`, `country` ni `tenant_id` de un comercio. Congelar y
--     descongelar es plano de plataforma (pool admin + auditoría).
--
-- "Hasta dictamen": descongelar un comercio declarado estatal o cuyo nombre
-- está en la lista también falla (FV452). Levantar el bloqueo exige una
-- migración nueva: decisión explícita, no un flag operativo.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Normalización de nombres (comparación estable)
-- ----------------------------------------------------------------------------
-- minúsculas, sin tildes, todo lo no alfanumérico a un espacio, y las siglas
-- deletreadas se juntan ("P.D.V.S.A." -> "pdvsa"). Se incluyen las mayúsculas
-- acentuadas en el translate por si lower() corre en un locale C.
CREATE OR REPLACE FUNCTION fluvia_normalize_merchant_name(p_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(
        translate(
          lower(coalesce(p_name, '')),
          'áàäâãåéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
          'aaaaaaeeeeiiiiooooouuuuncaaaaaaeeeeiiiiooooouuuunc'
        ),
        '[^a-z0-9]+', ' ', 'g'
      ),
      '\m([a-z0-9]) (?=[a-z0-9]\M)', '\1', 'g'
    )
  )
$$;

-- ----------------------------------------------------------------------------
-- 2. Afiliación estatal declarada
-- ----------------------------------------------------------------------------
ALTER TABLE merchants
  ADD COLUMN state_affiliation TEXT
    CHECK (state_affiliation IN ('none', 'government', 'state_owned'));

COMMENT ON COLUMN merchants.state_affiliation IS
  '#92: none | government | state_owned (participación estatal >= 50 % o control). '
  'NULL = comercio legado sin declarar. government/state_owned no pueden estar activos hasta dictamen.';

-- ----------------------------------------------------------------------------
-- 3. Lista de bloqueo de nombres (plano de plataforma)
-- ----------------------------------------------------------------------------
CREATE TABLE merchant_name_denylist (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern       TEXT NOT NULL,
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 1000),
  -- NULL solo para las filas sembradas por esta migración.
  added_by      UUID,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at    TIMESTAMPTZ,
  retired_by    UUID,
  retire_reason TEXT,
  -- El guard compara contra el nombre NORMALIZADO: un patrón sin normalizar
  -- ('PDVSA', 'Petróleos') sería una entrada que no bloquea nada.
  CONSTRAINT merchant_name_denylist_pattern_normalized CHECK (
    length(pattern) BETWEEN 2 AND 120 AND pattern = fluvia_normalize_merchant_name(pattern)
  ),
  CONSTRAINT merchant_name_denylist_retire_coherent CHECK (
    (retired_at IS NULL AND retired_by IS NULL AND retire_reason IS NULL) OR
    (retired_at IS NOT NULL AND retired_by IS NOT NULL AND retire_reason IS NOT NULL
       AND length(btrim(retire_reason)) > 0 AND length(retire_reason) <= 1000)
  )
);

CREATE UNIQUE INDEX merchant_name_denylist_one_active
  ON merchant_name_denylist (pattern) WHERE retired_at IS NULL;

CREATE TRIGGER merchant_name_denylist_no_delete
  BEFORE DELETE ON merchant_name_denylist
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
CREATE TRIGGER merchant_name_denylist_no_truncate
  BEFORE TRUNCATE ON merchant_name_denylist
  FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation();

-- UPDATE: solo retirar, una vez, sin tocar lo que se añadió.
CREATE OR REPLACE FUNCTION fluvia_merchant_name_denylist_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: denylist entry % was already retired', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.pattern IS DISTINCT FROM OLD.pattern
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.added_by IS DISTINCT FROM OLD.added_by
     OR NEW.added_at IS DISTINCT FROM OLD.added_at THEN
    RAISE EXCEPTION 'FLUVIA_IMMUTABLE: denylist entry % can only be retired, not edited', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER merchant_name_denylist_update_guard
  BEFORE UPDATE ON merchant_name_denylist
  FOR EACH ROW EXECUTE FUNCTION fluvia_merchant_name_denylist_guard_update();

-- Ningún rol de runtime lee ni escribe la lista (0002 concede por defecto
-- SELECT/INSERT/UPDATE a fluvia_app y fluvia_worker sobre tablas nuevas).
REVOKE ALL ON merchant_name_denylist FROM PUBLIC;
REVOKE ALL ON merchant_name_denylist FROM fluvia_app, fluvia_worker, fluvia_relay, fluvia_inbox,
  fluvia_auth, fluvia_webhook;

-- Semilla mínima: lo que nombra el issue #92 y lo inequívocamente estatal.
-- Legal amplía o retira entradas por el CLI (`merchant-risk denylist-*`).
INSERT INTO merchant_name_denylist (pattern, reason) VALUES
  ('pdvsa', '#92: PDVSA (bloqueo hasta dictamen de sanciones, RIESGOS-VE §1)'),
  ('petroleos de venezuela', '#92: PDVSA (bloqueo hasta dictamen de sanciones, RIESGOS-VE §1)'),
  ('banco central de venezuela', '#92: Gobierno de Venezuela (E.O. 13884) hasta dictamen'),
  ('ministerio del poder popular', '#92: ministerios del Gobierno de Venezuela hasta dictamen');

-- ----------------------------------------------------------------------------
-- 4. Guard de alta/edición de comercios (el MOTOR decide)
-- ----------------------------------------------------------------------------
-- ¿El nombre contiene un patrón activo por palabras completas? 'pdvsa' atrapa
-- "PDVSA Gas" y "P.D.V.S.A." pero no "Xpdvsax".
CREATE OR REPLACE FUNCTION fluvia_merchant_name_denylisted(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM merchant_name_denylist d
    WHERE d.retired_at IS NULL
      AND (' ' || fluvia_normalize_merchant_name(p_name) || ' ') LIKE ('% ' || d.pattern || ' %')
  )
$$;

REVOKE EXECUTE ON FUNCTION fluvia_merchant_name_denylisted(TEXT) FROM PUBLIC;

-- SECURITY DEFINER porque consulta la lista (sin grants de runtime). El rol que
-- dispara la escritura se identifica por `session_user` (el login del pool):
-- dentro de un DEFINER `current_user` es el dueño de la función.
CREATE OR REPLACE FUNCTION fluvia_merchant_state_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_runtime BOOLEAN := session_user IN
    ('fluvia_app', 'fluvia_worker', 'fluvia_relay', 'fluvia_inbox', 'fluvia_auth', 'fluvia_webhook');
  v_check BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Congelar/descongelar, la afiliación declarada, el país (alcance del kill
    -- switch #91) y el tenant son del plano de plataforma: un comercio no puede
    -- descongelarse ni "mudarse" de país con su propio rol.
    IF v_runtime AND (
         NEW.status IS DISTINCT FROM OLD.status
      OR NEW.state_affiliation IS DISTINCT FROM OLD.state_affiliation
      OR NEW.country IS DISTINCT FROM OLD.country
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    ) THEN
      RAISE EXCEPTION 'FLUVIA_MERCHANT_PROTECTED: status, state_affiliation, country and tenant of merchant % are platform-managed', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Solo se evalúa cuando el comercio queda ACTIVO por un cambio relevante
    -- (descongelar, renombrar, re-declarar). Un comercio legado que ya
    -- coincide no se rompe por un UPDATE ajeno: se tría con `merchant-risk screen`.
    v_check := NEW.status = 'active' AND (
         NEW.status IS DISTINCT FROM OLD.status
      OR NEW.name IS DISTINCT FROM OLD.name
      OR NEW.state_affiliation IS DISTINCT FROM OLD.state_affiliation
    );
  ELSE
    v_check := TRUE;
  END IF;

  IF v_check THEN
    IF NEW.state_affiliation IN ('government', 'state_owned') THEN
      RAISE EXCEPTION 'FLUVIA_MERCHANT_ONBOARDING_BLOCKED: state-affiliated merchants cannot be active until the sanctions opinion (#92)'
        USING ERRCODE = 'FV452';
    END IF;
    IF fluvia_merchant_name_denylisted(NEW.name) THEN
      -- El patrón concreto NO viaja en el error (solo a la tabla de plataforma).
      RAISE EXCEPTION 'FLUVIA_MERCHANT_ONBOARDING_BLOCKED: merchant name matches the platform denylist (#92)'
        USING ERRCODE = 'FV452';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION fluvia_merchant_state_guard() FROM PUBLIC;

CREATE TRIGGER merchants_state_guard
  BEFORE INSERT OR UPDATE ON merchants
  FOR EACH ROW EXECUTE FUNCTION fluvia_merchant_state_guard();

-- ----------------------------------------------------------------------------
-- 5. `frozen` se hace cumplir en el movimiento de dinero
-- ----------------------------------------------------------------------------
-- DEFINER: lee merchants sin depender de la RLS del llamador. Falla CERRADO si
-- el comercio no es visible: un control de cumplimiento no se salta por un
-- contexto de tenant mal fijado (en cloud el dueño necesita BYPASSRLS, ver
-- docs/architecture/multi-tenancy.md).
CREATE OR REPLACE FUNCTION fluvia_assert_merchant_active(p_merchant_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT m.status INTO v_status FROM merchants m WHERE m.id = p_merchant_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'FLUVIA_MERCHANT_FROZEN: merchant % is not active', p_merchant_id
      USING ERRCODE = 'FV453';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION fluvia_assert_merchant_active(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION fluvia_frozen_intent_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM fluvia_assert_merchant_active(NEW.merchant_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fluvia_frozen_attempt_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_merchant UUID;
BEGIN
  SELECT i.merchant_id INTO v_merchant FROM payment_intents i WHERE i.id = NEW.intent_id;
  PERFORM fluvia_assert_merchant_active(v_merchant);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fluvia_frozen_payout_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- INSERT: payout nuevo. UPDATE: solo la EMISIÓN (requested -> in_transit),
  -- el paso previo a contactar al banco. Resolver lo que ya está en tránsito o
  -- fallar un requested sigue libre (hechos del banco / fondos que vuelven).
  IF TG_OP = 'INSERT'
     OR (OLD.status = 'requested' AND NEW.status = 'in_transit') THEN
    PERFORM fluvia_assert_merchant_active(NEW.merchant_id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION fluvia_frozen_intent_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fluvia_frozen_attempt_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fluvia_frozen_payout_guard() FROM PUBLIC;

CREATE TRIGGER payment_intents_merchant_frozen
  BEFORE INSERT ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION fluvia_frozen_intent_guard();

CREATE TRIGGER payment_attempts_merchant_frozen
  BEFORE INSERT ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION fluvia_frozen_attempt_guard();

CREATE TRIGGER payouts_merchant_frozen
  BEFORE INSERT OR UPDATE OF status ON payouts
  FOR EACH ROW EXECUTE FUNCTION fluvia_frozen_payout_guard();
