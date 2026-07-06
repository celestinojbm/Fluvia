# Runbook · Pago `indeterminate` envejecido

**Alerta**: `fluvia_payment_attempts_indeterminate_aged > 0` · **Sev**: ALTA (SEV-2) — dinero en desenlace **desconocido** > 30 min.

**Qué significa**: un `payment_attempt` quedó en estado `indeterminate` — el proveedor fue inalcanzable o dio timeout **después** de que el cargo pudiera haberse enviado, así que **no sabemos** si el dinero se movió (V4 §23). El `AttemptsWatchdog` lo marcó como envejecido (> 30 min sin resolver). Un circuito abierto (`CircuitOpenError`) NO produce esto: ese es un fallo **limpio** (`provider_unavailable`) porque el cargo jamás se envió.

> **JAMÁS resolver por asunción.** No lo marques `succeeded` ni `failed` a mano. El único cierre legítimo es por **fuente verificada** (webhook del proveedor o conciliación). El dinero en duda se mantiene en duda hasta confirmarlo.

## Diagnóstico

1. Identifica los attempts: `sweep_payment_attempts()` (lo corre el watchdog) expone `indeterminate_total` e `indeterminate_aged`. Localiza los `payment_attempts` con `status='indeterminate'` y su `intent`, `provider_ref` (si hay), `last_error` y antigüedad.
2. Consulta el **estado real en el proveedor** para cada `provider_ref`: ¿el cargo existe? ¿en qué estado? (En sandbox, el MockProvider; con proveedor real, su panel/API — F5.)
3. Cruza con la **conciliación**: si el periodo ya cerró, el reporte de liquidación del proveedor (F4-01/F4-02) dirá si esa referencia se liquidó → aparecería como `missing_in_ledger` si el proveedor la cobró y Fluvia no la registró (ver [`reconciliation-discrepancy.md`](./reconciliation-discrepancy.md)).

## Resolución (por fuente verificada — única vía)

Una vez el proveedor confirma el desenlace real:

- **Vía normal (preferida)**: dejar que el **webhook firmado del proveedor** llegue al inbox. El handler verificado llama a `PaymentConfirmationService.resolveFromProvider(tenantId, { attemptId, providerRef, result, failureCode? })` — la **única** forma sancionada de cerrar un attempt `submitted`/`indeterminate`. Con `result='succeeded'` postea la captura contable atómica (`attempt:<id>:capture`); con `'failed'` registra el declive. Es idempotente y rechaza referencias que no casen (`ignored` / `ignored_out_of_order`).
- Si el evento del proveedor **quedó en el inbox como `dead`** (veneno/agotado), primero recupéralo por [`outbox-inbox-stuck.md`](./outbox-inbox-stuck.md) (replay auditado) — no cierres el attempt por fuera.
- Si el desenlace se determina por **conciliación** (no llegó webhook), el ajuste va por el **caso operativo con four-eyes** ([`reconciliation-discrepancy.md`](./reconciliation-discrepancy.md)), no por edición directa del attempt.

> No hay endpoint de «resolución manual» de attempts por diseño: `resolveFromProvider` se alcanza a través del inbox verificado, no como acción libre de operador. Esto es intencional (Nivel A: sin cierres por asunción).

## Verificación

1. El attempt pasa a un estado terminal correcto (`succeeded` con captura, o `failed`); deja de contar en `indeterminate_total`/`indeterminate_aged`.
2. Si fue `succeeded`, el asiento de captura balancea (invariante SQL / sin drift).
3. `fluvia_payment_attempts_indeterminate_aged` vuelve a 0 cuando no quedan envejecidos.
4. El `audit_log`/inbox registra la resolución con su fuente (evento de proveedor).

## Escalación

- Indeterminado que **no** se puede confirmar ni por webhook ni por conciliación tras un tiempo razonable = **SEV-1** potencial (posible dinero movido sin registrar): `incident-response.md`, contactar al proveedor por canal fuera de banda, NO cerrar por asunción.
- Muchos indeterminados a la vez = el proveedor está caído/inestable; revisa el circuit breaker (los nuevos cargos deberían fallar **limpio** con `provider_unavailable`, no acumular indeterminados).

## Drill (F4-06b)

Pendiente: forzar un timeout del proveedor (mock) → attempt `indeterminate` → envejecer > umbral → confirmar alerta/log → entregar el webhook de proveedor → `resolveFromProvider` cierra el attempt correctamente. (Las suites de payments-core ya prueban los desenlaces conocido/desconocido y la captura idempotente.)
