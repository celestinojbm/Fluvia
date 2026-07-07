# Runbooks operativos

Estado: Activo · Fase: 4 (F4-06a) · Procedimientos de operación de lo **ya construido**. Cada runbook está anclado a métricas, endpoints y flujos reales del código (sin procedimientos genéricos ni capacidades simuladas — V4 Nivel A).

> **Regla de oro (V4 §30 + `incident-response.md`)**: el dinero se corrige SOLO por los caminos sancionados — compensaciones/ajustes con caso, replay auditado de outbox/inbox, rebuild explícito de proyecciones. **Nunca SQL manual sobre datos financieros; nunca corrección silenciosa.** El ledger y el `audit_log` son append-only precisamente para esto. Si un ajuste toca dinero real sobre umbral, exige **four-eyes** y queda auditado.

## Cómo usar estos runbooks

1. Parte de la **alerta** (`observability.md` §4) o del **síntoma** reportado.
2. Localiza el runbook por la tabla de abajo.
3. Sigue **Diagnóstico → Resolución → Verificación**. No saltes el diagnóstico: varias alertas exigen investigar **antes** de reparar (drift, discrepancias).
4. Toda acción de operación queda en el `audit_log`; consúltalo en el panel (**Eventos**, `audit-investigation.md`).

## Severidad (espeja `incident-response.md`)

| Sev | Definición | Runbooks |
| --- | --- | --- |
| **SEV-1** | Integridad financiera o aislamiento comprometidos | `ledger-drift`, discrepancia no explicada, asiento desbalanceado |
| **SEV-2** | Degradación grave sin corrupción | `outbox-inbox-stuck`, `indeterminate-payment`, `worker-down` |
| **SEV-3** | Degradación parcial | `webhook-dead-letter`, latencia/DLQ con causa conocida |

## Índice: alerta → runbook

| Alerta (`observability.md` §4) | Métrica | Sev | Runbook |
| --- | --- | --- | --- |
| Drift contable | `fluvia_ledger_projection_drift_accounts > 0` | CRÍTICA | [`ledger-drift.md`](./ledger-drift.md) |
| Chequeos de drift detenidos / Worker sin latido | `fluvia_ledger_projection_drift_checks_total`, `fluvia_worker_heartbeats_total` | ALTA | [`worker-down.md`](./worker-down.md) |
| Eventos `dead` en outbox / inbox | `fluvia_outbox_relay_events_total{result="dead"}`, `fluvia_inbox_events_total{result="dead"}` | ALTA | [`outbox-inbox-stuck.md`](./outbox-inbox-stuck.md) |
| Indeterminados envejecidos | `fluvia_payment_attempts_indeterminate_aged > 0` | ALTA | [`indeterminate-payment.md`](./indeterminate-payment.md) |
| Disputas envejecidas | `fluvia_disputes_aged > 0` | ALTA | [`aged-disputes.md`](./aged-disputes.md) |
| Discrepancias de conciliación | `fluvia_reconciliation_discrepancies_last > 0` | ALTA | [`reconciliation-discrepancy.md`](./reconciliation-discrepancy.md) |
| Webhooks salientes `dead` | `fluvia_webhook_deliveries_total{result="dead"}` | MEDIA | [`webhook-dead-letter.md`](./webhook-dead-letter.md) |
| (investigación transversal) | `audit_log` / panel «Eventos» | — | [`audit-investigation.md`](./audit-investigation.md) |

## Estado de drill (F4-06b)

«Runbooks probados en drill» es el criterio de salida de la Fase 4 (`phase-plan.md`). El estado de ejecución en drill de cada runbook se registra en su sección **Drill** y en `docs/audits/audit-closure-register-v1.md`. F4-06a entregó los procedimientos; F4-06b ejecuta y evidencia los drills.

| Runbook | Drill | Cómo |
| --- | --- | --- |
| `reconciliation-discrepancy` | ✅ **PASS (9/9)** | `pnpm --filter @fluvia/api run drill:reconciliation` (`apps/api/drills/reconciliation-drill.ts`) — API real sobre HTTP, four-eyes con dos operadores, invariantes del ledger verdes |
| `webhook-dead-letter` | pendiente | E2E de F3-09b-iii ya ejerció el reenvío desde el panel (local) |
| `ledger-drift` | pendiente | property test `packages/ledger/test/drift.test.ts` ejerce rebuild bajo concurrencia |
| `outbox-inbox-stuck` | pendiente | suites de `@fluvia/outbox`/`@fluvia/inbox` ejercen `dead` + replay auditado |
| `indeterminate-payment` | ✅ **PASS (6/6)** | `pnpm --filter @fluvia/api run drill:indeterminate` (`apps/api/drills/indeterminate-payment-drill.ts`) — proveedor→worker sobre HTTP real: `tok_timeout`→indeterminate (≠ circuito abierto), envejecer→`sweep_payment_attempts` alerta, watchdog NO resuelve, `resolveFromProvider` succeeded (captura idempotente) / failed (sin asiento) / referencia inexistente→ignored + `FLUVIA_INVARIANTS_OK` |
| `aged-disputes` | ✅ **PASS (7/7)** | `pnpm --filter @fluvia/api run drill:disputes` (`apps/api/drills/disputes-drill.ts`) — banco→worker→operador sobre HTTP real: abrir idempotente + aparte, envejecer→`sweep_disputes` alerta, watchdog NO transiciona, gate `reconciliation:manage`, responder evidencia por sesión (F4-08e), won restaura / lost forfeita, asientos balanceados + `FLUVIA_INVARIANTS_OK` |
| `worker-down` | pendiente | — |
| `audit-investigation` | ✅ ejercido de facto | el drill de conciliación verifica el rastro de auditoría (paso 8) |

El drill de conciliación cubre el flujo **crítico** (dinero + four-eyes + ledger) que es el corazón del Gate Conciliación; sobre ese mismo patrón (`apps/api/drills/`) ya se ejecutan también el de **disputas** (money-clawed-back: banco→worker→operador) y el de **pagos indeterminados** (money-in-doubt: proveedor→worker, resolución solo por fuente verificada) — F4-06b. Los runbooks restantes (`outbox-inbox-stuck`, `worker-down`, `webhook-dead-letter`) se añaden incrementalmente sobre esa base.
