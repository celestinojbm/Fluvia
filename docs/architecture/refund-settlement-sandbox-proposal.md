# Devoluciones y liquidación en sandbox — diagnóstico y propuesta (sin implementar)

> Estado: **PROPUESTA**. No libera fondos ni cambia reglas monetarias. No toca
> país, moneda ni COP (PEND-007 y PEND-008 siguen abiertas). Todo el diagnóstico
> está verificado con PostgreSQL real y MockProvider
> (`packages/payments-core/test/refund-settlement-gap.test.ts`).

## 1. Por qué `merchant.available` no recibe los fondos del cobro

Traza del asiento de captura en el flujo de producto (POS → checkout → confirmación):

| Paso | Código | Asiento | Resultado en las cuentas del comercio |
|---|---|---|---|
| 1. Cobro aprobado | `PaymentConfirmationService` → `PostingService.capturePayment` (`packages/ledger/src/posting.ts`) | Dr `provider.clearing` M · Cr `merchant.pending` M − Ff · Cr `platform.fees` Ff | `merchant.pending` += M − Ff |
| 2. Liberación | `PostingService.releaseSettlement` | Dr `merchant.pending` X · Cr `merchant.available` X | **No ocurre.** |
| 3. Devolución | `RefundService.execute` → `requestRefund` | Dr `merchant.available` R · Cr `refund.liability` R (guard de no-negatividad) | Con `available = 0` ⇒ refund `canceled` / `insufficient_merchant_balance`, sin contactar al proveedor |

**El flujo se queda en el paso 2.** `releaseSettlement` no tiene ningún llamador en
`apps/api/src` ni en `apps/worker/src`. Solo lo invocan:

- `packages/seeds/src/seed.ts` (`seed:demo:release-1`, 300.000 de un cobro de demo **ajeno** a las ventas del POS);
- `apps/api/drills/*` y las suites de tests (como precondición sembrada).

La conciliación (`settlement_reports`, F4-01/F4-02) empareja líneas del proveedor
con attempts, pero **no postea** ninguna liberación.

Consecuencias verificadas:

1. Cobro de 100.000 con el fee de producción (2%): `pending = 98.000`, `available = 0`.
   La devolución se cancela con `insufficient_merchant_balance`.
2. **En la organización de demo** el seed dejó 300.000 disponibles de otro cobro: una
   devolución del POS «funciona», pero consume fondos que **no son de esa venta**.
   Eso enmascara el hueco en las demos.
3. **Bruto contra neto.** El cupo devolvible se mide en bruto (`amount_captured` = M),
   pero al comercio solo se le acredita el neto (M − Ff). Aun liberando el neto de
   ese cobro, una devolución total del bruto no cabe: faltan Ff (verificado: 98.000
   disponibles contra una devolución de 100.000 ⇒ `canceled`).

## 2. Tres cifras distintas (y dónde vive cada una)

| Cifra | Definición | Fuente de verdad | Alcance |
|---|---|---|---|
| **Bruto** | Lo cobrado al cliente | `payment_intents.amount_captured` | por cobro |
| **Neto** | Lo acreditado al comercio por ese cobro | pierna `Cr merchant.pending` del asiento `attempt:<id>:capture` (M − Ff) | por cobro |
| **Saldo disponible** | Lo que el comercio puede devolver o retirar ya | balance de `merchant.available` | por comercio (fungible) |

Hoy el POS muestra solo el bruto («Cobrado») y el cupo devolvible, derivados del bruto.
No hay lectura de neto ni de disponible.

## 3. Propuesta para sandbox

### 3.1 Contrato (plano de sesión, solo sandbox)

```
POST /v1/organizations/:orgId/sandbox/settlement_releases
Idempotency-Key: <obligatoria>
{ "payment_intent_id": "<uuid>" }

201 { "object": "settlement_release", "payment_intent_id", "gross": M,
      "net": M − Ff, "released": M − Ff, "currency", "created_at" }
409 invalid_state_transition   — el cobro no está succeeded/partially_refunded/refunded
409 settlement_already_released — ya existe `settle:<intentId>` (replay de ledger)
404 not_found                   — cobro de otra organización (RLS)
```

- Permiso `reconciliation:manage` (owner/admin/finance) y **step-up**, como el resto
  de acciones que mueven dinero; auditoría `settlement.released` en la misma tx.
- Habilitado **solo** si el proveedor es el MockProvider (sandbox). Con proveedor
  real la liberación la dictará la conciliación del reporte del proveedor, no un botón.
- Libera **exactamente el neto registrado** en el asiento de captura (lectura de la
  pierna `merchant.pending`), jamás un importe recalculado ni enviado por el cliente.

Lectura complementaria (sin mover dinero):

```
GET /v1/organizations/:orgId/payment_intents/:id/funds
{ "gross": M, "net": M − Ff, "platform_fee": Ff, "released": 0 | M − Ff,
  "refunded": amount_refunded, "live_refunds": Σ(created|processing|indeterminate),
  "merchant_available": <balance merchant.available>, "currency" }
```

El POS usaría esta lectura para distinguir «Cobrado (bruto)», «Neto para el
comercio» y «Disponible del comercio» y avisar **antes** de confirmar que la
devolución se cancelará por falta de saldo, en vez de descubrirlo después.

### 3.2 Asientos

- `settlement.release` (ya existe): Dr `merchant.pending` N · Cr `merchant.available` N,
  `idempotencyKey = settle:<intentId>`, `source = ('settlement', intentId)`.
  Una sola liberación por cobro (la unicidad la da la key del ledger).
- Devolución: **sin cambios** hasta la decisión del §4.

### 3.3 Pruebas (PG real + MockProvider)

1. Cobro M (fee 2%) → release ⇒ `pending −(M−Ff)`, `available +(M−Ff)`; replay con la
   misma Idempotency-Key ⇒ misma respuesta, un solo asiento.
2. Doble release con keys distintas ⇒ el segundo 409, un solo asiento (`settle:<id>`).
3. Release de un cobro de otra organización ⇒ 404; sin step-up ⇒ 401/403.
4. Release + devolución parcial ≤ neto ⇒ `succeeded`; `refund.liability` vuelve a 0.
5. Release + devolución total del bruto ⇒ comportamiento según la decisión del §4
   (hoy: `canceled` por Ff; la prueba de caracterización ya lo fija).
6. `GET …/funds` cuadra con el ledger: `gross = net + platform_fee`,
   `live_refunds` incluye `indeterminate`.
7. `scripts/verify-ledger-invariants.sql` sin drift tras cada escenario.

## 4. Decisión pendiente (bloquea implementar el §3)

1. **¿Quién absorbe Ff en una devolución?**
   - (a) El comercio: la devolución de R reserva R de `available` (regla actual); una
     devolución total exige Ff de otros fondos.
   - (b) La plataforma revierte el fee proporcional: nuevo asiento
     Dr `platform.fees` Ff·R/M · Cr `merchant.available` Ff·R/M. Cambia ingresos.
   - (c) Limitar la devolución al neto: **descartada**; el cliente debe recibir lo que pagó.
2. **¿Puede una devolución salir de `merchant.pending`** cuando el cobro aún no se
   liberó (regla habitual antes de la liquidación)? Es una regla monetaria nueva
   (nueva operación tipada Dr `merchant.pending` · Cr `refund.liability`).
3. **Cuándo se libera en sandbox:** acción explícita del operador (propuesta) o
   T+N automática por el worker (requiere fijar N: regla monetaria).

Hasta que se decida, el comportamiento vigente es el conservador: sin disponible, la
devolución se cancela limpia y el proveedor no se contacta.
