# Multi-tenancy y RLS

Estado: Activo · Fase: 0 · ADR-0005 · Evidencia: tests de RLS del spike verdes contra PG16

## 1. Modelo de tenancy

`Organization` es el tenant de aislamiento (= `tenant_id` en RLS). `Merchant` es una subdivisión del tenant con autorización de aplicación (scopes/roles), no una frontera RLS separada en el MVP. Usuarios pertenecen a organizaciones vía `memberships` con rol.

## 2. Defensa en profundidad (V4 §14.1)

| Capa | Control |
|------|---------|
| 1. AuthN | El tenant se deriva SIEMPRE de identidad autenticada (API key hasheada o sesión), jamás de un `organization_id` del payload |
| 2. AuthZ aplicación | RBAC + scopes de API key por endpoint |
| 3. RLS Postgres | Políticas `USING`/`WITH CHECK` por `tenant_id`, `ENABLE` + `FORCE` en toda tabla tenant-scoped |
| 4. Constraints | Uniques compuestos con `tenant_id`; FKs |
| 5. Pruebas | Suite de tenant-escape en CI (lectura cruzada, escritura cruzada, PK directa, bypass de contexto) |
| 6. Auditoría | Acceso administrativo cross-tenant registrado con actor y razón |

## 3. Patrón de contexto (regla normativa)

```sql
BEGIN;
SELECT set_config('app.tenant_id', $tenant, true);  -- is_local => muere en COMMIT/ROLLBACK
-- ... trabajo ...
COMMIT;
```

- Prohibido `SET app.tenant_id` a nivel de sesión: una conexión de pool reutilizada filtraría el tenant anterior (fuga de contexto).
- Implementado como único punto de entrada `withTenantTransaction(pool, tenantId, fn)` (spike `packages/db/src/pool.ts`); el acceso a datos fuera de ese wrapper no ve filas.
- **Hallazgo empírico del spike (obligatorio en toda política):** tras revertirse un `set_config(..., local)` al terminar la transacción, `current_setting('app.tenant_id', true)` devuelve **cadena vacía, no NULL**, en esa misma sesión del pool; la política debe usar `NULLIF(current_setting(...), '')::uuid` — sin eso, la consulta sin contexto falla con error de cast (falla cerrado, pero rompe el request) en lugar de devolver 0 filas.
- **PgBouncer**: compatible con transaction pooling porque el contexto es transaction-scoped. Si algún día se usa session-state alguna otra variable, revisar. Documentar en despliegue.

## 4. Roles de base de datos

| Rol | RLS | Uso |
|-----|-----|-----|
| dueño/migraciones | bypass implícito (superuser en local; rol owner en cloud) | migraciones y seeding administrativo |
| `fluvia_app` | **forzado** | API de negocio; sin DELETE; **sin acceso a sessions/tokens/credenciales** |
| `fluvia_worker` | `BYPASSRLS` | relay de outbox/entrega de webhooks (procesa todos los tenants); sin DELETE |
| `fluvia_auth` | política `USING(true)` acotada al rol, solo sobre `users`/`sessions`/`email_verification_tokens` | módulo de autenticación del API (la autenticación es pre-tenant por naturaleza: el aislamiento aquí es por rol, no por fila); sin DELETE |

Bypass controlado: el panel admin NO usa `BYPASSRLS`; opera con un contexto explícito de tenant + permiso auditado, o mediante funciones `SECURITY DEFINER` acotadas (patrón ya validado con `authenticate_api_key`).

**Plano de plataforma vs plano de tenant (desde F1-03):** las operaciones que ocurren antes de que exista contexto de tenant (crear organización + owner) corren en el "plano de plataforma" con el pool administrativo — en cloud ese rol necesita `BYPASSRLS` o políticas propias, porque `FORCE RLS` somete incluso al owner de la tabla (solo el superusuario local lo bypasea siempre). Todo lo demás corre en el plano de tenant con `fluvia_app`.

**Tabla global `users`:** no tiene `tenant_id`. Política `user_visible_via_membership`: el rol app solo VE usuarios con una membresía activa en el tenant en contexto (la subconsulta a `memberships` ejecuta con la RLS del propio rol — sin recursión). Sin política de escritura: `INSERT/UPDATE` sobre `users` está denegado para `fluvia_app` por defecto (verificado por test); el camino de registro sancionado llega en F1-04.

## 5. Tablas globales y de plataforma

Tablas sin `tenant_id` (catálogos, `schema_migrations`, `platforms`): sin política de tenant, acceso solo lectura para `fluvia_app` cuando corresponda. Toda tabla nueva se clasifica en el PR: tenant-scoped (RLS obligatorio) o global (justificación).

## 6. Pruebas automatizadas (estado)

Ya verdes en el spike: visibilidad limitada al tenant propio, contexto ausente = 0 filas, `WITH CHECK` bloquea inserción cross-tenant, lectura por PK cruzada = 0 filas, `authenticate_api_key` resuelve sin contexto. Pendiente F1: suite de escape ampliada (UPDATE cruzado, joins, funciones), test de no-fuga de contexto entre requests consecutivos del pool, y bypass administrativo auditado.
