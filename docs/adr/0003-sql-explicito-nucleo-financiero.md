# ADR-0003 — SQL explícito en el núcleo financiero

Estado: Aceptado (con reevaluación acotada en F1) · Fase 0

## Contexto
V4 §12 exige comparar SQL explícito, Kysely, Drizzle y Prisma, y prohíbe que el ORM oculte operaciones financieras críticas (`FOR UPDATE` ordenado, `ON CONFLICT`, constraint triggers, `SKIP LOCKED`, `set_config`).

## Decisión
El núcleo financiero (ledger, idempotencia, outbox/inbox, transiciones FSM) usa **SQL explícito con `pg`** dentro de servicios de dominio tipados. Para CRUD no crítico (organizations, customers, dashboards) se evaluará **Kysely** en F1 como query builder tipado (sin runtime mágico), en un ADR menor.

## Alternativas
- Prisma: excelente DX, pero su capa de query engine abstrae exactamente los mecanismos que necesitamos visibles; RLS + `SET LOCAL` requiere workarounds (`$transaction` + raw) que degradan a SQL igual.
- Drizzle: cercano al SQL y tipado, opción viable; se descarta como default del núcleo para eliminar cualquier capa entre el código y los locks, pero es el candidato natural si el SQL manual demuestra ser costoso.
- Kysely: mejor equilibrio para el CRUD; no sustituye al SQL del núcleo.

## Consecuencias
+ Cada lock, conflicto y constraint es visible y revisable en el PR. − Más boilerplate de mapeo (mitigado con helpers tipados y Zod en los bordes).

## Evidencia
Spike: `withTenantTransaction`, migraciones y tests de RLS/inmutabilidad en SQL explícito, legibles y verificados.
