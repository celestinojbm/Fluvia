# STATE — Estado del proyecto

Última actualización: 2026-07-04 · Fase actual: **0 — Descubrimiento y decisiones (entregada, pendiente de aprobación humana PEND-003)**

## Resumen ejecutivo (entregable §52.1)

Fluvia arranca como capa de software y orquestación de pagos (no banco, no custodio, no procesador certificado; ver límites en `../compliance/production-gates.md`). En esta iteración se entregó el **paquete completo de Fase 0**: auditoría crítica del Prompt V4 con 10 deficiencias detectadas y corregidas, PRD y alcance estricto del MVP (país abstracto, MockProvider, multi-tenant real), arquitectura de monolito modular TypeScript sobre PostgreSQL, diseño del ledger de doble partida interno con Chart of Accounts inicial, máquinas de estado separadas (intent/attempt/refund/dispute), estrategias normativas de idempotencia durable, outbox/inbox, RLS, webhooks y conciliación, threat model, clasificación de datos, 10 ADRs aceptados, backlog ejecutable F1–F4 con DAG y production gates con checklist de evidencia.

Además se validó empíricamente la fundación con un **spike ejecutado contra PostgreSQL 16 real**: Money VO exacto (bigint), RLS forzado con contexto SET LOCAL, triggers de inmutabilidad y runner de migraciones. El spike arrojó un hallazgo real incorporado a la normativa (política RLS con `NULLIF(current_setting(...), '')`).

## Evidencia de esta entrega (formato §47)

**Verificación ejecutada (2026-07-04, entorno de sesión):**

```
pnpm install                 → OK (lockfile generado, save-exact)
PostgreSQL 16.x local        → initdb + start OK
pnpm migrate                 → applied 0001_foundation.sql, 0002_enable_rls.sql
pnpm test                    → @fluvia/db     9/9 tests PASS (integración real:
                                 RLS aislamiento, WITH CHECK cross-tenant, PK cruzada,
                                 sin-contexto=0 filas, FLUVIA_IMMUTABLE en
                                 DELETE/TRUNCATE/UPDATE, authenticate_api_key)
                               @fluvia/money 20/20 tests PASS (precisión, exponentes,
                                 allocate sin pérdida, JSON >2^53, schema strict)
pnpm build (tsc --noEmit)    → 2/2 OK
```

**Fallo encontrado y corregido durante la verificación** (no ocultado, §46): la política RLS original casteaba `current_setting(...)::uuid` y rompía con cadena vacía tras reuso de conexión del pool; corregido con `NULLIF` en `0002_enable_rls.sql` + test que cubre exactamente ese escenario. Registrado en `../architecture/multi-tenancy.md`.

## Estado por componente

| Componente | Estado real |
|-----------|-------------|
| Paquete documental Fase 0 (30 entregables §52) | **Completado** (índice: `../README.md`) |
| Spike `@fluvia/money` | Completado como spike; se promueve formalmente en F2-01 |
| Spike `@fluvia/db` (migraciones RLS/inmutabilidad, runner, withTenantTransaction) | Completado como spike; se migra a modelo completo en F1-03 |
| Todo lo demás (auth, ledger service, outbox worker, API, checkout…) | **No construido** — backlog F1+ |

## Bloqueadores

1. **PEND-003**: aprobación humana del paquete de Fase 0 y ADRs (el constructor no se auto-aprueba).
2. **PEND-001** (país) — no bloquea F1–F4.
3. F0-VER: verificación en vivo de licencias de referencias (la red de esta sesión restringe repos externos).

## Próximo incremento propuesto

F1-01 + F1-02 (apps api/worker esqueleto + CI completo). Criterios y dependencias en `BACKLOG.md`. No iniciar sin PEND-003.
