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
| 15 | **País inicial: Colombia** (decidido por el propietario, 2026-07-04). Sin reglas legales codificadas hasta completar la matriz con revisión legal | Producto | `compliance/jurisdiction-matrix.md` |
| 16 | **Paquete de Fase 0 y ADRs 0001–0010 aprobados** por el propietario (2026-07-04) → Fase 1 desbloqueada | Gobernanza | ex PEND-003 |
| 17 | **Auditoría Independiente v1 integrada** (2026-07-04): informe inmutable en `docs/audits/independent-audit-v1/`; reconciliación evidencia-por-hallazgo en `audit-integration-plan-v1.md`; lote AUD-1 ejecutado; veredicto adoptado (continuar; congelar pagos públicos/live hasta cerrar bloqueantes) | Gobernanza | `docs/audits/` |
| 18 | **Reservas = cuentas del Chart, no bucket de proyección** (AUD-P2-013): `merchant.reserve`/`dispute.reserve`/`refund.liability` como cuentas; buckets solo `available`/`pending`. Cambiarlo exigirá ADR | B | `ledger-design.md` §2 |
| 19 | **Credenciales `live` bloqueadas por código** (AUD-P2-003): `LiveKeysDisabledError` hasta pasar production gates + decisión humana (PEND-004). Opción más restrictiva y reversible | A/B | `api-keys.ts` |

## Decisiones PENDIENTES que requieren humano

| ID | Decisión | Bloquea | Contexto |
|----|----------|---------|----------|
| **PEND-002** | Modelo comercial (pricing) | Diseño fino del motor de fees (Fase 4) | Opciones en PRD §8 |
| **PEND-004** | Política definitiva de credenciales `live` (¿qué gates exactos + quién autoriza la primera emisión?) | Nada hoy (creación bloqueada por código, decisión #19) | AUD-P2-003; `production-gates.md` |
| **PEND-005** | Modelo MFA/recuperación de cuenta (propuesta: TOTP + códigos de respaldo; ¿SMS excluido?) | F1-04b | AUD-P1-006 |
| **PEND-006** | Condiciones para abrir sandbox compartido a terceros | Exposición pública del sandbox | Requiere F1-04b + AUD-P2-015 |

Resueltas: ~~PEND-001~~ → Colombia (decisión #15). ~~PEND-003~~ → aprobado (decisión #16).

## Supuestos adoptados (más seguros y reversibles, §2)

1. Moneda de sandbox USD + CLP para tests de exponente 0 — reversible, no codifica jurisdicción.
2. Retención de idempotency keys 24 h en sandbox — Nivel C, configurable.
3. Baselines de SLO de `system-overview.md` §5 — Nivel C, se ajustan con medición.
