# STATE — Estado del proyecto

Última actualización: 2026-07-04 · Fase actual: **1 — Fundación (en curso)**

## Hitos

- **Fase 0 APROBADA por el propietario (2026-07-04)** — decisión #16. ADRs 0001–0010 aceptados.
- **País inicial: Colombia** (decisión #15, ex PEND-001). Implicaciones MVP: COP como moneda principal de sandbox; el MockProvider incluirá un método asíncrono tipo PSE; candidatos de proveedor para Fase 5: Wompi/PayU/dLocal/Mercado Pago. La matriz de jurisdicción queda por verificar con fuentes y revisión legal (bloquea solo Fase 5).
- **F1-01 y F1-02 completados** (apps + config + CI; primer run de CI verde en GitHub Actions).
- **F1-03 completado (2026-07-04)**: modelo de identidad/tenancy real — migración `0003_identity_tenancy.sql` (`tenants`→`organizations`, `users` global con política RLS por membresía compartida, `memberships` RBAC, `merchants` con defaults Colombia) + paquete `@fluvia/identity` (plano plataforma y plano tenant) con 15 tests de integración: aislamiento cross-tenant de merchants/orgs/users, rollback atómico de alta de organización, unicidad case-insensitive de email, escritura de `users` denegada al rol app, inmutabilidad de las tablas nuevas y `authenticate_api_key` verificada tras el rename. Suite total: 61/61.
- **F1-04a completado (2026-07-04)**: primera sub-entrega de auth — migración `0004_auth_sessions.sql` (sessions con hash SHA-256, tokens de verificación de un solo uso, lockout en users, rol dedicado `fluvia_auth` con acceso exclusivo al plano de credenciales y REVOKE a app/worker) + `@fluvia/auth` (scrypt versionado, login uniforme anti-enumeración con igualación de timing, lockout configurable, sesiones revocables, `auth_list_memberships`) + endpoints `/v1/auth/*` con mapeo estable de errores y ZodError→400. Bug real detectado y corregido por los tests: el contador de lockout se perdía en el ROLLBACK del propio error — ahora se commitea antes de lanzar. Suite total: **92/92** + smoke test HTTP del flujo completo (register→verify→login→session→bad-login→logout). Pendiente F1-04b (MFA TOTP + step-up).
- **F1-04c completado (2026-07-04)**: API keys con scopes y entorno test/live (migración 0005; secreto mostrado una única vez, solo hash+prefijo en BD, last_used_at con throttle) + RBAC declarativo (`packages/identity/src/rbac.ts`, matriz publicada en access-control.md y verificada celda a celda por test) + middleware de dos planos en el API (sesión+rol por organización para dashboard; API key+scope para integración; planos NO intercambiables) + primeros endpoints tenant-scoped reales: `/v1/organizations[...]` (org, members, merchants CRUD, api-keys) y `/v1/account`. Decisión de seguridad: no existe scope para gestionar API keys — una key robada no puede escalar. Suite total: **111/111** incl. tests BOLA (404 indistinguible), RBAC por rol y scopes.
- **F1-05 completado (2026-07-04)**: audit log append-only — migración `0006_audit_log.sql` (tabla inmutable por triggers Y por grants, RLS por plano: tenant para app, INSERT-only sin tenant para fluvia_auth) + `@fluvia/audit` (evento en la MISMA transacción que la acción, redacción recursiva de claves sensibles, lector paginado). Acciones auditadas: api_key.created/revoked (risk high), merchant.created/updated (con before/after), user.registered/email_verified, auth.login_succeeded/login_failed/account_locked/logout/sessions_revoked. Permiso nuevo `audit:read` (owner/admin/finance/analyst) + endpoint `GET /v1/organizations/:orgId/audit-events` con cursor. Suite total: **120/120**.
- **F1-06 completado (2026-07-04)** → **Gate Multi-tenant 🟢 técnico**: suite ampliada de tenant-escape (UPDATE por PK ajena, UPDATE masivo, INSERT…SELECT, JOINs, sondas EXISTS, agregados, fuga de contexto en la MISMA conexión del pool, SET ROLE denegado, worker sin DELETE) + **meta-tests estructurales** contra pg_catalog (toda tabla futura con tenant_id debe tener RLS forzado y política; ningún rol de runtime con DELETE; app/worker sin privilegios sobre credenciales) + `withPlatformOperation` como único bypass sancionado (razón obligatoria, auditoría atómica de riesgo alto, rollback conjunto). Límite residual documentado (SQL arbitrario ⇒ cambio de GUC) en multi-tenancy.md §6.5 y threat model. Suite total: **135/135**.

## Resumen ejecutivo

Fluvia es una capa de software y orquestación de pagos (no banco, no custodio, no procesador certificado). La Fase 0 entregó el paquete completo de decisión (auditoría del prompt, PRD, arquitectura, ledger, FSMs, estrategias, threat model, ADRs, backlog+DAG, gates) validado con un spike contra PostgreSQL 16 real. La Fase 1 arrancó con la plataforma mínima: apps `api`/`worker` con configuración tipada que falla rápido, y pipeline de CI completo con Postgres real, validación de migraciones, secret scanning, audit de dependencias y SBOM.

## Evidencia del incremento F1-01/F1-02 (formato §47, 2026-07-04)

```
pnpm lint            → OK (ESLint 9 flat config; no-explicit-any=error)
pnpm format:check    → OK (Prettier)
pnpm build           → 5/5 paquetes typecheck OK
pnpm test            → 46/46 PASS
                       config  6/6  (defaults, coerción, anti-mezcla de credenciales)
                       db      9/9  (RLS, inmutabilidad, authenticate_api_key — PG16 real)
                       money  20/20
                       api     7/7  (health, ready contra BD real, ready 503 con BD caída,
                                     correlation-id con sanitización, sobre de error 404)
                       worker  4/4  (checkReady rol worker, heartbeat, stop limpio, start idempotente)
Smoke test manual    → servidor arrancado: /health OK, /ready OK (BD real),
                       404 con sobre estable, x-request-id eco verificado
```

## Estado por componente

| Componente | Estado real |
|-----------|-------------|
| Documentación Fase 0 (30 entregables §52) | Completado y aprobado |
| `packages/money`, `packages/db` (spike) | Completado; promoción formal en F2-01/F1-03 |
| `packages/config` | **Completado** (F1-01) |
| `apps/api` esqueleto (health/ready, correlation, sobre de error) | **Completado** (F1-01) — sin recursos de negocio aún |
| `apps/worker` esqueleto (readiness, heartbeat, shutdown) | **Completado** (F1-01) — sin consumidores aún |
| CI (`.github/workflows/ci.yml`) | **Completado** (F1-02) — pendiente de verse verde en GitHub Actions en el primer push |
| `packages/identity` + migración 0003 (organizations/users/memberships/merchants) | **Completado** (F1-03) |
| `packages/auth` + migración 0004 + endpoints `/v1/auth/*` | **Completado F1-04a** (registro, verificación, login, lockout, sesiones) |
| RBAC + API keys + endpoints organizations/merchants/api-keys + /v1/account (F1-04c) | **Completado** |
| `packages/audit` + migración 0006 + endpoint de auditoría (F1-05) | **Completado** |
| Suite tenant-escape + meta-tests + bypass controlado (F1-06) | **Completado** — Gate Multi-tenant 🟢 técnico |
| MFA/step-up (F1-04b), observabilidad (F1-07), taxonomía errores (F1-08), purga (F1-09), seeds (F1-10), ledger service, outbox worker, API de pagos… | No construido |

## Bloqueadores

1. PEND-002 (pricing) — bloquea solo el motor de fees (Fase 4).
2. F0-VER (verificación en vivo de licencias de referencias) — antes de adoptar código externo.
3. Confirmar que el workflow de CI corre verde en GitHub Actions (primera ejecución con este push); `pnpm audit` puede reportar advisories nuevos en cualquier momento — tratarlos según Gate Seguridad, no silenciarlos.

## Próximo incremento propuesto

**Fase 2 — núcleo financiero, empezando por F2-01+F2-02** (modelo definitivo del ledger con enlace causal + constraint diferido de balanceo por moneda a nivel de base de datos). El Gate Multi-tenant técnico está en verde y la idempotencia/outbox (F2-09/F2-11) siguen en el camino crítico antes de exponer el API de pagos. Los pendientes de Fase 1 (F1-04b MFA, F1-07 observabilidad, F1-08 taxonomía, F1-09 purga, F1-10 seeds) son intercalables y no bloquean F2-01→F2-08.
