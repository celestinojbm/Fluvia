# Esquema de base de datos

Estado: Vivo · Se actualiza con cada migración. Fuente de verdad: `packages/db/migrations/*.sql`.

## Estado actual (spike de Fase 0)

Migraciones aplicadas y verificadas contra PostgreSQL 16:

| Migración | Contenido |
|-----------|-----------|
| `0001_foundation.sql` | `tenants`, `api_keys`, `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `outbox_events`, `idempotency_keys`, `payment_intents` (mínima), `raw_provider_payloads_dlq`; función `fluvia_forbid_mutation()` + triggers: DELETE/TRUNCATE bloqueados en todas las tablas core, UPDATE bloqueado en `ledger_entries`, `ledger_transactions`, DLQ |
| `0002_enable_rls.sql` | Roles `fluvia_app` (RLS forzado) y `fluvia_worker` (BYPASSRLS); grants sin DELETE; `ENABLE`+`FORCE ROW LEVEL SECURITY`; política `tenant_isolation` (`USING`/`WITH CHECK` por `app.tenant_id`); `tenants` solo self-read; `authenticate_api_key()` SECURITY DEFINER con `search_path` fijo |
| `0003_identity_tenancy.sql` | **F1-03**: `tenants`→`organizations` (rename + `slug` único con backfill); `users` (global, unique por `lower(email)`), `memberships` (rol RBAC, unique tenant+user), `merchants` (país/moneda default CO/COP, status active/frozen); triggers de inmutabilidad; RLS: `tenant_isolation` en memberships/merchants y política especial `user_visible_via_membership` en `users` (SELECT solo con membresía activa compartida; sin política de escritura → INSERT/UPDATE denegado al rol app); `authenticate_api_key()` recreada contra `organizations` |
| `0004_auth_sessions.sql` | **F1-04a**: `sessions` (token solo como SHA-256, expiración, revocación, ip/UA), `email_verification_tokens` (un solo uso), lockout en `users` (`failed_login_attempts`, `locked_until`); rol **`fluvia_auth`** — único con acceso a users/sessions/tokens (política `auth_plane_access` acotada al rol); acceso de `fluvia_app`/`fluvia_worker` a sessions/tokens REVOCADO; `auth_list_memberships()` SECURITY DEFINER para elegir contexto de tenant tras login |
| `0005_api_key_scopes.sql` | **F1-04c**: `api_keys` + `scopes TEXT[]`, `environment` (test/live), `key_prefix` visible, `created_by_user_id`, `last_used_at`; `authenticate_api_key()` recreada (DROP+CREATE por cambio de retorno) devolviendo scopes+environment y tocando `last_used_at` con throttle de 60s |
| `0006_audit_log.sql` | **F1-05**: `audit_events` append-only (triggers UPDATE/DELETE/TRUNCATE + sin grant de UPDATE): actor, tenant, acción, recurso, resultado, risk_level, razón, before/after redactados, ip/UA/request_id; RLS: `tenant_isolation` para el plano app y política `auth_plane_audit` (INSERT-only, solo eventos sin tenant) para `fluvia_auth` |
| `0007_ledger_core.sql` | **F2-01/F2-02**: `ledger_transactions` + `source_type`/`source_id`/`reverses_tx_id` (enlace causal y de reversión, catálogo de reasons ampliado); `balance_projections` separada (backfill + contracción de `ledger_accounts` a pura definición) con RLS+inmutabilidad; **constraint triggers diferidos**: `ledger_entries_balanced` (balanceo por tx y moneda al COMMIT — imposible desbalancear incluso como superusuario) y `ledger_transactions_nonempty` (sin cabeceras huérfanas) |

| `0046_pos_sale_single_charge.sql` | **POS — una venta, como máximo un cobro exitoso** (no destructiva, sin reescritura de filas). `payment_links` + `single_charge` (default `false` = multiuso de siempre; inmutable por trigger) + `checkout_tracking_since` (`now()` STABLE: filas existentes = instante de la migración, nuevas = su creación; `created_at < checkout_tracking_since` ⇒ historial de la venta PARCIAL). `payment_intents` + `payment_link_id` (FK compuesta `(payment_link_id, tenant_id)` → no cruza tenant; NULL = intent directo o anterior) + `single_charge_link_id` DERIVADA por trigger `BEFORE INSERT` desde la política del link (el caller no puede fijarla; ambas inmutables). **Invariante en el motor**: índice ÚNICO parcial `payment_intents_single_charge_uq (single_charge_link_id)` para todo estado salvo `created`/`requires_*`/`failed`/`canceled` — dos intents de la misma venta no pueden estar a la vez cobrando o cobrados; un desenlace incierto (`processing`) retiene la venta. Sin tablas nuevas: clasificación y RLS heredadas (`payment_links`/`payment_intents`, tenant-scoped, RLS forzado). |
| `0047_pos_sale_release_guard.sql` | **POS — cierre de dos huecos de 0046** (no destructiva). (1) Trigger `payment_intents_single_charge_release_guard` (`BEFORE UPDATE OF status`), solo para intents de cobro único: estado que retiene la venta → `canceled` RECHAZADO (una cancelación local de `authorized` no anula nada en el proveedor); → `failed` solo con attempt `failed` y ningún attempt vivo/cobrado. Vale para servicio, ruta y SQL directo con `fluvia_app`; los links multiuso no cambian y la FSM tampoco. (2) `fluvia_payment_intent_link_derive()` falla CERRADO (`FLUVIA_LINK_NOT_VISIBLE`) si el invocador no ve el link declarado (antes dejaba `single_charge_link_id` NULL y el intent escapaba del índice); `search_path` fijado y nombres calificados en las tres funciones. |

Runner: `packages/db/src/migrate.ts` — orden lexicográfico, una transacción por archivo, registro en `schema_migrations`, `pg_advisory_lock` anti-concurrencia.

## Cambios ya decididos para Fase 1/2 (no aplicados)

1. ~~`tenants` → modelo completo (F1-03)~~ **Aplicado en `0003_identity_tenancy.sql`.**
2. Excepción de purga administrada para `idempotency_keys` expiradas (clasificación de datos; F1-09).
3. ~~`ledger_transactions` causal + `balance_projections` + constraint de balanceo~~ **Aplicado en `0007_ledger_core.sql`.**
4. Tablas de inbox (`provider_events`) y webhooks salientes (F3).

## Convenciones para toda migración futura

Ver `data-model.md` §2. Además: migraciones expand-and-contract (nunca destructivas automáticas), dry-run en CI contra base con datos, y toda tabla nueva declara en el PR su clasificación de datos y si es tenant-scoped (RLS) o global.
