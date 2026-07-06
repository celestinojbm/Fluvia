# Runbook · Disputa viva envejecida

**Alerta**: `fluvia_disputes_aged > 0` · **Sev**: ALTA (SEV-2) — fondos del comercio apartados con riesgo de **pérdida por defecto**.

**Qué significa**: una disputa (chargeback) lleva más de 7 días en estado `open`/`under_review`. El monto disputado está **apartado** del disponible del comercio en `dispute.reserve` (no se puede pagar ni disputar dos veces — no double-spend). El `DisputesWatchdog` (F4-10) la marcó envejecida. Importa porque una disputa tiene un **plazo de evidencia** del banco: si vence sin respuesta, se **pierde por defecto** (los fondos se forfeitan al proveedor, `dispute.reserve → provider.clearing`).

> **JAMÁS resolver por asunción.** No la marques `won` ni `lost` a mano. El único cierre legítimo es por **fuente verificada** (el webhook del banco). Lo que el operador SÍ hace es asegurar que el comercio **responda con evidencia** a tiempo (V4 §23).

## Diagnóstico

1. Localiza las disputas: `sweep_disputes()` (lo corre el watchdog) expone `held_total` y `held_aged`. Encuentra las filas `disputes` con `status IN ('open','under_review')` y `created_at` antiguo; anota `merchant_id`, `amount`, `currency`, `reason` (categoría del banco) y `provider_ref`.
2. Confirma con el comercio si hay **evidencia** que enviar (comprobante de entrega, autorización, etc.) y si ya la aportó.
3. Cruza con el estado real en el **banco/proveedor** por `provider_ref`: ¿la disputa sigue abierta? ¿cuál es la fecha límite? (En sandbox, el MockProvider; con banco real, su panel/API — F5.)

## Resolución (el operador responde; el banco resuelve)

- **Responder con evidencia (la acción del operador/comercio)**: desde el panel **Disputas → detalle → «Responder con evidencia»** (F4-08e; requiere `reconciliation:manage` — owner/admin/finance) o, por integración, `POST /v1/disputes/:id/evidence` (scope `payments:write`). Ambas caras llevan `open → under_review`. Marca que se respondió; es idempotente (re-responder sobre `under_review` no falla — la UI muestra «Evidencia enviada» en vez del botón). Esto NO decide el desenlace — solo registra la respuesta antes del plazo.
- **El desenlace (won/lost) llega SOLO por fuente verificada**: el **webhook firmado del banco** al inbox → `DisputeService.resolve(tenantId, { disputeId, outcome })`. `won` devuelve lo apartado íntegro al comercio (`dispute.reserve → merchant.available`); `lost` lo forfeita al proveedor (`dispute.reserve → provider.clearing`). Es idempotente y no reabre disputas terminales (`ignored_out_of_order`).
- Si el evento del banco **quedó en el inbox como `dead`** (veneno/agotado), recupéralo por [`outbox-inbox-stuck.md`](./outbox-inbox-stuck.md) (replay auditado) — no cierres la disputa por fuera.

> No hay endpoint de «resolver disputa» de operador por diseño: `resolve` se alcanza a través del inbox verificado del banco, no como acción libre. Intencional (Nivel A: sin cierres por asunción).

## Verificación

1. La disputa respondida pasa a `under_review`; deja de ser un pendiente de respuesta.
2. Al resolverse (por webhook), pasa a `won` o `lost`; deja de contar en `held_total`/`held_aged`.
3. El asiento del desenlace balancea (invariante SQL / sin drift): `won` restaura `merchant.available`; `lost` descarga `dispute.reserve` contra `provider.clearing`.
4. `fluvia_disputes_aged` vuelve a 0 cuando no quedan vivas envejecidas.

## Escalación

- Disputa que **vence** sin resolución del banco tras un tiempo razonable = potencial **SEV-1** (fondos que podrían perderse sin recurso): `incident-response.md`, contactar al banco por canal fuera de banda. NO forzar el desenlace.
- Muchas disputas envejecidas a la vez = revisar si el webhook del banco está llegando (¿eventos `dead` en el inbox? ¿fan-out/entrega sana?) y si el comercio está respondiendo.

## Drill (F4-06b)

Pendiente: abrir una disputa (webhook `dispute.opened`) → envejecer > umbral → confirmar alerta/gauge → responder con evidencia → entregar `dispute.won`/`dispute.lost` del banco → `resolve` cierra con el asiento correcto. (Las suites de payments-core/worker ya prueban el ciclo abrir→retener→resolver y la salud del watchdog.)
