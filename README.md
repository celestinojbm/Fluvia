# Fluvia

Plataforma de infraestructura y orquestación de pagos de misión crítica, en construcción bajo el marco del **Prompt Maestro V4**.

> **Estado: Fase 2 — Núcleo contable (ledger) en sandbox.** Fase 0 (descubrimiento y decisiones) y Fase 1 (fundaciones: identidad, auth, API keys, RBAC, auditoría) están completas; el ledger de doble partida está operativo en sandbox local/CI. **Nada de lo aquí contenido es una capacidad productiva**: no hay dinero real, no hay proveedores conectados, no se emiten credenciales `live` (bloqueado por código hasta pasar los production gates). Fluvia no es banco, adquirente, emisor, custodio ni procesador certificado (ver `docs/compliance/production-gates.md`).

## Qué hay en este repositorio

| Ruta                     | Contenido                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`                  | Paquete de Fase 0 (PRD, arquitectura, threat model, ADRs, gates) + gobernanza viva (backlog, estado, riesgos, decisiones) + **auditorías** (`docs/audits/`)                                                                                                                   |
| `packages/money`         | Value Object `Money`: bigint en unidades menores, sin float, `allocate` sin pérdida                                                                                                                                                                                           |
| `packages/db`            | Migraciones (DDL + RLS forzado + inmutabilidad + invariantes del ledger a nivel de motor), runner, `withTenantTransaction`, roles por plano                                                                                                                                   |
| `packages/auth`          | Registro/login (scrypt versionado), sesiones, verificación de email, lockout, anti-enumeración, **MFA TOTP** (RFC 6238, secreto cifrado, backup codes) y step-up                                                                                                              |
| `packages/identity`      | Organizaciones, merchants, membresías, RBAC declarativo, API keys con scopes (solo `test`), customers con metadata validada (F3-05a)                                                                                                                                          |
| `packages/audit`         | Log de auditoría append-only con redacción de secretos y operaciones de plataforma con razón obligatoria                                                                                                                                                                      |
| `packages/ledger`        | Ledger de doble partida: postTransaction idempotente, proyecciones versionadas, Chart of Accounts cerrado, reglas de posting tipadas                                                                                                                                          |
| `packages/events`        | Envelope común de eventos (`event_id`, `schema_version`, `occurred_at`, `producer`, `resource`) con validación Zod                                                                                                                                                            |
| `packages/outbox`        | Relay del outbox: claim-lease con `SKIP LOCKED` multi-worker, backoff+jitter, DLQ y replay auditado (rol `fluvia_relay` de privilegio mínimo)                                                                                                                                 |
| `packages/inbox`         | Inbox durable de webhooks de proveedores: firma HMAC verificada pre-persistencia, dedup por motor, procesador claim-lease, DLQ redactada, replay auditado (rol `fluvia_inbox`)                                                                                                |
| `packages/idempotency`   | Capa de idempotencia API: claim en la misma transacción que el efecto, hash canónico, replay exacto, crash-safe (Gate Idempotencia)                                                                                                                                           |
| `packages/config`        | Configuración tipada de la aplicación                                                                                                                                                                                                                                         |
| `apps/api`               | API Fastify: health/readiness, auth, organizaciones, dos planos de seguridad (sesión+rol vs api-key+scope), taxonomía de errores v1 con contrato golden                                                                                                                       |
| `apps/worker`            | Proceso worker: heartbeat + outbox relay (fan-out a webhooks) + deliverer de webhooks salientes + procesador del inbox + watchdog de attempts (barrido/salud de indeterminados) + vigilancia de drift + purga auditada + `/health`+`/metrics` (9464)                          |
| `packages/observability` | Métricas en proceso (counter/gauge/histogram) con exposición Prometheus, guard de cardinalidad y agregados anónimos (F1-07)                                                                                                                                                   |
| `packages/seeds`         | Seeds deterministas de demo — `pnpm seed`, solo local/test, reproducible e idempotente (F1-10)                                                                                                                                                                                |
| `packages/payments-core` | FSMs declarativas de pagos (intent/attempt/refund) hechas cumplir EN el motor con meta-test doc↔TS↔DDL; `PaymentIntentService`, confirmación en dos fases con MockProvider + `ResilientProvider` (F3-01/03/04) y `RefundService` end-to-end con asiento compensatorio (F3-08) |
| `packages/webhooks`      | Webhooks salientes: catálogo de topics, firma versionada `v1=` con rotación dual, secretos cifrados en reposo, SSRF guard con pinning de IP, fan-out desde el outbox y deliverer claim-lease (rol `fluvia_webhook`, F3-07)                                                    |
| `scripts/`               | `verify-ledger-invariants.sql`: auditoría del ledger externa al ORM (CI, cron, post-restore)                                                                                                                                                                                  |
| `docker-compose.yml`     | Infra local: PostgreSQL 16 + Redis 7                                                                                                                                                                                                                                          |

## Ejecutar localmente

```bash
pnpm install
docker compose up -d postgres      # o un PostgreSQL 16 local en :5432
pnpm migrate                       # aplica packages/db/migrations (idempotente)
pnpm test                          # unit + integración real contra PostgreSQL (RLS, inmutabilidad, ledger)
pnpm seed                          # datos de demo deterministas (SOLO local/test; re-ejecutar no duplica)
```

Variables: `ADMIN_DATABASE_URL`, `APP_DATABASE_URL`, `WORKER_DATABASE_URL`, `RELAY_DATABASE_URL`, `INBOX_DATABASE_URL`, `AUTH_DATABASE_URL`. Los defaults locales solo aplican con `NODE_ENV`/`FLUVIA_ENV` local/test; en cualquier otro entorno el arranque falla si falta alguna (anti-mezcla de entornos).

## Gobernanza

- Trabajo: [`docs/agents/BACKLOG.md`](docs/agents/BACKLOG.md) · Estado: [`docs/agents/STATE.md`](docs/agents/STATE.md) · Decisiones: [`docs/agents/DECISIONS.md`](docs/agents/DECISIONS.md) · Riesgos: [`docs/agents/RISKS.md`](docs/agents/RISKS.md)
- Toda decisión arquitectónica pasa por ADR ([`docs/adr/`](docs/adr/)). Resueltas: PEND-001 (país inicial: Colombia), PEND-003 (Fase 0 aprobada). Abiertas al propietario humano: **PEND-002** (pricing), **PEND-004** (política de credenciales live), **PEND-006** (condiciones del sandbox compartido).
- Auditorías: [`docs/audits/independent-audit-v1/`](docs/audits/) (hallazgos inmutables) + plan de integración y registro de cierre con evidencia por hallazgo.
