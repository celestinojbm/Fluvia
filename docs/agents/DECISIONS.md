# Registro de decisiones

Estado: Activo · Índice ejecutivo; el detalle vive en los ADR (`../adr/`)

## Decisiones aceptadas (Fase 0)

| # | Decisión | Nivel V4 | ADR |
|---|----------|----------|-----|
| 1 | Monolito modular TypeScript; api + worker + frontends Next.js | B (confirmado) | 0001 |
| 2 | PostgreSQL única fuente durable; Redis solo acelerador | B (confirmado) | 0002 |
| 3 | SQL explícito (`pg`) en núcleo financiero; Kysely a evaluar para CRUD | B | 0003 |
| 4 | Ledger interno reducido; Formance solo referencia/extracción futura | B | 0004 |
| 5 | RLS forzado + contexto exclusivamente SET LOCAL transaction-scoped; roles app/worker | B | 0005 |
| 6 | Idempotencia durable en Postgres, misma transacción que el efecto | A/B | 0006 |
| 7 | Outbox + Inbox sobre Postgres con SKIP LOCKED, DLQ y replay auditado | B | 0007 |
| 8 | Money VO propio bigint (sin dinero.js) | B | 0008 |
| 9 | Webhooks salientes internos, contrato compatible-Svix | B | 0009 |
| 10 | Fastify + Zod sin NestJS | B | 0010 |
| 11 | Organization = frontera de tenant RLS; Merchant = autorización de aplicación | B | en `multi-tenancy.md` |
| 12 | IDs públicos: UUID aleatorio + prefijo de recurso | B | en `data-model.md` |
| 13 | Catálogo de eventos MVP normalizado (sin `charge.*`) | C | auditoría D3 |
| 14 | Purga de datos técnicos por clasificación (excepción controlada al no-DELETE) | B | `data-classification.md` |

## Decisiones PENDIENTES que requieren humano

| ID | Decisión | Bloquea | Contexto |
|----|----------|---------|----------|
| **PEND-001** | País/jurisdicción inicial | Fase 5 (proveedor real) | `compliance/jurisdiction-matrix.md` con candidatos CO/MX/CL |
| **PEND-002** | Modelo comercial (pricing) | Diseño fino del motor de fees (Fase 4) | Opciones en PRD §8 |
| **PEND-003** | Aprobación del paquete Fase 0 (este PR) y de los ADR 0001–0010 | Inicio de Fase 1 | El constructor no se auto-aprueba (§36: nadie propone y aprueba) |

## Supuestos adoptados (más seguros y reversibles, §2)

1. Moneda de sandbox USD + CLP para tests de exponente 0 — reversible, no codifica jurisdicción.
2. Retención de idempotency keys 24 h en sandbox — Nivel C, configurable.
3. Baselines de SLO de `system-overview.md` §5 — Nivel C, se ajustan con medición.
