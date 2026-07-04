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

## Reglas de posting del MVP (MockProvider)

**Captura exitosa de pago (monto M, fee proveedor Fp, fee plataforma Ff):**

```
debit  provider.clearing        M
credit merchant.pending         M - Fp - Ff
credit provider.fees(gasto)*    —  [MVP: Fp se registra debit provider.fees / credit provider.clearing]
credit platform.fees            Ff
```

Concretamente en el MVP (dos transacciones para trazabilidad):
1. `payment.capture`: `debit provider.clearing M` / `credit merchant.pending M`.
2. `payment.fees`: `debit merchant.pending (Fp+Ff)` / `credit provider.fees Fp` + `credit platform.fees Ff`.

**Liquidación simulada (settlement):** `debit merchant.pending X` / `credit merchant.available X`.

**Refund total o parcial R:** `debit merchant.available R` (o `merchant.pending` según estado) / `credit refund.liability R`; al confirmar el proveedor: `debit refund.liability R` / `credit provider.clearing R`.

**Discrepancia de conciliación aceptada:** siempre vía `recon.differences` con caso y aprobación; nunca edición de asientos.

## Transiciones permitidas y compensaciones

Cada regla de posting declara sus cuentas origen/destino permitidas; el `LedgerService` rechaza combinaciones fuera del catálogo (`InvalidPostingRuleError`). Las compensaciones usan la transacción espejo con `reverses_tx_id`.

Pendiente para F2: montos de ejemplo dorados (golden tests) por cada regla, incluyendo redondeo de fees por mayor residuo (auditoría D1).
