# Fluvia

Plataforma de infraestructura y orquestación de pagos de misión crítica, en construcción bajo el marco del **Prompt Maestro V4**.

> **Estado: Fase 0 — Descubrimiento y decisiones.** Nada de lo aquí contenido es una capacidad productiva. Todo el alcance actual es documentación de decisión + un spike técnico de validación en sandbox local. Fluvia no es banco, adquirente, emisor, custodio ni procesador certificado (ver `docs/compliance/production-gates.md`).

## Qué hay en este repositorio

| Ruta | Contenido |
|------|-----------|
| `docs/` | **Paquete completo de Fase 0**: auditoría del prompt, PRD, arquitectura, diseño del ledger, state machines, estrategias (idempotencia, outbox/inbox, RLS, webhooks, conciliación), threat model, ADRs 0001–0010, backlog + DAG, production gates. Índice en [`docs/README.md`](docs/README.md) |
| `packages/money` | Spike validado: Value Object `Money` (bigint unidades menores, sin float, allocate sin pérdida) |
| `packages/db` | Spike validado: migraciones fundacionales (DDL + RLS forzado + triggers de inmutabilidad), runner de migraciones, `withTenantTransaction` |
| `docker-compose.yml` | Infra local: PostgreSQL 16 + Redis 7 |

El spike es **evidencia de decisiones de Fase 0** (ADR-0003/0005/0008), no la fundación definitiva: se migra formalmente en Fase 1/2 (`docs/agents/BACKLOG.md`).

## Ejecutar el spike localmente

```bash
pnpm install
docker compose up -d postgres      # o un PostgreSQL 16 local en :5432
pnpm migrate                       # aplica packages/db/migrations
pnpm test                          # unit (money) + integración real (RLS, inmutabilidad)
```

Variables: `ADMIN_DATABASE_URL`, `APP_DATABASE_URL`, `WORKER_DATABASE_URL` (defaults apuntan a docker-compose local).

## Gobernanza

- Trabajo: [`docs/agents/BACKLOG.md`](docs/agents/BACKLOG.md) · Estado: [`docs/agents/STATE.md`](docs/agents/STATE.md) · Decisiones: [`docs/agents/DECISIONS.md`](docs/agents/DECISIONS.md) · Riesgos: [`docs/agents/RISKS.md`](docs/agents/RISKS.md)
- Toda decisión arquitectónica pasa por ADR ([`docs/adr/`](docs/adr/)). Las decisiones **PEND-001** (país), **PEND-002** (pricing) y **PEND-003** (aprobación de Fase 0) requieren al propietario humano.
