# Runbook · Discrepancia de conciliación

**Alerta**: `fluvia_reconciliation_discrepancies_last > 0` o `increase(fluvia_reconciliation_entries_total{status=~"amount_mismatch|missing_in_ledger|missing_at_provider"}[1h]) > 0` · **Sev**: ALTA (SEV-2; `missing_in_ledger` = **SEV-1**: el proveedor liquidó dinero que Fluvia no ve).

**Qué significa**: el motor de conciliación (F4-01a) o el barrido continuo (F4-02) casó las líneas del reporte de liquidación del proveedor contra los intentos `succeeded` del tenant y encontró al menos una referencia que **no cuadra**. Cada discrepancia ya se materializó como un `operational_case` (F4-03a).

> **Prohibido (V4 §30)**: corrección silenciosa. Todo ajuste pasa por un caso, con razón, actor y —sobre umbral— **four-eyes**. Nunca SQL manual sobre el ledger.

## Clases de discrepancia

| Clase | Significado | Severidad del caso |
| --- | --- | --- |
| `amount_mismatch` | La referencia existe en ambos lados pero el monto difiere | high |
| `missing_in_ledger` | El proveedor la liquidó; Fluvia no tiene el intent `succeeded` | **critical** |
| `missing_at_provider` | Fluvia tiene el intent; el proveedor no la reportó | high |

## Diagnóstico

1. **Panel → «Conciliación»** (`/o/:orgId/reconciliation`): abre el reporte más reciente. El resumen muestra el conteo por clase (`matched` / `amount_mismatch` / `missing_in_ledger` / `missing_at_provider`).
2. Abre el detalle del reporte (`/o/:orgId/reconciliation/:reportId`): la tabla de discrepancias lista cada `provider_ref` con el **monto ledger** vs **monto proveedor** y el estado.
3. **Panel → «Casos»** (`/o/:orgId/cases`, filtro `open`): cada discrepancia `!= matched` tiene su `operational_case` con la evidencia (reporte, `provider_ref`, montos, clase). Ordena por severidad (`critical` primero).
4. Correlaciona con el payment intent: para `amount_mismatch`/`missing_at_provider` el caso enlaza el `provider_ref`; búscalo en **Payment intents** del panel o por el plano de integración.
5. Consulta el `audit_log` (**Eventos**) si necesitas la traza del actor que ingirió el reporte o disparó la conciliación.

## Resolución

Primero **reconoce** el caso (Panel → «Casos» → detalle → **Reconocer**) para señalar que está en investigación.

Según la causa raíz:

- **Diferencia explicable sin mover dinero** (p. ej. una nota aclaratoria, un desfase de fecha que se resolverá en el próximo reporte): resuelve el caso de forma **documental** (detalle → **Resolver**, con nota). *Resolver NO mueve dinero.*
- **Requiere ajuste contable** (`amount_mismatch` real, o `missing_in_ledger` que exige registrar la diferencia): usa el **ajuste con four-eyes**:
  1. En el detalle del caso, **Proponer ajuste**: monto (unidades menores), moneda, dirección (`debit_differences` / `credit_differences`) y motivo. Requiere el permiso `reconciliation:manage` (owner/admin/finance).
  2. Un **segundo usuario distinto** con el mismo permiso **Aprueba** el ajuste. Aprobar el propio ajuste devuelve `409 four_eyes_required` — es intencional (Nivel A: un solo humano no autoriza dinero real sobre umbral).
  3. Al aprobar, el sistema postea el asiento compensatorio real `recon.differences ↔ suspense` (`PostingService.postReconAdjustment`) y **resuelve el caso** en una transacción atómica.
  - Si el ajuste era erróneo antes de aprobarse, **Rechazar** (con motivo) libera el caso para una nueva propuesta.

## Verificación

1. El caso queda en estado `resolved`; el detalle muestra el ajuste `applied` con su `ledger_transaction_id`.
2. La alerta se despeja cuando ya no hay `reconciliation_entries` sin trabajar (`fluvia_reconciliation_discrepancies_last` vuelve a 0 en el siguiente barrido).
3. El asiento del ajuste **balancea** (débitos == créditos) — lo garantiza el ledger (`scripts/verify-ledger-invariants.sql` en CI); el drift check no debe dispararse.
4. El `audit_log` (**Eventos**) registra `operational_case.acknowledged`, `case_adjustment.proposed`/`.applied` (o `.rejected`) y `operational_case.resolved` con actor y razón.

## Escalación

- `missing_in_ledger` **persistente** o de monto alto = **SEV-1** (el proveedor movió dinero que el sistema no registró): activar `incident-response.md`, preservar evidencia, NO conciliar por asunción.
- Si el asiento del ajuste provoca **drift contable** (`fluvia_ledger_projection_drift_accounts > 0`), ir a [`ledger-drift.md`](./ledger-drift.md) — es SEV-1.

## Drill (F4-06b)

Pendiente de ejecución con evidencia: sembrar un reporte con las 4 clases por el plano de API key → verificar que se materializan los casos → trabajar un `amount_mismatch` con four-eyes (dos usuarios) → confirmar asiento + caso resuelto + audit trail. (El E2E de navegador de F4-01c/F4-03c-ii ya ejerció parte de este flujo localmente.)
