-- ============================================================================
-- FLUVIA 0045_security_review_hardening.sql  (F6 · revisión de seguridad interna)
--
-- Cierra dos hallazgos de la revisión adversarial multi-lente:
--
-- (1) MEDIUM — SECURITY DEFINER shadowables por `pg_temp`.
--     Los 21 procedimientos SECURITY DEFINER declaran `SET search_path = public`
--     y referencian sus tablas SIN calificar (p.ej. `authenticate_api_key` hace
--     `FROM api_keys ak JOIN organizations o …`). En PostgreSQL, cuando `pg_temp`
--     NO figura explícitamente en `search_path`, se busca IGUAL — y PRIMERO para
--     nombres de RELACIÓN y TIPO (solo funciones/operadores quedan exentos). Por
--     eso `SET search_path = public` NO neutraliza el esquema temporal: un actor
--     capaz de ejecutar SQL como `fluvia_app` (p.ej. un sink de inyección) podría
--     `CREATE TEMP TABLE api_keys(...); CREATE TEMP TABLE organizations(...)`
--     sembradas a gusto y llamar al definer, que resolvería esas tablas a las
--     temporales del llamador y devolvería un `(tenant_id, scopes)` ELEGIDO por el
--     atacante → toma de control cross-tenant. (Hoy NO es una escalada por encima
--     del límite de confianza de `fluvia_app` — que ya puede fijar `app.tenant_id`
--     y por eso el suite SQLi + el candado de parametrización mantienen fuera el
--     SQL arbitrario —, pero es una brecha sistémica sobre el ancla de auth.)
--
--     Fix de RAÍZ (una sola palanca, la más fuerte): quitar la primitiva. Ningún
--     código de Fluvia crea tablas temporales (verificado), así que se REVOCA
--     TEMPORARY sobre la base a PUBLIC → los roles de runtime (no-superusuario)
--     pierden la capacidad de crear objetos en `pg_temp`, y el shadowing se vuelve
--     IMPOSIBLE con independencia del `search_path` de cada función. El superusuario
--     de migraciones lo conserva (bypassa los checks). Un meta-test lo fija.
--
-- (2) INFO — asimetría de grants sobre `users`.
--     `users` se crea en 0003, DESPUÉS del `ALTER DEFAULT PRIVILEGES … GRANT
--     SELECT, INSERT, UPDATE … TO fluvia_app` de 0002, así que `fluvia_app` recibió
--     grants de escritura a nivel de TABLA sobre `users`. A diferencia de
--     `sessions`/`email_verification_tokens` (revocados explícitamente en 0004),
--     esos writes nunca se revocaron. Hoy los BLOQUEA la RLS forzada (no hay
--     política de escritura para `fluvia_app`), pero es una inconsistencia de
--     defensa en profundidad: se alinea con el trato del plano de credenciales.
-- ============================================================================

-- (1) Revoca la creación de objetos temporales a los roles de runtime → cierra el
-- vector de shadowing de `pg_temp` sobre TODO SECURITY DEFINER de una vez.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;

-- (2) Alinea `users` con el plano de credenciales: sin escritura a nivel de tabla
-- para app/worker (la RLS ya lo bloqueaba; esto añade el respaldo de privilegios).
REVOKE INSERT, UPDATE ON users FROM fluvia_app, fluvia_worker;
