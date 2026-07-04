# Modelo de datos

Estado: Activo · Fase: 0 · Detalle DDL en `database-schema.md` cuando cada módulo se implemente

## 1. Agrupación por dominio

**Identidad y tenancy**
`platforms` (single-row inicial) → `organizations` → `merchants`; `users`, `memberships` (user↔org con rol), `roles`/`permissions` (RBAC), `api_keys` (hash, scopes, entorno), `sessions`, `audit_events`.

**Clientes y métodos**
`customers` (por merchant), `payment_method_tokens` (referencia tokenizada del proveedor, nunca PAN/CVV), `customer_provider_mappings`.

**Pagos**
`payment_intents` (FSM propia), `payment_attempts` (FSM propia, N por intent), `authorizations`, `captures`, `refunds` (FSM propia), `disputes` (modelo presente, programa fuera del MVP), `checkout_sessions`, `payment_links`.

**Proveedores**
`provider_accounts` (credenciales cifradas por tenant/entorno), `provider_transactions` (espejo normalizado de lo que el proveedor reporta), `provider_events` (inbox: raw + dedup), `raw_provider_payloads_dlq`.

**Ledger**
`ledger_accounts`, `ledger_transactions`, `ledger_entries`, `balance_projections` (ver `ledger-design.md`).

**Mensajería**
`outbox_events`, `webhook_endpoints`, `webhook_events`, `webhook_attempts`, `idempotency_keys`.

**Operaciones**
`reconciliation_batches`, `reconciliation_items`, `operational_cases`, `risk_decisions`.

## 2. Convenciones transversales

| Convención | Regla |
|------------|-------|
| PK | UUID `gen_random_uuid()` (no secuencial, no filtra volumen ni orden) |
| IDs públicos | El API expone el UUID con prefijo de recurso: `pi_…`, `cus_…`, `re_…`, `whk_…`, `ak_…` |
| Tenancy | Toda tabla tenant-scoped lleva `tenant_id`(=organization) y cuando aplica `merchant_id`; RLS activo y forzado |
| Dinero | `BIGINT` unidades menores + `currency CHAR(3)`; jamás float/numeric ambiguo |
| Tiempo | `TIMESTAMPTZ` siempre; el servidor opera en UTC |
| Borrado | Según clasificación: financiero/auditoría append-only (triggers); técnico con `deleted_at` o purga administrada |
| Integridad | FKs siempre; unique compuestos con `tenant_id`; CHECK constraints para enums de estado |
| Versionado | Filas con FSM u optimistic locking llevan `version BIGINT` |
| Metadata | `metadata JSONB` validada con schema y límite de tamaño; nunca datos sensibles |

## 3. Relaciones causales obligatorias

Cadena de trazabilidad de un pago (V4 §17.1 "trazabilidad causal"):

```
payment_intent → payment_attempt → provider_transaction → provider_event (inbox)
      │                                    │
      └── ledger_transactions (source_type/source_id) ── ledger_entries
                        │
                        └── outbox_events → webhook_events → webhook_attempts
```

Toda `ledger_transaction` referencia su origen de dominio; toda transición de FSM registra el evento/actor que la causó. La conciliación (Fase 4) recorre esta cadena en ambas direcciones.

## 4. Estado actual

Implementado en el spike (sujeto a revisión en F1/F2): `tenants` (se renombrará a `organizations` en F1 con la entidad completa), `api_keys`, `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `outbox_events`, `idempotency_keys`, `payment_intents` (mínima), `raw_provider_payloads_dlq`, con RLS + triggers de inmutabilidad verdes contra PG16. El resto se crea por fase según `agents/BACKLOG.md`.
