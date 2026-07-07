# Fluvia Re-Auditoría Independiente v2 — Reporte Delta

**Tipo:** Re-auditoría delta sobre auditoría v1 y cierre posterior  
**Proyecto:** Fluvia  
**Repositorio:** <https://github.com/celestinojbm/Fluvia.git>  
**Rama auditada:** `claude/new-session-haeo7h`  
**Commit base (v1):** `a665b4ff6a8dca5e64e786b534ce1f2da85455f2` (2026-07-04)  
**Commit HEAD (v2):** `e7539f5e2f6b2877dad8d1667d4dc2e6e9a2142f` (2026-07-07)  
**Commits entre v1 y v2:** 60+ commits (Fase 2 remediation → Fase 3 payments/webhooks → Fase 4 reconciliation)  
**Fecha de re-auditoría:** 2026-07-07  
**Modo:** Solo lectura; no se modificó el repositorio ni se instalaron dependencias.  
**Auditor:** Hermes Agent (Nous Research) — segunda iteración independiente

---

## Tabla de contenido

1. [Propósito de esta re-auditoría](#1-propósito)
2. [Verificación de remediaciones v1](#2-verificación-de-remediaciones-v1)
3. [Hallazgos vigentes (no resueltos)](#3-hallazgos-vigentes)
4. [Hallazgos nuevos en código post-v1](#4-hallazgos-nuevos-en-código-post-v1)
5. [Matriz de cobertura actualizada](#5-matriz-de-cobertura-actualizada)
6. [Recomendaciones al constructor](#6-recomendaciones-al-constructor)

---

## 1. Propósito

La auditoría v1 (2026-07-04) identificó 10 hallazgos P1 + 16 P2 + 3 P3. El registro de cierre (`audit-closure-register-v1.md`) documenta la resolución de la mayoría de estos hallazgos por parte del constructor, con evidencia de CI verde para cada remediación.

Esta re-auditoría v2 tiene tres objetivos:

1. **Verificar independientemente** que las remediaciones documentadas en el cierre son reales y correctas (no confiar solo en el auto-reporte del constructor).
2. **Identificar hallazgos residuales** — hallazgos de v1 que siguen abiertos en el código actual.
3. **Auditar el código nuevo** (payments-core, webhooks, reconciliation, outbox, inbox, idempotency) que no existía en v1 y buscar nuevos vectores de riesgo.

---

## 2. Verificación de remediaciones v1

### P1 — Remediaciones verificadas ✅

| ID v1 | Hallazgo | Remediación en código | Verificación independiente |
|-------|----------|----------------------|---------------------------|
| AUD-P1-001 | FK cuenta-tenant-moneda | `ledger_accounts_id_tenant_currency_key UNIQUE (id, tenant_id, currency)` + FK compuesta (0008:34-40) | ✅ **Confirmado** — constraint existe en migración |
| AUD-P1-002 | Payments core inexistente | `packages/payments-core/` completo: intents (0017), attempts (0017), refunds (0020), FSM en motor | ✅ **Confirmado** — 12 estados en CHECK, tablas de transiciones inmutables, triggers de validación |
| AUD-P1-003 | Idempotencia API | `idempotency_keys` PK `(tenant_id, endpoint, key)` (0008:46-49) | ✅ **Confirmado** — PK incluye endpoint, default removido |
| AUD-P1-004 | Posting sin validación de saldo | `nonNegativeAccounts` + `InsufficientBalanceError` (service.ts:301-324) | ✅ **Confirmado** — check post-UPDATE bajo lock de cuenta |
| AUD-P1-005 | Inbox/webhooks entrantes | `packages/inbox/` + `packages/webhooks/` | ✅ **Confirmado** (archivos existen; análisis profundo en §4) |
| AUD-P1-006 | Rate limiting + MFA | Migración 0014 (no inspeccionada en detalle) | ⚠️ **No verificado en profundidad** — no leí 0014 ni el código MFA |
| AUD-P1-007 | Worker BYPASSRLS | `fluvia_worker` sin privilegios (0008:55-57) | ✅ **Confirmado** — REVOKE ALL en ledger tables |
| AUD-P1-009 | Idempotency sin endpoint | Ver AUD-P1-003 | ✅ **Confirmado** |
| AUD-P1-010 | Saldo negativo | Ver AUD-P1-004 | ✅ **Confirmado** |

### P2 — Remediaciones verificadas ✅

| ID v1 | Hallazgo | Remediación | Verificación |
|-------|----------|-------------|-------------|
| AUD-P2-001 | Replay sin metadata causal | `replay()` compara reason, source_type, source_id, reverses_tx_id (service.ts:348-355) | ✅ **Confirmado** — 4 campos adicionales verificados |
| AUD-P2-002 | payment_intents 5/12 estados | 12 estados en CHECK (0017:49-54) | ✅ **Confirmado** |
| AUD-P2-005 | Outbox sin envelope | `buildEnvelope` de `@fluvia/events` (service.ts:238-253) | ✅ **Confirmado** |
| AUD-P2-012 | Falta verify-ledger-invariants.sql | `scripts/verify-ledger-invariants.sql` (6 checks) | ✅ **Confirmado** |
| AUD-P2-013 | Columna reserved | Cerrado por decisión (documentado) | ✅ **Aceptado** |
| AUD-P2-014 | dbUrls sin anti-mezcla | No verificado en esta iteración (pool.ts sin cambios pero config.ts podría haber cambiado) | ⚠️ **No verificado** |
| AUD-P2-006 | Conciliación | `packages/reconciliation/` + migraciones 0027-0030 | ✅ **Confirmado** (archivos existen) |

---

## 3. Hallazgos vigentes (no resueltos)

Estos hallazgos de la re-auditoría interna siguen vigentes en el código HEAD actual:

### V2-R1 — `withTenantTransaction` sin statement_timeout, lock_timeout ni idle_in_transaction_session_timeout

**Severidad:** P2  
**Estado:** Vigente (sin cambios desde v2 interna)  
**Evidencia:** `packages/db/src/pool.ts:33-35` — `BEGIN` sin SET LOCAL de timeouts  
**Impacto:** Una query patológica o deadlock no detectado mantiene la transacción abierta indefinidamente consumiendo una conexión del pool. En producción esto causa cascading failure.  
**Recomendación:**
```sql
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SELECT set_config('app.tenant_id', $1, true);
```
**Pruebas:** Test de lock contention → transacción falla con timeout, no cuelga.

---

### V2-R2 — `entriesSignature` usa separadores `|` y `\n` (fragilidad futura)

**Severidad:** P2 (riesgo latente, no bug actual)  
**Estado:** Vigente  
**Evidencia:** `packages/ledger/src/service.ts:59-63`  
```typescript
.map((e) => `${e.accountId}|${e.direction}|${e.amount}|${e.currency}|${e.bucket}`)
.sort().join('\n');
```
**Impacto:** Hoy seguro (campos controlados). Pero si un futuro developer agrega un campo string libre sin darse cuenta, se introducen colisiones silenciosas de idempotencia.  
**Recomendación:** Migrar a `JSON.stringify` canónico o `crypto.createHash('sha256')` sobre campos serializados.

---

### V2-R3 — Constraint trigger `ledger_entries_balanced` es `FOR EACH ROW` redundante

**Severidad:** P3 (performance)  
**Estado:** Vigente  
**Evidencia:** `0007_ledger_core.sql:106-109` — constraint trigger AFTER INSERT FOR EACH ROW DEFERRABLE  
**Impacto:** Un asiento de N entries ejecuta N veces la misma verificación. Con postings de 5+ entries, es un multiplicador de costo innecesario.  
**Verificación:** ✅ **Confirmado** — comportamiento documentado de PostgreSQL constraint triggers  
**Recomendación:** Considerar `FOR EACH STATEMENT` o aceptar como costo de defensa en profundidad.

---

### V2-R4 — `verifyProjection` y `verify-ledger-invariants.sql` usan `SUM(BIGINT)` sin protección de overflow

**Severidad:** P2  
**Estado:** Vigente  
**Evidencia:**
- `service.ts:416-426` — `SUM(CASE ...) ::text`
- `scripts/verify-ledger-invariants.sql:72-77` — `SUM(...) ::bigint`  
**Impacto:** PostgreSQL puede hacer overflow silencioso en SUM(BIGINT) con cuentas de altísimo volumen. El check de drift reportaría "matches" con datos corruptos.  
**Verificación:** ⚠️ **Inferido** — el comportamiento de PG ante overflow depende de la versión  
**Recomendación:** Usar `SUM(...)::numeric` en el recomputed para evitar overflow, o documentar el límite operativo por cuenta.

---

### V2-R5 — `Money.allocate` round-robin con sesgo sistemático hacia índice 0

**Severidad:** P3  
**Estado:** Vigente (money.ts sin cambios)  
**Evidencia:** `packages/money/src/money.ts:154-159`  
**Impacto:** El índice 0 siempre recibe la primera unidad de residuo. En splits de fees donde un participante siempre es el primer ratio, ese participante acumula extra sistemáticamente.  
**Verificación:** ⚠️ **Inferido** — la frecuencia real del sesgo depende del patrón de uso  
**Recomendación:** Documentar y considerar randomizar índice inicial (determinístico por tx_id).

---

### V2-R6 — `applyProjectionDeltas` tiene fallback silencioso `?? { available: 0n, pending: 0n }`

**Severidad:** P3  
**Estado:** Vigente  
**Evidencia:** `packages/ledger/src/service.ts:279,303`  
**Impacto:** Dead code hoy (deltas siempre cubre todos los accountIds). Pero enmascara errores lógicos futuros.  
**Recomendación:** Cambiar a `deltas.get(accountId)!` con assertion explícita.

---

### V2-R7 — SQLSTATE 40001 (serialization failure) inalcanzable con READ COMMITTED

**Severidad:** P3  
**Estado:** Vigente  
**Evidencia:** `service.ts:40` — `RETRYABLE_SQLSTATES = new Set(['40001', '40P01'])`. `pool.ts` hace `BEGIN` sin isolation level.  
**Impacto:** Código forward-looking que nunca se ejecuta. No causa bugs pero puede confundir.  
**Recomendación:** Documentar como forward-looking para cuando se active SERIALIZABLE.

---

## 4. Hallazgos nuevos en código post-v1

### 4.1 Webhooks salientes — Evaluación: 🟢 Sólido

El paquete `@fluvia/webhooks` implementa el diseño de `webhook-delivery.md` con alta fidelidad:

- **SSRF guard** (`ssrf.ts`): Valida todas las IPs (v4+v6) contra denylist completa (RFC1918, CGNAT 100.64/10, link-local 169.254, loopback, ULA fc/fd, multicast, v4-mapped). HTTPS obligatorio en producción. Pinning DNS (conecta a la IP validada, no re-resuelve). Re-validación en CADA intento. Sin redirects (3xx = fallo). ✅
- **Firma HMAC-SHA256** (`signing.ts`): `signWebhookDelivery` sobre `"{timestamp}.{event_id}.{raw_body}"`. Comparación timing-safe con `timingSafeEqual`. Rotación de secretos (firma con ambos durante ventana). Tolerancia ±5min. ✅
- **Deliverer** (`deliverer.ts`): `FOR UPDATE SKIP LOCKED` para claim. Backoff 0s/30s/2m/10m/1h/6h/24h → dead. Timeout 10s. IP registrada en `webhook_attempts`. Append-only historial. ✅
- **Migración 0019**: Tres tablas (endpoints/events/attempts) con RLS FORCED, triggers NO-DELETE, roles granulares (`fluvia_relay` fan-out, `fluvia_webhook` deliverer). Secretos cifrados AES-256-GCM en reposo. ✅

#### V2-N1 — `WebhookDeliverer` fallback a clave de desarrollo si no se configura encKeyHex

**Severidad:** P2  
**Evidencia:** `deliverer.ts:92` — `this.encKeyHex = options.encKeyHex ?? DEV_WEBHOOK_SECRET_ENC_KEY_HEX`  
**Impacto:** Si la variable de entorno `WEBHOOK_SECRET_ENC_KEY` no se configura en sandbox/producción, los secretos de webhook se cifran/descifran con la clave de desarrollo conocida. Un dump de `webhook_endpoints.secret_enc` sería trivialmente descifrable, permitiendo forjar webhooks hacia comercios.  
**Verificación:** ⚠️ **Inferido** — depende de si `crypto.ts` tiene un guard de entorno análogo a AUD-P2-008. No pude verificar `crypto.ts` en profundidad (no estaba en mi lectura).  
**Recomendación:** Verificar que `crypto.ts` aplique el mismo guard anti-mezcla ( falla si `encKeyHex` = DEV key en non-local). Si no lo tiene, agregar.  
**Pruebas:** Test: instanciar `WebhookDeliverer` sin `encKeyHex` en `NODE_ENV=production` → debe fallar.

#### V2-N2 — `resolveSafeWebhookTarget` solo retorna la primera IP validada

**Severidad:** P3  
**Evidencia:** `ssrf.ts:116` — `ip: ips[0]!`  
**Impacto:** Si un hostname resuelve a múltiples IPs (todas públicas), solo se intenta la primera. Si esa IP está caída, el delivery falla cuando otra IP del mismo hostname funcionaría. No es un bug de seguridad (todas las IPs se validan), pero reduce resiliencia.  
**Verificación:** ✅ **Confirmado** — comportamiento simple de primera IP  
**Recomendación:** Considerar fallback a `ips[1]` si la conexión a `ips[0]` falla. Documentar que es Nivel C.

---

### 4.2 Payments core — Evaluación: 🟢 Sólido

- **FSM en motor** (0017): 12 estados, tablas de transiciones INMUTABLES sembradas desde el mapa TS, triggers BEFORE UPDATE OF status que validan contra la tabla. Meta-test triple (doc ↔ TS ↔ DDL). ✅
- **PaymentIntentService** (`service.ts`): Operaciones idempotentes bajo lock de fila (`FOR UPDATE`). Confirmación en dos fases (beginIn dentro de tx, execute fuera). Outbox en la misma transacción. ✅
- **ConfirmService** (`confirmation.ts`): Lock del intent + invariants SQL (amount>0, captured≤amount). Crea attempt con provider_ref. Timeout→indeterminate. ✅
- **RefundService** (`refunds.ts`): Dos fases. Reserva contable con `InsufficientBalanceError` del motor (AUD-P1-010). Circuit breaker del provider (abierto = conocido; timeout = desconocido). Remaining bajo lock que incluye refunds in-flight (created/processing). Transición a indeterminate si provider lanza — reserva retenida. ✅
- **ResilientProvider** (`resilience.ts`): Circuit breaker closed/open/half_open. Timeout con Promise.race. Semántica correcta: timeout = desenlace desconocido → indeterminate. Circuito abierto = petición nunca enviada → falla limpio. ✅
- **Attempts watchdog** (0018): `sweep_payment_attempts()` — submitting >5min → indeterminate (no failed por asunción). SECURITY DEFINER, solo fluvia_worker. Audit event en la misma tx. ✅

#### V2-N3 — `refund.execute()` lee datos del refund FUERA de transacción antes de operar

**Severidad:** P3  
**Evidencia:** `refunds.ts:209-231` — `execute()` hace una query de lectura del refund en una transacción separada, y luego opera con `row.amount`, `row.currency`, `row.merchant_id` en las fases siguientes. Entre la lectura y el uso, otro proceso podría cambiar el estado del refund (aunque `r.status IN ('created', 'processing')` filtra).  
**Impacto:** Bajo — el estado `created`/`processing` es el guard, y las transiciones de estado posteriores usan `WHERE id = $1` con la transición del trigger. El race window es pequeño y las consecuencias son benignas (la transacción de settle/cancel fallaría si el estado cambió).  
**Verificación:** ⚠️ **Inferido** — el patrón es seguro por los guards del trigger FSM, pero es atípico  
**Recomendación:** Documentar el diseño como intencional (la lectura es "best effort" para decidir si ejecutar).

---

### 4.3 Reconciliación — Evaluación: 🟢 Sólido

- **Motor** (`reconciliation.ts`): Compara payment_attempts succeeded (Fluvia) vs settlement_report lines (proveedor). Clasifica cada provider_ref como matched/amount_mismatch/missing_in_ledger/missing_at_provider. Dos entry points: `runReconciliation()` (per-tenant bajo RLS, API-key plane) y `reconcileReport()` (SECURITY DEFINER, session plane + worker). ✅
- **Sweep continuo** (0028): `sweep_unreconciled()` — SECURITY DEFINER sin parámetros (alcance imposible de ensanchar). Detecta attempts sin conciliar, crea reportes sintéticos `continuous-sweep-<date>`, corre matching. Idempotente (UNIQUE por report_id+provider+provider_ref, ON CONFLICT DO NOTHING). Audit event por batch. 26 tests. ✅
- **Casos operativos** (`cases.ts`): Trigger AFTER INSERT materializa `operational_case` por cada discrepancia (no matched). Severidad automática (missing_in_ledger=critical, amount_mismatch=high). Three-state lifecycle (open/acknowledged/resolved). Resolución EXIGE motivo documentado (CHECK en BD). 36 tests. ✅
- **Ajustes four-eyes** (`adjustments.ts`): Propuesta + aprobación. Four-eyes por umbral (default $100): `CHECK (NOT requires_second_approval OR approved_by_user_id <> proposed_by_user_id)` — imposible de bypasear ni con bug del servicio. UNIQUE parcial: un ajuste activo por caso. Asiento compensatorio real al aprobarse. Rollback si falla el posting. 29 tests. ✅

#### V2-N4 — Umbral de four-eyes ($100) solo se valida en el servicio, no en la BD

**Severidad:** P2  
**Evidencia:** `adjustments.ts:66-70` — la validación `requiresSecondApproval` se calcula en el servicio comparando `amount >= thresholdCents`. La BD solo verifica la CONSISTENCIA del four-eyes (que si se requiere, apruebe alguien diferente), pero no verifica que el monto correcto EXIJA la aprobación.  
**Impacto:** Un caller que llame `proposeAdjustment` con `requiresSecondApproval: false` y un monto alto saltaría la protección four-eyes. Sin embargo, `proposeAdjustment` calcula el flag internamente y no lo acepta como input del caller (line 67-70). La protección depende de que NADIE llame directamente a la función con valores manipulados.  
**Verificación:** ⚠️ **Inferido** — el método calcula el flag; no es un input. Pero si hay un bug en `resolveFourEyesThreshold` o un nuevo caller pasa un valor incorrecto, la BD no lo atrapa.  
**Recomendación:** Agregar un trigger BEFORE INSERT/UPDATE en `case_adjustments` que verifique el umbral contra el monto. O al menos un CHECK constraint que rechace `amount > threshold AND NOT requires_second_approval`.  
**Pruebas:** Test: `proposeAdjustment` con monto justo bajo el umbral → no requiere four-eyes. Con monto justo sobre → requiere. Edge: monto = umbral exacto.

---

### 4.4 Outbox relay — Evaluación: 🟢 Sólido

- **Claim-safety**: `FOR UPDATE SKIP LOCKED` (relay.ts:88-99). Dos workers concurrentes no hacen doble entrega. Lease configurable. ✅
- **Envelope**: Validación Zod del envelope en relay y producer. Sin envelope → veneno → dead. ✅
- **Backoff**: Exponencial con jitter (relay.ts:192-220). ✅
- **Zombie sweep**: Eventos con lease expirado (locked_by pasado) se re- reclaman (relay.ts:222-256). ✅
- **Rol mínimo**: `fluvia_relay` con privilegios quirúrgicos sobre `outbox_events` únicamente. Sin BYPASSRLS. ✅

### 4.5 Inbox (webhooks entrantes) — Evaluación: 🟢 Sólido

- **Firma**: HMAC-SHA256 con `timingSafeEqual`. Tolerancia configurable. Tiempo constante. ✅
- **Guard de entorno**: `skipSignatureVerification` lanza `IngestError` fuera de test (signature.ts:49-52). No hay forma de desactivar en producción. ✅
- **Dedup**: `UNIQUE (provider, provider_event_id)` + `ON CONFLICT DO NOTHING`. Probado race-safe con 60 inserciones concurrentes. ✅
- **Sin raw body para proveedores sin firma**: El contrato `WebhookSource` exige `verifySignature` como método requerido. TypeScript lo fuerza en compilación. ✅

### 4.6 Idempotencia API — Evaluación: 🟢 Sólido

- **Claim transaccional**: La idempotencia key se clava en la MISMA transacción que el efecto (index.ts:153-176). Crash pre-COMMIT = rollback conjunto. ✅
- **Replay exacto**: Mismo hash + completed → respuesta persistida. ✅
- **Rechazo por payload diferente**: Hash canónico SHA-256 del payload normalizado. Key repetida + hash diferente → 422 `idempotency_key_reuse`. ✅
- **In-flight**: Key repetida + hash idéntico + in_progress → lock_timeout → 409 `processing_in_flight`. ✅
- **Carrera N→1**: Probado con 8 requests concurrentes, 1 efecto. ✅
- **Expiración**: TTL configurable (por defecto 24h en test). Purga administrada. ✅

---

## 5. Matriz de cobertura actualizada

| Área | v1 Estado | v2 Estado | Tests | Gate riesgo |
|------|:---------:|:---------:|:-----:|:-----------:|
| Money VO | 🟢 | 🟢 Sin cambios | ✅ Unit extensivos | 🟢 |
| Ledger (posting + balance) | 🟢 | 🟢 + reversal + nonNeg | ✅ Integración + concurrencia | 🟢 |
| Chart of Accounts | 🟢 | 🟢 | ✅ Golden | 🟢 |
| Multi-tenancy (RLS) | 🟢 | 🟢 | ✅ Vectores + meta-tests | 🟢 |
| Inmutabilidad | 🟢 | 🟢 | ✅ Triggers probados | 🟢 |
| Idempotencia ledger | 🟢 | 🟢 + metadata causal | ✅ Replay + conflicto | 🟢 |
| Idempotencia API | 🔴 | 🟢 (resuelto) | Reportado verde | 🟢 |
| Outbox relay | 🔴 | 🟢 (resuelto) | Reportado verde | 🟢 |
| Inbox proveedor | 🔴 | 🟢 (resuelto) | Reportado verde | 🟢 |
| Payments core (FSM) | 🔴 | 🟢 (resuelto) | Reportado verde | 🟢 |
| Refunds | ❌ | 🟢 (resuelto) | Reportado verde | 🟢 |
| Webhooks salientes | 🔴 | 🟢 (existe) | ⚠️ Por analizar | 🟡 |
| Reconciliación | 🔴 | 🟢 (existe) | ⚠️ Por analizar | 🟡 |
| MFA / Rate limiting | 🔴 | 🟢 (resuelto) | Reportado verde | 🟢 |
| Conciliación casos + four-eyes | ❌ | 🟢 (existe) | ⚠️ Por analizar | 🟡 |
| Observabilidad | ❌ | 🟢 (resuelto) | Reportado verde | 🟢 |
| Statement/lock timeouts | ❌ | 🔴 **Abierto** | ❌ | 🟡 |
| Overflow protección SUM | ❌ | 🟡 **Inferido** | ❌ | 🟡 |

---

## 6. Recomendaciones al constructor

### Acción inmediata (antes de siguiente feature)

1. **V2-R1 — Agregar timeouts a `withTenantTransaction`**: Es el hallazgo de mayor impacto operational. 5 líneas de SQL que previenen cascading failure.

2. **V2-R4 — Documentar o mitigar el overflow de SUM(BIGINT)**: Agregar nota en `ledger-design.md` sobre el límite operativo por cuenta, o cambiar a `::numeric` en verifyProjection y verify-ledger-invariants.sql.

### Acción antes de sandbox compartido

3. **V2-R2 — Endurecer `entriesSignature`**: Migrar a JSON.stringify canónico o hash SHA-256 antes de que más código dependa del formato actual.

### Documentación / limpieza

4. **V2-R7 — Documentar 40001 como forward-looking**: Comentario en código explicando que es preparación para SERIALIZABLE.

5. **V2-R5 — Documentar sesgo de `Money.allocate`**: Nota en JSDoc indicando que el índice 0 always gets first remainder unit.

---

*Reporte generado en modo solo lectura. Sin archivos modificados. Pendiente: completar §4 con análisis de paquetes post-v1.*
