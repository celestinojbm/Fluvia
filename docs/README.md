# Documentación de Fluvia — Fase 0

Este directorio contiene los entregables de la **Fase 0 (Descubrimiento y decisiones)** exigidos por el Prompt Maestro V4 (§52), más la documentación viva del proyecto.

## Mapa de entregables de la §52

| # | Entregable | Documento |
|---|-----------|-----------|
| 1 | Resumen ejecutivo | [agents/STATE.md](agents/STATE.md) |
| 2–3, 28–30 | Auditoría crítica del prompt, correcciones, deficiencias, adiciones, cambios con criterio propio | [agents/prompt-audit-v4.md](agents/prompt-audit-v4.md) |
| 4 | Referencias analizadas | [references/](references/) |
| 5 | Matriz comparativa | [references/reference-comparison-matrix.md](references/reference-comparison-matrix.md) |
| 6 | PRD inicial | [product/product-requirements.md](product/product-requirements.md) |
| 7–8 | Alcance MVP y fuera de alcance | [product/mvp-scope.md](product/mvp-scope.md) |
| 9 | Arquitectura propuesta | [architecture/system-overview.md](architecture/system-overview.md) |
| 10 | Modelo de amenazas | [security/threat-model.md](security/threat-model.md) |
| 11 | Modelo de datos | [architecture/data-model.md](architecture/data-model.md) |
| 12 | Diseño del ledger | [architecture/ledger-design.md](architecture/ledger-design.md) |
| 13 | Chart of Accounts inicial | [architecture/ledger-chart-of-accounts.md](architecture/ledger-chart-of-accounts.md) |
| 14 | Payment lifecycle | [architecture/payment-lifecycle.md](architecture/payment-lifecycle.md) |
| 15 | State machines separadas | [architecture/payment-state-machines.md](architecture/payment-state-machines.md) |
| 16 | Estrategia de idempotencia | [architecture/idempotency.md](architecture/idempotency.md) |
| 17 | Estrategia outbox e inbox | [architecture/outbox-inbox.md](architecture/outbox-inbox.md) |
| 18 | Estrategia multi-tenant y RLS | [architecture/multi-tenancy.md](architecture/multi-tenancy.md) |
| 19 | Estrategia de webhooks | [architecture/webhook-delivery.md](architecture/webhook-delivery.md) |
| 20 | Estrategia de conciliación | [architecture/reconciliation.md](architecture/reconciliation.md) |
| 21 | Registro de riesgos | [agents/RISKS.md](agents/RISKS.md) |
| 22 | Registro de decisiones | [agents/DECISIONS.md](agents/DECISIONS.md) + [adr/](adr/) |
| 23 | Backlog P0–P3 y futuro | [agents/BACKLOG.md](agents/BACKLOG.md) |
| 24 | DAG de dependencias | [agents/BACKLOG.md#dag](agents/BACKLOG.md#dag) |
| 25 | Plan por fases | [product/phase-plan.md](product/phase-plan.md) |
| 26 | Production gates | [compliance/production-gates.md](compliance/production-gates.md) |
| 27 | Documentos derivados | este índice completo |

Documentos operativos y de gobernanza para agentes: [agents/STATE.md](agents/STATE.md), [agents/HANDOFF.md](agents/HANDOFF.md).

## Auditorías

| Documento | Contenido |
|-----------|-----------|
| [audits/independent-audit-v1/](audits/independent-audit-v1/) | Informe de la auditoría independiente v1 (**inmutable** — hallazgos, severidades y evidencias del auditor tal como se recibieron) |
| [audits/audit-integration-plan-v1.md](audits/audit-integration-plan-v1.md) | Reconciliación del constructor: clasificación evidencia-por-hallazgo y plan integrado |
| [audits/audit-closure-register-v1.md](audits/audit-closure-register-v1.md) | Estado vivo de cada hallazgo (RESUELTO/MITIGADO/PLANIFICADO…) con evidencia individual |

## Convenciones

- Idioma de la documentación: español. Código, identificadores y mensajes de commit: inglés.
- Todo documento normativo indica su estado: `Borrador`, `Activo`, `Superseded`.
- Las decisiones arquitectónicas se registran como ADR en [adr/](adr/); [agents/DECISIONS.md](agents/DECISIONS.md) es el índice ejecutivo.
- Nada de lo aquí descrito declara capacidades productivas: **todo el alcance actual es sandbox** (ver [compliance/production-gates.md](compliance/production-gates.md)).
