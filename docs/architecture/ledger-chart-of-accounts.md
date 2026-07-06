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
| `payout.in_transit` | Payouts in transit | Activo | debit | Payouts emitidos no confirmados |
| `suspense` | Suspense account | Transitoria | debit | Movimientos no clasificables aún; saldo objetivo = 0; alerta si envejece |
| `recon.differences` | Reconciliation differences | Transitoria | debit | Ajustes reconocidos por conciliación, siempre con caso asociado |

## Reglas de posting del MVP — IMPLEMENTADAS (F2-04; fuente de verdad: `packages/ledger/src/posting.ts`)

**Modelo contable sandbox v1 (bruto)** — desviación registrada respecto al borrador de Fase 0: la captura es **una sola transacción atómica** (no dos) porque la atomicidad domina a la trazabilidad-por-partes, y el modelo es "plataforma absorbe el fee del proveedor" (margen de Fluvia = Ff − Fp). El pricing definitivo depende de PEND-002 y del flujo de fondos de Fase 4.

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

**`refund.request` R:** `debit merchant.available R` / `credit refund.liability R`; **`refund.settle` R:** `debit refund.liability R` / `credit provider.clearing R`; **`refund.cancel` R** (el proveedor RECHAZÓ el refund tras reservar, F3-08): `debit refund.liability R` / `credit merchant.available R` — la reserva vuelve íntegra al comercio, sin tocar `provider.clearing` (el dinero jamás se movió del proveedor).

**Discrepancia de conciliación aceptada (F4-03b, `postReconAdjustment`):** siempre vía `recon.differences` con caso y aprobación four-eyes; nunca edición de asientos. Reconocer: `debit recon.differences X` / `credit suspense X`; revertir: al revés. Ambas platform/transitorias; NO toca saldos de comercios (el true-up de payout/settlement es F4-05). `source_type='case_adjustment'`, idempotente por caso.

## Catálogo cerrado y aprovisionamiento

`PostingService.ensureChart(tenant, merchant, moneda)` aprovisiona idempotentemente las 13 cuentas (8 platform-scope por tenant+moneda con nombre = code; 5 merchant-scope con nombre = `code:merchantId`). Solo existen las operaciones tipadas del catálogo: una combinación de cuentas fuera de él es **irrepresentable** (`UnknownAccountCodeError` para codes desconocidos). Las compensaciones usan la transacción espejo con `reverses_tx_id` (servicio de reversal: F2-07).

Los **golden tests** (`packages/ledger/test/posting.test.ts`) fijan: catálogo exactamente = 13 cuentas con semántica contable verificada (activo/gasto = debit-normal, pasivo/ingreso = credit-normal), la captura golden de arriba asiento por asiento y balance por balance, fees que consumen todo el monto rechazados, monedas mixtas rechazadas, ciclo completo captura→liquidación→refund con balances exactos y cero drift, e idempotencia end-to-end de las operaciones.
