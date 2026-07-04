# Esquema de base de datos

Estado: Vivo · Se actualiza con cada migración. Fuente de verdad: `packages/db/migrations/*.sql`.

## Estado actual (spike de Fase 0)

Migraciones aplicadas y verificadas contra PostgreSQL 16:

| Migración | Contenido |
|-----------|-----------|
| `0001_foundation.sql` | `tenants`, `api_keys`, `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `outbox_events`, `idempotency_keys`, `payment_intents` (mínima), `raw_provider_payloads_dlq`; función `fluvia_forbid_mutation()` + triggers: DELETE/TRUNCATE bloqueados en todas las tablas core, UPDATE bloqueado en `ledger_entries`, `ledger_transactions`, DLQ |
| `0002_enable_rls.sql` | Roles `fluvia_app` (RLS forzado) y `fluvia_worker` (BYPASSRLS); grants sin DELETE; `ENABLE`+`FORCE ROW LEVEL SECURITY`; política `tenant_isolation` (`USING`/`WITH CHECK` por `app.tenant_id`); `tenants` solo self-read; `authenticate_api_key()` SECURITY DEFINER con `search_path` fijo |

Runner: `packages/db/src/migrate.ts` — orden lexicográfico, una transacción por archivo, registro en `schema_migrations`, `pg_advisory_lock` anti-concurrencia.

## Cambios ya decididos para Fase 1/2 (no aplicados)

1. `tenants` → modelo completo `organizations` + `merchants` + `users`/`memberships` (F1-03).
2. Excepción de purga administrada para `idempotency_keys` expiradas (clasificación de datos; F1-09).
3. `ledger_transactions`: columnas `source_type`, `source_id`, `reverses_tx_id` (F2-01).
4. `balance_projections` como tabla separada de `ledger_accounts` (F2-03) — el spike cachea en la propia cuenta; la separación aísla el derivado de la definición.
5. Constraint trigger diferido de balanceo por (tx, moneda) (F2-02).
6. Tablas de inbox (`provider_events`) y webhooks salientes (F3).

## Convenciones para toda migración futura

Ver `data-model.md` §2. Además: migraciones expand-and-contract (nunca destructivas automáticas), dry-run en CI contra base con datos, y toda tabla nueva declara en el PR su clasificación de datos y si es tenant-scoped (RLS) o global.
