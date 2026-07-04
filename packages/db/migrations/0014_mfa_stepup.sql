-- ============================================================================
-- FLUVIA 0014_mfa_stepup.sql  (F1-04b — MFA TOTP + step-up; AUD-P1-006)
--
-- Decision PEND-005 (propietario, opcion b 2026-07-04): TOTP RFC 6238 +
-- codigos de respaldo de un solo uso; SMS excluido.
--
--  - El secreto TOTP se guarda CIFRADO (AES-256-GCM con clave de entorno
--    MFA_SECRET_KEY; regimen R-12 para el default local). Los codigos de
--    respaldo se guardan solo como sha256.
--  - mfa_challenges: reto post-password/pre-sesion (token sha256, TTL corto).
--    El reto se consume SOLO al verificar con exito; los fallos cuentan al
--    lockout del usuario.
--  - sessions.mfa_verified_at: base del STEP-UP — acciones sensibles
--    (keys:manage) exigen verificacion MFA reciente cuando el usuario la
--    tiene habilitada.
--  - Plano auth exclusivo (mismo patron 0004): solo fluvia_auth ve estas
--    tablas; RLS FORCE con politica por rol; sin DELETE (purga: F1-09).
-- ============================================================================

ALTER TABLE users
  ADD COLUMN totp_secret_enc TEXT,
  ADD COLUMN totp_pending_secret_enc TEXT,
  ADD COLUMN totp_enabled_at TIMESTAMPTZ,
  ADD COLUMN totp_last_used_step BIGINT NOT NULL DEFAULT 0;

ALTER TABLE sessions
  ADD COLUMN mfa_verified_at TIMESTAMPTZ;

CREATE TABLE mfa_challenges (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mfa_backup_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['mfa_challenges', 'mfa_backup_codes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY auth_plane_access ON %I FOR ALL TO fluvia_auth USING (true) WITH CHECK (true)',
      t
    );
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

GRANT SELECT, INSERT, UPDATE ON mfa_challenges, mfa_backup_codes TO fluvia_auth;
