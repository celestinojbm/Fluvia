# Diseño del Ledger

Estado: Activo · Fase: 0 · ADRs relacionados: 0004 (ledger interno), 0003 (SQL explícito), 0008 (Money)

## 1. Rol

El ledger es la **fuente de verdad financiera**. Todo movimiento con significado económico (pago, refund, fee, reserva, liquidación, payout, ajuste) existe primero como transacción contable de doble partida; balances, reportes y métricas son derivados.

## 2. Modelo

```
ledger_accounts      cuenta contable por tenant, moneda y propósito
ledger_transactions  unidad atómica de posting (idempotency_key, reason, causal link)
ledger_entries       líneas débito/crédito, inmutables, amount > 0 en unidades menores
balance_projections  rollups versionados (available, pending, reserved) — derivado
```

Reglas estructurales:

- `ledger_entries.amount` es `BIGINT > 0` en unidades menores; el signo lo determina `direction` (`debit`/`credit`) contra el `normal_side` de la cuenta.
- Cada entry lleva `currency` y debe coincidir con la moneda de su cuenta (constraint + validación de servicio).
- `tx_root_id` enlaza cada entry a su transacción; `ledger_transactions` lleva enlace causal al objeto de dominio que la originó (`source_type`, `source_id`: payment_attempt, refund, adjustment…).
- Los IDs de dominio son UUID; `outbox_events` y tablas de flujo usan identity BIGINT interno.

## 3. Invariante de balanceo (V4 §17.2)

Para **cada** `ledger_transaction`: `Σ débitos = Σ créditos` **por moneda/activo**. Se aplica en tres capas:

1. Servicio (`LedgerService.postTransaction`): valida antes de tocar la base; lanza `UnbalancedLedgerError`.
2. Base de datos: `CONSTRAINT TRIGGER` diferido (`INITIALLY DEFERRED`) que al commit verifica el balanceo por (tx, currency). Nada que el ORM u otro cliente haga puede publicar una transacción desbalanceada.
3. Auditoría externa: `scripts/verify-ledger-invariants.sql` (fuera del ORM, exigido por Gate Ledger §51) recalcula balanceo y compara proyecciones, ejecutable por cron y CI.

Prohibido compensar entre monedas: un descuadre en USD jamás se "arregla" con un asiento en COP (invariante Nivel A).

## 4. Inmutabilidad y correcciones

- `ledger_entries` y `ledger_transactions` son **append-only**: triggers de base de datos bloquean UPDATE y DELETE (ya validado en el spike: `FLUVIA_IMMUTABLE`).
- Correcciones = **transacción compensatoria** con `reason` (`reversal`, `adjustment`), referencia `reverses_tx_id` al asiento original, actor y razón obligatorios, y registro de auditoría.
- La prohibición de DELETE se gobierna por clasificación de datos (`security/data-classification.md`): absoluta para ledger/auditoría/eventos financieros; con purga administrada para datos técnicos.

## 5. Posting: algoritmo normativo

```
postTransaction(tenant, idempotencyKey, reason, entries[], source):
 1. Validar entries (≥2, montos > 0, monedas soportadas) y balanceo por moneda.
 2. BEGIN; set_config('app.tenant_id', tenant, local=true).
 3. INSERT ledger_transactions ON CONFLICT (tenant_id, idempotency_key) DO NOTHING.
    Si conflicto → SELECT de la transacción existente y replay de la respuesta (idempotencia).
 4. Extraer account_ids únicos, ordenarlos de forma determinística (orden lexicográfico de UUID),
    SELECT ... WHERE id = ANY(...) ORDER BY id FOR UPDATE  (anti-deadlock, V4 §17.6).
 5. Verificar existencia, moneda y estado de cada cuenta.
 6. INSERT ledger_entries (todas las líneas).
 7. UPDATE balance_projections por cuenta con version = version + 1
    y guarda optimista (WHERE version = expected); fallo → retry limitado de toda la tx.
 8. INSERT outbox_events ('ledger.transaction.posted') en la MISMA transacción.
 9. COMMIT. El constraint diferido verifica balanceo en este punto.
```

Sin llamadas de red dentro de la transacción (invariante Nivel A). Transacción corta. Deadlocks y serialization failures (SQLSTATE 40P01/40001) se reintentan con límite e instrumentación.

## 6. Proyecciones (V4 §17.5)

- `balance_projections` guarda `available`, `pending`, `reserved` por cuenta con `version` monotónica.
- Reconstruibles desde `ledger_entries` en cualquier momento (`rebuildProjection(accountId)`); el rebuild debe coincidir exactamente con la proyección viva (test de Gate Ledger + verificación programada de drift con alerta).
- Las lecturas de balance usan la proyección; nunca se recalcula el historial completo por request.

## 7. Multimoneda

Una cuenta = una moneda. Un comercio con USD y COP tiene cuentas separadas por moneda. No existe conversión dentro del ledger; FX (futuro) será un dominio aparte con su propio modelo de precisión (V4 §16).

## 8. Pruebas exigidas (V4 §17.7)

Unit (validación/balanceo), integración con Postgres real (posting, replay idempotente, rollback), concurrencia (lock ordering, retries, N posts concurrentes con verificación de sumas — N es Nivel C, baseline en `tests/concurrency`), property-based (balanceo por transacción y activo; rebuild == proyección), compensaciones, restore. El spike ya evidencia la infraestructura de integración (RLS + inmutabilidad verdes contra PG 16).
