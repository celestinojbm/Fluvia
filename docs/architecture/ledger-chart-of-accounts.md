# Chart of Accounts inicial

Estado: Borrador activo · Fase: 0 · Se refina al implementar F2 (núcleo financiero)

Convención: `normal_side` indica el lado que incrementa el saldo. Toda cuenta existe **por tenant y por moneda** (el "código" es la plantilla). El alcance contable del MVP es sandbox: representan obligaciones contables simuladas, no depósitos.

| Código | Nombre | Tipo | Normal side | Propósito |
|--------|--------|------|-------------|-----------|
| `provider.clearing` | Provider clearing | Activo | debit | Fondos capturados por el proveedor aún no liquidados a nadie |
| `provider.receivable` | Provider receivable | Activo | debit | Montos que el proveedor debe transferir (post-settlement) |
| `provider.payable` | Provider payable | Pasivo | credit | Montos que se deben devolver al proveedor (reversals) |
| `merchant.pending` | Merchant pending | Pasivo | credit | Obligación con el comercio aún no disponible (captura sin liquidar) |
| `merchant.available` | Merchant available | Pasivo | credit | Obligación con el comercio disponible para payout |
| `merchant.reserve` | Merchant reserve | Pasivo | credit | Reserva retenida (riesgo/disputas) |
| `platform.fees` | Platform fees | Ingreso | credit | Fee de Fluvia devengado |
| `provider.fees` | Processing fees | Gasto | debit | Fee del proveedor/adquirente |
| `refund.liability` | Refund liability | Pasivo | credit | Refunds creados aún no confirmados por el proveedor |
| `dispute.reserve` | Dispute reserve | Pasivo | credit | Retenciones por disputas abiertas |
| `platform.cash` | Platform cash | Activo | debit | Caja/banco operativo de Fluvia; de aquí salen los payouts (F4-05b) |
| `payout.in_transit` | Payouts in transit | Pasivo | credit | Obligación de payout en vuelo, aún no confirmada por el banco (F4-05b) |
| `suspense` | Suspense account | Transitoria | debit | Movimientos no clasificables aún; saldo objetivo = 0; alerta si envejece |
| `recon.differences` | Reconciliation differences | Transitoria | debit | Ajustes reconocidos por conciliación, siempre con caso asociado |

## Reglas de posting del MVP — IMPLEMENTADAS (F2-04; fuente de verdad: `packages/ledger/src/posting.ts`)

