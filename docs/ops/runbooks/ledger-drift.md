# Runbook · Drift contable (proyección ≠ ledger)

**Alerta**: `fluvia_ledger_projection_drift_accounts > 0` · **Sev**: **CRÍTICA (SEV-1)** — integridad financiera comprometida.

**Qué significa**: el `ProjectionDriftWatcher` del worker ejecutó `ledger_projection_drift()` (migración 0011, `SECURITY DEFINER`, solo `fluvia_worker`) y encontró al menos una cuenta cuyo `balance_projections` **no coincide** con el recálculo desde `ledger_entries`. La proyección es un derivado; el ledger (append-only) es la verdad. Un drift = un derivado corrupto o una proyección que no se aplicó.

> **INVESTIGAR ANTES DE REPARAR (V4 §30).** El watcher lo dice explícitamente: `"LEDGER PROJECTION DRIFT DETECTED — investigate before any rebuild"`. Un rebuild ciego **borra la evidencia** de la causa. La reparación es SIEMPRE explícita y posterior al diagnóstico.

## Contención

1. Trátalo como **SEV-1**: activa `incident-response.md`. Si el drift afecta cuentas de un comercio/plataforma con flujo activo, considera **congelar** ese flujo antes de investigar a fondo.
2. **No** ejecutes ningún rebuild todavía. **No** toques `ledger_entries` ni `balance_projections` con SQL manual.

## Diagnóstico

1. Identifica las cuentas afectadas: cada fila de `ledger_projection_drift()` trae `account_id, tenant_id, projected_available, projected_pending, recomputed_available, recomputed_pending`. Un `projected_*` **NULL** = la cuenta tiene asientos pero **ninguna fila de proyección** (se materializa en el rebuild) — menos grave que un valor divergente.
2. Corre el invariante externo al ORM: `scripts/verify-ledger-invariants.sql` (el mismo que corre en CI). Si reporta **asientos desbalanceados** (débitos ≠ créditos en una `tx`), el problema es **más profundo que la proyección**: es corrupción del ledger → SEV-1 máximo, NO lo arregles con un rebuild (el rebuild recomputa desde entries; si los entries están mal, propaga el error).
3. Correlaciona por tiempo con el `audit_log` (**Eventos**) y los logs: ¿coincide con un despliegue, un ajuste de conciliación (`case_adjustment.applied`), una compensación, un crash del worker a mitad de posting?
4. Verifica que el watcher venía corriendo (que el drift es nuevo, no acumulado por un watcher caído): `increase(fluvia_ledger_projection_drift_checks_total[10m]) > 0`. Si estaba detenido, ver [`worker-down.md`](./worker-down.md).

## Resolución

**Solo si** el invariante SQL confirma que los `ledger_entries` están **sanos** (balanceados) y la divergencia está **únicamente** en la proyección:

- Reparar por la **única vía sancionada**: `LedgerService.rebuildProjection(tenantId, accountId)` (`packages/ledger/src/service.ts`). Recomputa `available`/`pending` desde `ledger_entries` **bajo el mismo lock por cuenta** que el posting, hace upsert de la proyección y **sube `version`** (cualquier posting en vuelo con versión vieja reintenta). Devuelve `{ accountId, drifted, before, after }`.
- **No existe aún** ni script ni ruta HTTP para el rebuild: es un método de servicio que se invoca **programáticamente contra el admin pool**, deliberadamente, cuenta por cuenta, tras el diagnóstico. (Una herramienta de operación para esto es trabajo futuro — F6.)

Si los `ledger_entries` están **corruptos** (desbalanceados): NO rebuild. Es corrupción de la fuente de verdad → post-mortem SEV-1, corrección por compensación explícita con four-eyes, y análisis de cómo se publicó un asiento desbalanceado (el constraint trigger diferido F2-02 debería haberlo impedido).

## Verificación

1. Tras el rebuild, `ledger_projection_drift()` no devuelve la cuenta; `fluvia_ledger_projection_drift_accounts` vuelve a 0 en el siguiente ciclo (default 60 s).
2. `scripts/verify-ledger-invariants.sql` pasa limpio.
3. El post-mortem documenta la causa raíz (no solo «se hizo rebuild») y una acción de backlog para evitar la recurrencia.

## Escalación

Cualquier drift que no se explique por «proyección no aplicada» (p. ej. entries desbalanceados, o drift que reaparece tras el rebuild) es un **incidente de integridad abierto**: mantener SEV-1, no cerrar hasta causa raíz.

## Drill (F4-06b)

Pendiente: en BD efímera, sembrar drift (desincronizar una proyección) → confirmar la alerta y el log del watcher → correr el invariante SQL → `rebuildProjection` → verificar drift=0. (La property test `packages/ledger/test/drift.test.ts` ya ejerce rebuild bajo concurrencia.)
