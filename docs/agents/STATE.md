# STATE — Estado del proyecto

Última actualización: 2026-07-04 · Fase actual: **1 — Fundación (en curso)**

## Hitos

- **Fase 0 APROBADA por el propietario (2026-07-04)** — decisión #16. ADRs 0001–0010 aceptados.
- **País inicial: Colombia** (decisión #15, ex PEND-001). Implicaciones MVP: COP como moneda principal de sandbox; el MockProvider incluirá un método asíncrono tipo PSE; candidatos de proveedor para Fase 5: Wompi/PayU/dLocal/Mercado Pago. La matriz de jurisdicción queda por verificar con fuentes y revisión legal (bloquea solo Fase 5).
- **F1-01 y F1-02 completados** (apps + config + CI; primer run de CI verde en GitHub Actions).
- **F1-03 completado (2026-07-04)**: modelo de identidad/tenancy real — migración `0003_identity_tenancy.sql` (`tenants`→`organizations`, `users` global con política RLS por membresía compartida, `memberships` RBAC, `merchants` con defaults Colombia) + paquete `@fluvia/identity` (plano plataforma y plano tenant) con 15 tests de integración: aislamiento cross-tenant de merchants/orgs/users, rollback atómico de alta de organización, unicidad case-insensitive de email, escritura de `users` denegada al rol app, inmutabilidad de las tablas nuevas y `authenticate_api_key` verificada tras el rename. Suite total: 61/61.

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
| Auth (login/MFA/API keys con scopes), audit log, ledger service, outbox worker, API de pagos… | No construido (F1-04+) |

## Bloqueadores

1. PEND-002 (pricing) — bloquea solo el motor de fees (Fase 4).
2. F0-VER (verificación en vivo de licencias de referencias) — antes de adoptar código externo.
3. Confirmar que el workflow de CI corre verde en GitHub Actions (primera ejecución con este push); `pnpm audit` puede reportar advisories nuevos en cualquier momento — tratarlos según Gate Seguridad, no silenciarlos.

## Próximo incremento propuesto

**F1-04** — Auth completo: registro sancionado (plano plataforma), verificación de email, login con MFA TOTP, sesiones revocables, RBAC aplicado por endpoint y API keys con scopes. Es talla XL: se partirá en sub-entregas (a. password+sesiones, b. MFA+step-up, c. API keys con scopes+RBAC). En paralelo puede avanzar F1-06 (suite ampliada de tenant-escape) que solo depende de F1-03.
