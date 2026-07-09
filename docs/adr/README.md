# Architecture Decision Records

Formato: Contexto · Decisión · Alternativas · Consecuencias · Riesgos · Estado · Evidencia.

| ADR | Título | Estado |
|-----|--------|--------|
| [0001](0001-monolito-modular-typescript.md) | Monolito modular en TypeScript | Aceptado |
| [0002](0002-postgres-fuente-de-verdad.md) | PostgreSQL fuente transaccional; Redis acelerador | Aceptado |
| [0003](0003-sql-explicito-nucleo-financiero.md) | SQL explícito en el núcleo financiero | Aceptado |
| [0004](0004-ledger-interno.md) | Ledger interno reducido (vs Formance) | Aceptado |
| [0005](0005-rls-set-local.md) | RLS forzado con contexto SET LOCAL | Aceptado |
| [0006](0006-idempotencia-durable-postgres.md) | Idempotencia durable en PostgreSQL | Aceptado |
| [0007](0007-outbox-inbox-postgres.md) | Outbox e Inbox sobre PostgreSQL | Aceptado |
| [0008](0008-money-value-object-propio.md) | Money VO propio con bigint | Aceptado |
| [0009](0009-webhooks-salientes-internos.md) | Webhooks salientes internos (Svix futuro) | Aceptado |
| [0010](0010-fastify-zod-sin-nestjs.md) | Fastify + Zod sin NestJS | Aceptado |
| [0011](0011-outbox-relay-role.md) | Rol dedicado del outbox relay (sin BYPASSRLS) | Aceptado |
| [0012](0012-secret-manager-produccion.md) | Secret manager en producción: inyección por env + rotación | Propuesto |

Los ADR se numeran secuencialmente y nunca se editan tras aceptarse: se sustituyen por uno nuevo (`Superseded by`). Un ADR **Propuesto** aún puede editarse hasta que el propietario lo acepte.
