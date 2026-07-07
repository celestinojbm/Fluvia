-- ============================================================================
-- 0040 — Step-up por re-autenticación de PASSWORD (F6, TM-02 del threat model).
--
-- Problema (threat model §5, TM-02): el guard de step-up era un NO-OP para
-- usuarios sin MFA — una sesión secuestrada podía acuñar/revocar API keys
-- (`keys:manage`) sin prueba fresca de presencia. Cierre: los usuarios SIN MFA
-- ahora deben re-autenticarse con su password (`/v1/auth/step-up/password`);
-- los usuarios CON MFA siguen exigiendo TOTP (el password NO sustituye al
-- factor fuerte).
--
-- `sessions.password_verified_at` espeja a `mfa_verified_at` (0014): marca de
-- la última re-autenticación por password de ESTA sesión. Columna separada a
-- propósito — en auditoría/forense jamás debe confundirse una verificación
-- TOTP con una de password.
--
-- Plano de auth: `fluvia_auth` ya tiene UPDATE sobre sessions (0004).
-- ============================================================================

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS password_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN sessions.password_verified_at IS
  'Última re-autenticación por password de esta sesión (step-up TM-02 para usuarios sin MFA). NO sustituye a mfa_verified_at cuando el usuario tiene MFA.';
