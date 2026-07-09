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

✅ **Ejecutado — PASS 6/6** (`pnpm --filter @fluvia/api run drill:indeterminate`, `apps/api/drills/indeterminate-payment-drill.ts`). Ensaya este runbook sobre un stack real (Postgres + la API en proceso, con el ingreso del pago **sobre HTTP**), cruzando los dos planos (proveedor verificado + worker); a diferencia de `aged-disputes`, **no hay acción de operador** — la resolución es solo por fuente verificada, por diseño:

1. Confirmar con `tok_timeout` → el proveedor lanza `ProviderTimeoutError` → el attempt queda **`indeterminate`** (NO `failed`), con `last_error` marcando «outcome unknown» y el intent en `processing`. Esto distingue el timeout (desenlace DESCONOCIDO) de un **circuito abierto** (fallo LIMPIO `provider_unavailable`).
2. **Envejecer** > 30 min y `sweep_payment_attempts()` marca `indeterminate_aged ≥ 1` (alerta ALTA `fluvia_payment_attempts_indeterminate_aged > 0`).
3. **NIVEL A**: el watchdog SURFACEA salud pero **NO resuelve** — el attempt sigue `indeterminate` (jamás `succeeded`/`failed` por asunción, V4 §23).
4. Resolución verificada **`succeeded`** → captura contable ATÓMICA e idempotente (`attempt:<id>:capture`); intent `succeeded` + `amount_captured`; un webhook tardío → `ignored_out_of_order` (sin doble captura).
5. Un segundo indeterminado resuelto **`failed`** → attempt/intent `failed`, **SIN** asiento.
6. Una **referencia inexistente** → `ignored`: la resolución jamás cierra nada por fuera.

Cierre con `scripts/verify-ledger-invariants.sql` → `FLUVIA_INVARIANTS_OK` (sin drift). La ingesta HTTP→inbox del webhook firmado del proveedor la cubre `webhook-ingest.test.ts`; el drill representa el webhook por `PaymentConfirmationService.resolveFromProvider` — la misma vía que llama el handler verificado. La EJECUCIÓN es local (el CI no levanta el stack, como el resto de los drills).
