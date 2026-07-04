# ADR-0005 — RLS forzado con contexto transaction-scoped (SET LOCAL)

Estado: Aceptado · Fase 0

## Contexto
El aislamiento multi-tenant no puede depender solo de la aplicación (V4 §14); los pools de conexiones reutilizan sesiones y pueden fugar contexto.

## Decisión
1. Toda tabla tenant-scoped: `ENABLE` + `FORCE ROW LEVEL SECURITY` con política `USING/WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)`.
2. El contexto SOLO se establece con `set_config('app.tenant_id', $1, true)` (transaction-local) dentro de `withTenantTransaction`; prohibido `SET` de sesión.
3. Roles: `fluvia_app` (RLS forzado, sin DELETE), `fluvia_worker` (BYPASSRLS para colas cross-tenant, sin DELETE), owner solo migraciones. Lookups pre-contexto (auth) vía funciones `SECURITY DEFINER` acotadas con `search_path` fijo.

## Alternativas
Schema-per-tenant (rechazado: explosión operativa de migraciones); base-por-tenant (rechazado: costo y complejidad prematuros); solo autorización en aplicación (rechazado: viola defensa en profundidad, Nivel A).

## Consecuencias
+ Un bug de aplicación no expone datos cross-tenant; compatible con PgBouncer transaction pooling. − Toda consulta de app debe pasar por el wrapper (costo de disciplina, se refuerza con lint/review); cuidado con planes que involucren funciones no-RLS-aware.

## Evidencia
Tests del spike contra PG16: visibilidad aislada, contexto ausente = 0 filas, WITH CHECK bloquea cross-tenant, PK directa cruzada invisible, `authenticate_api_key` funciona sin contexto.