**Modelo contable sandbox v1 (bruto)** — desviación registrada respecto al borrador de Fase 0: la captura es **una sola transacción atómica** (no dos) porque la atomicidad domina a la trazabilidad-por-partes, y el modelo es "plataforma absorbe el fee del proveedor" (margen de Fluvia = Ff − Fp). El pricing quedó fijado en **2% por transacción** (PEND-002 resuelto, decisión #25, «por el momento»); Ff lo calcula el motor de fees en la captura (F4-05c, ver abajo).

**`payment.capture` (bruto M, fee proveedor Fp, fee plataforma Ff) — golden: M=100000, Fp=2900, Ff=5000 COP:**

```
debit  provider.clearing   M         (100000 — bruto por cobrar al proveedor)
debit  provider.fees       Fp        (2900   — costo de procesamiento)
credit provider.payable    Fp        (2900   — deuda con el proveedor)
credit merchant.pending    M - Ff    (95000  — pasivo con el comercio)
credit platform.fees       Ff        (5000   — ingreso Fluvia)
⇒ débitos M+Fp == créditos Fp+(M−Ff)+Ff ✓   (con Fp=Ff=0 colapsa a 2 asientos)
```

**`settlement.release` X:** `debit merchant.pending X` / `credit merchant.available X`.

**Reserva (F4-05a, `holdReserve`/`releaseReserve`, `reason='reserve'`):** aparta o libera fondos entre dos pasivos del comercio — **la obligación total con el comercio NO cambia**, solo deja de estar (o vuelve a estar) disponible para payout. Retener X: `debit merchant.available X` / `credit merchant.reserve X`; liberar X: al revés. El guard de no-negatividad (AUD-P1-010) impide reservar más de lo disponible o liberar más de lo reservado. **No depende de PEND-002** (el pricing solo bloquea el motor de fees): el monto es una entrada; la política de cuánto/cuánto tiempo es un parámetro del que llama.

**`refund.request` R:** `debit merchant.available R` / `credit refund.liability R`; **`refund.settle` R:** `debit refund.liability R` / `credit provider.clearing R`; **`refund.cancel` R** (el proveedor RECHAZÓ el refund tras reservar, F3-08): `debit refund.liability R` / `credit merchant.available R` — la reserva vuelve íntegra al comercio, sin tocar `provider.clearing` (el dinero jamás se movió del proveedor).

**Discrepancia de conciliación aceptada (F4-03b, `postReconAdjustment`):** siempre vía `recon.differences` con caso y aprobación four-eyes; nunca edición de asientos. Reconocer: `debit recon.differences X` / `credit suspense X`; revertir: al revés. Ambas platform/transitorias; NO toca saldos de comercios (el true-up de payout/settlement es F4-05). `source_type='case_adjustment'`, idempotente por caso.

**Flujo de fondos hacia afuera (F4-05b, `reason='payout'`/`'settlement'`; no depende de pricing).** El dinero capturado se convierte en CAJA de Fluvia y sale al comercio como payout: `merchant.available →(emit)→ payout.in_transit →(settle)→ platform.cash`.
- **`provider.settle` X** (`receiveProviderSettlement`): el proveedor liquida a la caja de Fluvia lo que tenía en clearing. `debit platform.cash X` / `credit provider.clearing X` (lado de CAJA de la liquidación; el lado de pasivo del comercio es `settlement.release`).
- **`payout.emit` X** (`emitPayout`): `debit merchant.available X` / `credit payout.in_transit X`. Reduce el disponible del comercio a "en tránsito" ⇒ los fondos en vuelo no se pueden re-pagar ni refundar (**no double-spend**, guard sobre `merchant.available`).
- **`payout.settle` X** (`settlePayout`): `debit payout.in_transit X` / `credit platform.cash X`. El banco confirma; el dinero sale de la caja (guard sobre `platform.cash`: no confirmar más caja de la que hay).
- **`payout.fail` X** (`failPayout`): `debit payout.in_transit X` / `credit merchant.available X`. El payout rebotó; la obligación vuelve íntegra al comercio (reverso de emit).

**Guard de no-negatividad generalizado (F4-05b):** `twoLegged` protege TODA cuenta que decrece con el asiento (pasivo debitado o activo/transitoria acreditada), calculado desde el `normal_side` del chart. Esto cubre correctamente los pares donde el riesgo está en la cuenta ACREDITADA (`provider.settle` acredita `provider.clearing`; `payout.settle` acredita `platform.cash`; `refund.settle` acredita `provider.clearing`).

## Catálogo cerrado y aprovisionamiento

`PostingService.ensureChart(tenant, merchant, moneda)` aprovisiona idempotentemente las 14 cuentas (9 platform-scope por tenant+moneda con nombre = code; 5 merchant-scope con nombre = `code:merchantId`). Solo existen las operaciones tipadas del catálogo: una combinación de cuentas fuera de él es **irrepresentable** (`UnknownAccountCodeError` para codes desconocidos). Las compensaciones usan la transacción espejo con `reverses_tx_id` (servicio de reversal: F2-07).

Los **golden tests** (`packages/ledger/test/posting.test.ts`) fijan: catálogo exactamente = 14 cuentas con semántica contable verificada (activo/gasto = debit-normal, pasivo/ingreso = credit-normal), la captura golden de arriba asiento por asiento y balance por balance, fees que consumen todo el monto rechazados, monedas mixtas rechazadas, ciclo completo captura→liquidación→refund con balances exactos y cero drift, **reserves hold/release** (reclasificación que conserva la obligación total), **payout completo** (captura→proveedor liquida a caja→disponible→emit→settle con balances exactos + fallo que devuelve al comercio + los tres guards de no-negatividad), e idempotencia end-to-end de las operaciones.

## Estado de las abstracciones contables de Fase 4 (F4-05)

- **Settlement** — construido (`releaseSettlement`, F2-04): mueve el pasivo del comercio de `pending` a `available`.
- **Reserves** — construido (`holdReserve`/`releaseReserve`, **F4-05a**): reclasifica entre `available` y `reserve`. Sin dependencia de pricing.
- **Payout** — construido (`emitPayout`/`settlePayout`/`failPayout` + `receiveProviderSettlement`, **F4-05b**): añade `platform.cash` (caja de Fluvia) y corrige `payout.in_transit` a pasivo (obligación en vuelo, tratamiento estándar; la cuenta era placeholder sin usar). Flujo `available → in_transit → cash` con no-double-spend, no-cash-underflow. Sin dependencia de pricing. **Como RECURSO gestionado** (`PayoutService`, **F4-07a**): la tabla `payouts` (migración 0033) materializa la FSM `requested → in_transit → paid | failed | indeterminate` (payment-state-machines.md §6) hecha cumplir en el motor, y el servicio orquesta las primitivas en dos fases (como refunds F3-08): `requested` valida fundabilidad (disponible − payouts `requested`) y nace; `execute` emite (`emitPayout`, guard AUD-P1-010 → `failed` si el disponible se drenó) y somete al banco (`submitPayout`); aprobado → `settlePayout` → `paid`, rechazado/circuito → `failPayout` (fondos de vuelta) → `failed`, throw/timeout/pending → `indeterminate` (fondos retenidos en tránsito; SOLO `resolveFromProvider` por fuente verificada lo cierra, V4 §23). Motor en sandbox (endpoints/UI + orquestación por worker son slices siguientes); payouts públicos/reales bloqueados hasta gates.
- **Fees** — construido (`FlatBpsFeeSchedule`, **F4-05c**; PEND-002 resuelto en 2%, decisión #25): el **motor de fees** calcula Ff en la captura como `platformFee(monto)` = 2% (200 bps, configurable por `PLATFORM_FEE_BPS`), con redondeo por mayor residuo (invariante `0 ≤ Ff ≤ monto`, `Money.allocate([bps, 10000−bps])`). La captura ya posteaba el margen `Ff−Fp`; ahora `PaymentConfirmationService` recibe un `FeeSchedule` (5.º parámetro, requerido — fail-fast, sin fee-cero silencioso en producción) y devenga `platform.fees` en cada captura. Los tests usan `ZERO_FEE_SCHEDULE`. Es «por el momento»: reemplazar el schedule (p. ej. por tiers o fee del proveedor variable) no toca el modelo contable.
