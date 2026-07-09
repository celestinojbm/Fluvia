# Estrategia de conciliación

Estado: Activo · Fase: 0 · La conciliación es obligatoria (V4 §30) y llega en Fase 4; el modelo de datos se prepara desde Fase 2.

> **Estado de implementación (AUD-P3-002, 2026-07-04): DISEÑO — nada construido.** No existe ningún job ni tabla de conciliación. Lo único vigente es la preparación del modelo: enlace causal `source_type/source_id` y `reverses_tx_id` en el ledger (F2-01) y `verifyProjection` (replay proyección↔entries). El resto llega en Fase 4.

## 1. Qué se compara

Tres planos que deben contar la misma historia:

1. **Dominio Fluvia**: payment_intents, attempts, refunds y sus FSM.
2. **Ledger**: ledger_transactions/entries y proyecciones de balance.
3. **Proveedor**: provider_transactions, provider_events y reportes (en MVP, el "reporte de liquidación" generado por el MockProvider, deliberadamente con discrepancias inyectables para probar el pipeline).

## 2. Verificaciones

- **Integridad interna continua** (desde F2, no espera a F4): balanceo por transacción y moneda (constraint diferido + script SQL externo al ORM), proyección == rebuild desde entries (drift check programado), outbox sin eventos envejecidos.
- **Cruce dominio↔ledger**: todo intent `succeeded` tiene sus asientos de captura/fees; todo refund `succeeded` tiene compensación; nada de asientos huérfanos sin objeto de dominio.
- **Cruce Fluvia↔proveedor** (batch): por referencia externa — faltantes en un lado, duplicados, diferencias de monto/moneda/fee, estados incompatibles, fechas fuera de ventana (normalización a UTC conservando la fecha cruda del proveedor), referencias desconocidas.

## 3. Casos, no parches

Cada discrepancia crea un `reconciliation_item` → `operational_case` con severidad, dueño, evidencia (payloads/asientos vinculados), estado y resolución. **Prohibida la corrección silenciosa**: todo ajuste pasa por asiento en `recon.differences` con caso, razón, actor y aprobación (four-eyes para montos sobre umbral, Nivel C).

**F4-03a** implementa la materialización: un trigger `AFTER INSERT` sobre `reconciliation_entries` (0029) crea un `operational_case` por cada entry `!= matched`, para AMBAS vías de conciliación (motor per-tenant F4-01a y barrido F4-02) sin duplicar lógica y de forma atómica. Severidad por clase: `missing_in_ledger` → **critical** (el proveedor liquidó dinero que Fluvia no ve), `amount_mismatch`/`missing_at_provider` → **high**. Ciclo de vida `open → acknowledged → resolved` con `OperationalCaseService` (RLS por tenant, auditoría `operational_case.*` por transición). **Resolver (F4-03a) es DOCUMENTAL — NO mueve dinero**: registra la disposición del operador.

**F4-03b** implementa el **ajuste monetario con four-eyes** (0030): un `case_adjustment` es la AUTORIZACIÓN de un ajuste sobre un caso. Lo **propone** un humano (`proposed_by_user_id` NOT NULL) y, sobre `FOUR_EYES_THRESHOLD_MINOR` (default 0 = SIEMPRE), lo **aprueba** un SEGUNDO humano distinto — el four-eyes es un **CHECK en la BD** (`approved_by <> proposed_by`), no solo del servicio. Al aprobarse, `CaseAdjustmentService` postea un **asiento compensatorio real** `recon.differences ↔ suspense` (vía `PostingService.postReconAdjustment`, `reason='reconciliation'`, `source_type='case_adjustment'`) y resuelve el caso — TODO en UNA transacción (`onPosted` del ledger), idempotente por `case_adj:{id}`. **Invariante Nivel A**: ni la IA/máquina (`actorType='api_key'` → rechazado) ni un solo humano autorizan dinero real sobre umbral. El asiento NO toca saldos de comercios (el true-up de payout/settlement es F4-05, contable, bloqueado).

**F4-03c** expone la operación por SESIÓN (plano humano del panel): rutas `/v1/organizations/:orgId/operational_cases/*` (list/detail + acknowledge/resolve) y `/case_adjustments/*` (propose/approve/reject), bajo el permiso RBAC nuevo `reconciliation:manage` (owner/admin/finance). El **four-eyes es REAL sobre HTTP**: dos miembros distintos con el permiso — U1 propone, U1 no puede aprobar (409 `four_eyes_required`), U2 aprueba y aplica. Una API key jamás alcanza este plano (autorizar dinero es humano).

**F4-03c-ii** expone esta operación en el **panel** (`apps/dashboard`): enlace «Casos» → lista filtrable por estado → detalle del caso con la discrepancia ledger/proveedor, la tabla de ajustes y las acciones (acknowledge/resolve del caso; propose/**approve**/reject del ajuste). Las acciones son islas cliente que POSTean a route handlers server-side; estos reenvían la cookie httpOnly `fluvia_session` como `Bearer` (el navegador nunca sostiene el token) — el mismo patrón que el reenvío de webhooks `dead` (F3-09b-iii). El **four-eyes se hace visible**: aprobar el propio ajuste devuelve 409 `four_eyes_required`, que el proxy transmite tal cual y la UI muestra como un mensaje específico (no un error genérico); las acciones solo aparecen para roles con `reconciliation:manage` (hint de UX — el API decide). i18n es/en y WCAG AA, con tests CI-gated (jsdom + axe); el E2E de navegador full-stack es local. Con esto **F4-03c queda completo**.

## 4. Cadencia

- Continua: invariantes internas y drift de proyecciones (alerta < 5 min).
- Programada: batch contra reportes del proveedor (diaria en sandbox). **F4-02**: el `ReconciliationWatchdog` del worker invoca `sweep_settlement_reports()` (0028, SECURITY DEFINER, EXECUTE solo para `fluvia_worker`) en un intervalo y concilia automáticamente los reportes cuyo periodo YA CERRÓ (`open` + `period_end <= now()`) — la conciliación pasa de "a demanda" (F4-01b) a "continua". Idempotente con la conciliación manual (ambas bajo el guard `status='open'`), lease vía `FOR UPDATE SKIP LOCKED`, clasificación idéntica al motor per-tenant; toda discrepancia levanta alerta (`observability.md` §4).
- Bajo demanda: por operación desde el panel admin (investigación).

Un recálculo nocturno **no** es la única defensa (V4 §30): las invariantes internas corren continuamente.

## 5. Gate Conciliación (§51)

Prueba obligatoria: archivo simulado con discrepancias conocidas → produce exactamente los casos esperados, ninguna corrección silenciosa, evidencia de resolución trazable. Implementación y evidencia en Fase 4 (F4-01/F4-02 del backlog). F4-01 (motor + API + vista) y F4-02 (barrido continuo del worker) ya producen las 4 clases de discrepancia contra PG real; los `operational_case`/four-eyes de resolución quedan para F4-03.
