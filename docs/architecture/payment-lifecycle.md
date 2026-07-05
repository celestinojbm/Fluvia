# Payment Lifecycle

Estado: Activo · Fase: 0

> **Estado de implementación (2026-07-05, F3-01/F3-02): PARCIAL.** Construido hoy: plano contable del ciclo (F2-03/F2-04), `payment_intents` REAL con FSM en el motor + `payment_attempts` (0017, F3-01) y los primeros endpoints idempotentes del plano de integración: `POST/GET /v1/payment_intents`, `GET /v1/payment_intents/:id`, `POST .../cancel` (F3-02, contrato en `docs/api/openapi.v1.json`). Construido también (F3-03 parte síncrona): **confirm** idempotente con contrato asíncrono (responde `processing`; el estado final se lee vía GET), MockPaymentProvider (tokens de prueba), attempts en ejecución con captura contable ATÓMICA (asiento+attempt+intent+`amount_captured` en una transacción vía `onPosted`; fees 0 hasta PEND-002) y timeout→`indeterminate` (V4 §23: sin resolución por asunción). NO construido: outcome asíncrono `pending`/handler de inbox (F3-03b), barrido submitting→indeterminate (F3-04), checkout, webhooks salientes, customers (F3-05).

## 1. Principio

Un pago **no es una línea recta**. Se modela como la composición de máquinas de estado independientes (detalle en `payment-state-machines.md`): Payment Intent (intención del comercio), Payment Attempt (cada intento concreto contra un proveedor), Authorization/Capture (cuando el método los separa), Refund, Dispute, Settlement y Payout. Cada una tiene su tabla, su FSM, su auditoría y sus eventos.

## 2. Flujo feliz del MVP (MockProvider)

```
comercio crea PaymentIntent (API, idempotente)          → intent: created
comercio crea CheckoutSession                            → session activa
pagador abre checkout, "tokeniza" método                 → intent: requires_confirmation
pagador confirma                                         → intent: processing / attempt: created→submitted
MockProvider responde/emite evento asíncrono             → inbox: verificado + deduplicado
attempt: succeeded                                       → intent: succeeded
LedgerService registra capture + fees (misma tx de dominio + outbox)
proyección de balance actualizada (merchant.pending)
outbox → webhook payment_intent.succeeded firmado al comercio
dashboard muestra la operación
```

## 3. Realidades que el diseño soporta desde el día 1

- **Métodos asíncronos**: `processing` puede durar horas; la verdad llega por webhook/consulta, no por la respuesta HTTP inicial.
- **Timeout ambiguo** (V4 §23): attempt queda `indeterminate`; se consulta `getPayment`, se espera webhook y se concilia. Nunca se reintenta a ciegas una operación no idempotente.
- **Eventos fuera de orden**: el inbox persiste todo; los handlers validan transición contra la FSM — un `succeeded` que llega después de un `refund.created` no retrocede estados.
- **Reintentos de pago**: N attempts por intent; solo un attempt puede estar activo (constraint parcial único).
- **Capturas parciales / múltiples**: modelo `authorizations`/`captures` presente; habilitado cuando el proveedor real lo soporte.
- **Refunds parciales acumulativos**: invariante `Σ refunds ≤ capturado` verificada en servicio + property test.
- **Disputas**: lifecycle propio relacionado al pago; no fuerzan un estado terminal lineal del intent.
- **Reversals del proveedor**: asiento compensatorio + evento, nunca edición.

## 4. Reglas de transición (normativas)

Toda transición: valida estado origen y destino contra la FSM, valida actor (comercio, sistema, proveedor, operador), es idempotente (transición ya aplicada = no-op con registro), se ejecuta con `SELECT … FOR UPDATE` + `version` guard, emite evento outbox en la misma transacción, registra referencia externa del proveedor cuando existe, y queda auditada. **Nadie** (controller, worker, admin) muta `status` fuera del servicio de dominio; el rol de aplicación no tendrá UPDATE directo sobre las columnas de estado en el futuro endurecimiento (F2).
