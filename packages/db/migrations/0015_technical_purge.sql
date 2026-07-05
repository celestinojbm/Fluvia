-- ============================================================================
-- FLUVIA 0015_technical_purge.sql  (F1-09 — purga por clasificación de datos)
--
-- Excepción CONTROLADA al no-DELETE (decisión #14, data-classification.md):
-- SOLO la clase "técnico" es purgable, SOLO vía la función auditada de abajo.
--
-- Diseño:
--   * Las clases financieras/auditables conservan fluvia_forbid_mutation()
--     intacto: ledger, outbox, audit_events, provider_events, api_keys, etc.
--     siguen siendo imborrables incluso para el superusuario por vías normales.
--   * Las 4 tablas técnicas purgables cambian su trigger de DELETE a
--     fluvia_forbid_mutation_technical(): bloquea igual, salvo cuando la
--     transacción actual está dentro de purge_technical_data() (GUC local
--     fluvia.technical_purge — muere con la transacción; TRUNCATE sigue
--     prohibido siempre).
--   * purge_technical_data() es SECURITY DEFINER (misma familia que
--     authenticate_api_key / ledger_projection_drift: ventana estrecha en
--     lugar de privilegios amplios), con predicados FIJOS — sin parámetros
--     que permitan ensanchar el alcance — y auditoría atómica en la misma
--     transacción. EXECUTE solo para fluvia_worker.
--
-- Retenciones (Nivel C, cambiarlas = nueva migración deliberada):
--   idempotency_keys          -> expires_at vencido (24 h desde 0013)
--   sessions                  -> 7 días tras expirar o ser revocada
--   email_verification_tokens -> 7 días tras expirar o consumirse
--   mfa_challenges            -> 1 día tras expirar (consumido o no)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Guard de mutación para la clase técnica
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fluvia_forbid_mutation_technical()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('fluvia.technical_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'FLUVIA_IMMUTABLE: % is forbidden on table % (technical class: only the audited purge job may DELETE — F1-09)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'idempotency_keys', 'sessions', 'email_verification_tokens', 'mfa_challenges'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %I', t || '_no_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation_technical()',
      t || '_no_delete', t
    );
    -- El trigger de TRUNCATE original (sin escape) se conserva.
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. La única puerta de purga (definer, predicados fijos, auditoría atómica)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_technical_data()
RETURNS TABLE (class TEXT, purged BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_idem BIGINT;
  n_sess BIGINT;
  n_tok  BIGINT;
  n_chal BIGINT;
BEGIN
  -- Escape transaccional: muere con la transacción (SET LOCAL semantics).
  PERFORM set_config('fluvia.technical_purge', 'on', true);

  DELETE FROM idempotency_keys WHERE expires_at < now();
  GET DIAGNOSTICS n_idem = ROW_COUNT;

  DELETE FROM sessions
  WHERE expires_at < now() - interval '7 days'
     OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days');
  GET DIAGNOSTICS n_sess = ROW_COUNT;

  DELETE FROM email_verification_tokens
  WHERE expires_at < now() - interval '7 days'
     OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days');
  GET DIAGNOSTICS n_tok = ROW_COUNT;

  DELETE FROM mfa_challenges WHERE expires_at < now() - interval '1 day';
  GET DIAGNOSTICS n_chal = ROW_COUNT;

  PERFORM set_config('fluvia.technical_purge', '', true);

  -- Auditoría EN LA MISMA transacción que el efecto (V4 §36). Solo se audita
  -- una purga efectiva: un no-op no borra nada y no genera ruido append-only.
  IF n_idem + n_sess + n_tok + n_chal > 0 THEN
    INSERT INTO audit_events
      (actor_type, auth_method, action, resource_type, risk_level, reason, after_summary)
    VALUES
      ('system', 'platform', 'platform.technical_purge', 'database', 'medium',
       'scheduled technical-data purge (F1-09, data-classification policy)',
       jsonb_build_object(
         'idempotency_keys', n_idem,
         'sessions', n_sess,
         'email_verification_tokens', n_tok,
         'mfa_challenges', n_chal
       ));
  END IF;

  RETURN QUERY VALUES
    ('idempotency_keys', n_idem),
    ('sessions', n_sess),
    ('email_verification_tokens', n_tok),
    ('mfa_challenges', n_chal);
END;
$$;

REVOKE ALL ON FUNCTION purge_technical_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_technical_data() TO fluvia_worker;
