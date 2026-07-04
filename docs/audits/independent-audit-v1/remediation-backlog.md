# Fluvia Independent Audit v1 — Remediation Backlog

**Proyecto:** Fluvia
**Auditoría:** Independent Audit v1
**Commit auditado:** `a665b4ff6a8dca5e64e786b534ce1f2da85455f2`
**Rama auditada:** `claude/new-session-haeo7h`
**Fuente canónica:** `Fluvia_Independent_Audit_v1.md`

Este backlog convierte únicamente los hallazgos accionables en tareas trazables. No incluye recomendaciones puramente informativas ni aplica correcciones.

## Leyenda de continuidad

- **BLOQUEANTE:** debe corregirse antes de continuar sobre esa área.
- **INCORPORAR INMEDIATAMENTE:** debe entrar en el incremento actual.
- **INCORPORAR EN LA SIGUIENTE FASE:** no bloquea el trabajo actual, pero debe planificarse en el próximo ciclo.
- **SEGUIR Y MONITOREAR:** puede continuar con métricas/pruebas adicionales.
- **OPCIONAL:** mejora recomendable.
- **SIN CAMBIOS:** conservar el diseño/implementación actual.

---

## P0

No se registraron tareas P0 confirmadas en esta auditoría. No se debe usar esta ausencia para declarar producción: los gates de producción siguen rojos/no verificados.

---

## AUD-P1-001 — Forzar tenant/currency de `ledger_entries` en base de datos

- **Prioridad:** P1
- **Título:** Añadir invariante DB para coherencia cuenta-tenant-moneda en ledger entries.
- **Descripción:** La base debe impedir que un asiento contable referencie una cuenta de otro tenant o de otra moneda, incluso vía SQL crudo/admin.
- **Hallazgo de origen:** AUD-P1-001.
- **Evidencia:** `packages/db/migrations/0001_foundation.sql:72-84`; `packages/ledger/src/service.ts:180-198`; `packages/db/migrations/0007_ledger_core.sql:81-109`.
- **Área afectada:** Ledger / DB integrity.
- **Archivos o módulos afectados:** `packages/db/migrations`, `packages/db/test/ledger-invariants.test.ts`, posiblemente `packages/ledger`.
- **Riesgo:** Corrupción contable semántica no detectada por el balanceo doble.
- **Acción recomendada:** Agregar FK compuesta o trigger diferido contra `(account_id, tenant_id, currency)` y pruebas SQL crudo.
- **Alternativas relevantes:** Script externo de invariantes como detector posterior; no suficiente como única defensa.
- **Dependencias:** Migración segura y validación de datos existentes.
- **Responsable sugerido:** Backend/DB.
- **Criterios de aceptación:** No se puede commitear un `ledger_entry` con cuenta de otro tenant o moneda incorrecta.
- **Pruebas requeridas:** Tests negativos con SQL manual/admin para cross-tenant y currency mismatch.
- **Evidencia de cierre:** Log de tests verdes + migración revisada.
- **Talla relativa:** S/M.
- **Momento recomendado:** Ahora, antes de nuevas mutaciones financieras.
- **Clasificación de continuidad:** BLOQUEANTE.

## AUD-P1-002 — Implementar PaymentIntent/Attempt FSM antes de API pública

- **Prioridad:** P1
- **Título:** Construir el núcleo real de PaymentIntent/PaymentAttempt con FSM declarativa.
- **Descripción:** La tabla mínima `payment_intents` no equivale a payments core. Se requiere reconciliar schema, estados, servicios y endpoints.
- **Hallazgo de origen:** AUD-P1-002; reforzado por AUD-P2-011.
- **Evidencia:** `packages/db/migrations/0001_foundation.sql:127-149`; `docs/architecture/payment-state-machines.md`; ausencia de rutas payment en `apps/api/src/routes`.
- **Área afectada:** Payments core.
- **Archivos o módulos afectados:** Nuevas migraciones, nuevo paquete/servicio payments, `apps/api`.
- **Riesgo:** Estados inválidos, duplicación de intentos/capturas y checkout construido sobre una tabla incompleta.
- **Acción recomendada:** Implementar FSM declarativa, servicios de transición, attempts separados y tests de transición/concurrencia.
- **Alternativas relevantes:** Mantener la tabla marcada como placeholder hasta F3.
- **Dependencias:** AUD-P1-001, AUD-P1-003, AUD-P1-005, AUD-P2-011.
- **Responsable sugerido:** Backend payments.
- **Criterios de aceptación:** Transiciones inválidas imposibles; intent/attempt separados; estados documentados coinciden con código y DDL.
- **Pruebas requeridas:** FSM matrix tests, confirm/cancel concurrency, eventos tardíos/fuera de orden.
- **Evidencia de cierre:** Tests verdes + documentación actualizada.
- **Talla relativa:** L.
- **Momento recomendado:** Después de cerrar los bloqueantes de ledger/idempotencia/inbox.
- **Clasificación de continuidad:** BLOQUEANTE.

## AUD-P1-003 — Implementar idempotencia HTTP/API

- **Prioridad:** P1
- **Título:** Middleware/servicio de idempotencia API sobre `idempotency_keys`.
- **Descripción:** La tabla existe, pero no hay capa HTTP que garantice replay seguro de endpoints mutantes.
- **Hallazgo de origen:** AUD-P1-003; relacionado con AUD-P1-009.
- **Evidencia:** `packages/db/migrations/0001_foundation.sql:113-125`; no hay uso en `apps/api/src`; F2-09/F2-10 pendientes.
- **Área afectada:** API financiera / Idempotencia.
- **Archivos o módulos afectados:** `apps/api`, `packages/db`, tests de integración.
- **Riesgo:** Reintentos HTTP pueden duplicar pagos/refunds o devolver respuestas inconsistentes.
- **Acción recomendada:** Implementar contrato `Idempotency-Key` con estado in-progress/completed, hash de request, respuesta persistida y manejo de carrera.
- **Alternativas relevantes:** No exponer mutaciones públicas hasta implementarlo.
- **Dependencias:** Taxonomía de errores; AUD-P1-009.
- **Responsable sugerido:** Backend API.
- **Criterios de aceptación:** Same key + same payload devuelve mismo resultado; same key + payload distinto rechaza; carrera N->1.
- **Pruebas requeridas:** Concurrencia y crash pre/post commit.
- **Evidencia de cierre:** Logs de pruebas y contrato documentado.
- **Talla relativa:** M.
- **Momento recomendado:** Antes de cualquier endpoint financiero mutante.
- **Clasificación de continuidad:** BLOQUEANTE.

## AUD-P1-004 — Implementar outbox relay worker

- **Prioridad:** P1
- **Título:** Procesar `outbox_events` con relay durable.
- **Descripción:** Hoy los eventos se insertan pero no se entregan ni reintentan.
- **Hallazgo de origen:** AUD-P1-004.
- **Evidencia:** `packages/db/migrations/0001_foundation.sql:95-110`; `packages/ledger/src/service.ts:226-237`; `apps/worker/src/worker.ts:15-20`.
- **Área afectada:** Procesamiento asíncrono / Worker.
- **Archivos o módulos afectados:** `apps/worker`, migraciones si se ajusta schema de outbox.
- **Riesgo:** Eventos estancados; downstream inexistente.
- **Acción recomendada:** Implementar claim con `FOR UPDATE SKIP LOCKED`, retry/backoff+jitter, DLQ, métricas y replay auditado.
- **Alternativas relevantes:** Tratar outbox como evidencia local temporal, no como delivery.
- **Dependencias:** AUD-P1-007; AUD-P2-005.
- **Responsable sugerido:** Backend/Platform.
- **Criterios de aceptación:** Dos workers no duplican entrega; poison event termina `dead`; crash no pierde evento.
- **Pruebas requeridas:** Integración multi-worker con fallos inyectados.
- **Evidencia de cierre:** Logs de pruebas + métricas de cola.
- **Talla relativa:** M.
- **Momento recomendado:** F2-11, antes de componentes que dependan de eventos.
- **Clasificación de continuidad:** INCORPORAR INMEDIATAMENTE.

## AUD-P1-005 — Implementar inbox durable y verificación de webhooks entrantes

- **Prioridad:** P1
- **Título:** Crear inbox/provider events con raw body, firma, dedupe y DLQ.
- **Descripción:** No existe pipeline durable para eventos de proveedor.
- **Hallazgo de origen:** AUD-P1-005.
- **Evidencia:** `packages/db/migrations/0001_foundation.sql:151-162`; F2-12 pendiente; ausencia de rutas/verificación webhook.
- **Área afectada:** Webhooks entrantes / Provider events.
- **Archivos o módulos afectados:** Nuevas tablas/provider events, API/worker.
- **Riesgo:** Duplicados, eventos fuera de orden o payloads inválidos pueden perderse o procesarse dos veces.
- **Acción recomendada:** Implementar raw body, verificación de firma, timestamp tolerance, replay protection, unique provider event id y DLQ.
- **Alternativas relevantes:** Mock síncrono solo para tests unitarios, declarado como no representativo.
- **Dependencias:** Outbox/worker; FSM payments.
- **Responsable sugerido:** Backend payments/integrations.
- **Criterios de aceptación:** Duplicados procesan una vez; firma inválida rechaza; payload inválido se archiva en DLQ.
- **Pruebas requeridas:** Firma, dedupe, payload inválido, eventos tardíos/fuera de orden.
- **Evidencia de cierre:** Tests y logs de DLQ.
- **Talla relativa:** M.
- **Momento recomendado:** Antes de MockProvider/proveedor asíncrono.
- **Clasificación de continuidad:** BLOQUEANTE.

## AUD-P1-006 — Rate limiting y MFA/step-up para acciones sensibles

- **Prioridad:** P1
- **Título:** Proteger auth y operaciones high-risk.
- **Descripción:** Auth no tiene rate limit y API key management existe sin step-up/MFA.
- **Hallazgo de origen:** AUD-P1-006.
- **Evidencia:** `apps/api/src/routes/auth.ts:22-50`; `packages/auth/src/passwords.ts:17-30`; `apps/api/src/routes/organizations.ts:132-177`; `docs/agents/STATE.md:11`.
- **Área afectada:** Seguridad / Auth.
- **Archivos o módulos afectados:** `apps/api`, `packages/auth`, `packages/identity`.
- **Riesgo:** DoS por hashing, abuso de registro/login, creación de API keys con sesión robada.
- **Acción recomendada:** Rate limit por IP/email/ruta; MFA TOTP y step-up para `keys:manage` y futuras acciones financieras.
- **Alternativas relevantes:** Feature flag para deshabilitar rutas sensibles fuera de local/test hasta completar MFA.
- **Dependencias:** Observabilidad/store de rate limit.
- **Responsable sugerido:** Security/API.
- **Criterios de aceptación:** Excesos devuelven error estable; acciones sensibles requieren factor reciente y quedan auditadas.
- **Pruebas requeridas:** Throttle, bypass attempts, step-up expiry.
- **Evidencia de cierre:** Tests y audit events.
- **Talla relativa:** M/L.
- **Momento recomendado:** Antes de usuarios reales/dashboard.
- **Clasificación de continuidad:** BLOQUEANTE.

## AUD-P1-007 — Reducir privilegios del worker

- **Prioridad:** P1
- **Título:** Reemplazar `BYPASSRLS` amplio por permisos mínimos.
- **Descripción:** El worker actual tiene demasiados privilegios para un proceso que aún no consume colas.
- **Hallazgo de origen:** AUD-P1-007.
- **Evidencia:** `packages/db/migrations/0002_enable_rls.sql:22-33`; `apps/worker/src/worker.ts:15-20`.
- **Área afectada:** Multi-tenancy / DB roles.
- **Archivos o módulos afectados:** Migraciones, worker.
- **Riesgo:** Compromiso del worker puede leer/actualizar datos cross-tenant.
- **Acción recomendada:** Roles mínimos por cola o funciones SECURITY DEFINER acotadas.
- **Alternativas relevantes:** Mantener BYPASSRLS solo detrás de funciones de claim con grants específicos.
- **Dependencias:** Diseño F2-11/F2-12.
- **Responsable sugerido:** DB/Platform.
- **Criterios de aceptación:** Worker no puede leer/actualizar tablas de dominio no necesarias.
- **Pruebas requeridas:** Meta-tests de grants y denial tests.
- **Evidencia de cierre:** Query de `information_schema.role_table_grants` + tests.
- **Talla relativa:** M.
- **Momento recomendado:** Antes de desplegar worker real.
- **Clasificación de continuidad:** BLOQUEANTE.

## AUD-P1-008 — Aportar evidencia reproducible de CI/tests

- **Prioridad:** P1
- **Título:** Verificar la línea base con CI verde o ejecución local autorizada.
- **Descripción:** La auditoría no pudo ejecutar suite completa sin instalar dependencias; faltó run verde adjunto.
- **Hallazgo de origen:** AUD-P1-008.
- **Evidencia:** `pnpm lint` falló con `eslint: not found`; test config falló con `vitest: not found`; `docker`/`psql` no disponibles; CI configurado en `.github/workflows/ci.yml`.
- **Área afectada:** Calidad / Supply chain.
- **Archivos o módulos afectados:** CI/GitHub Actions; no requiere cambio de código.
- **Riesgo:** Construir sobre claims de tests no verificados.
- **Acción recomendada:** Adjuntar run verde de GitHub Actions del commit o autorizar ejecución local reproducible.
- **Alternativas relevantes:** Usar GitHub Actions como evidencia oficial.
- **Dependencias:** Acceso a CI/red/autorización.
- **Responsable sugerido:** DevOps/constructor.
- **Criterios de aceptación:** Logs verdes de install, lint, format, build, migrate, test, gitleaks, audit, SBOM.
- **Pruebas requeridas:** Workflow CI o comandos locales equivalentes.
- **Evidencia de cierre:** URL/log del run.
- **Talla relativa:** XS.
- **Momento recomendado:** Ahora.
- **Clasificación de continuidad:** BLOQUEANTE para declarar verificado.

## AUD-P1-009 — Añadir `endpoint` a idempotency key API

- **Prioridad:** P1
- **Título:** Cambiar PK de `idempotency_keys` a `(tenant_id, endpoint, key)`.
- **Descripción:** La PK actual `(tenant_id, key)` puede colisionar entre endpoints diferentes.
- **Hallazgo de origen:** AUD-P1-009.
- **Evidencia:** `packages/db/migrations/0001_foundation.sql:115-125`; contrato documentado de idempotencia.
- **Área afectada:** Idempotencia API / DB.
- **Archivos o módulos afectados:** Migraciones, middleware futuro.
- **Riesgo:** Conflictos falsos entre endpoints.
- **Acción recomendada:** Añadir `endpoint TEXT NOT NULL` y migrar PK antes de F2-09.
- **Alternativas relevantes:** Namespacing manual de keys por endpoint; menos recomendable.
- **Dependencias:** F2-09.
- **Responsable sugerido:** Backend API/DB.
- **Criterios de aceptación:** Dos endpoints distintos aceptan la misma key; mismo endpoint conserva conflicto correcto.
- **Pruebas requeridas:** Test de colisión endpoint y conflicto intra-endpoint.
- **Evidencia de cierre:** Tests + migración.
- **Talla relativa:** S.
- **Momento recomendado:** Antes de implementar idempotencia HTTP.
- **Clasificación de continuidad:** BLOQUEANTE.

## AUD-P1-010 — Validar saldos suficientes en settlement/refund

- **Prioridad:** P1
- **Título:** Prevenir balances negativos semánticamente inválidos en operaciones tipadas.
- **Descripción:** `PostingService` postea settlement/refund sin verificar saldo disponible/pendiente.
- **Hallazgo de origen:** AUD-P1-010.
- **Evidencia:** `packages/ledger/src/posting.ts:160-172`.
- **Área afectada:** Ledger semántico / Payments sandbox.
- **Archivos o módulos afectados:** `packages/ledger/src/posting.ts`, tests golden.
- **Riesgo:** Liquidar/refundear más de lo disponible.
- **Acción recomendada:** Pre-check de saldo por operación o política explícita de negativos por cuenta.
- **Alternativas relevantes:** Permitir negativos solo para `adjustment/reconciliation` con auditoría high-risk.
- **Dependencias:** Definición de reglas de saldo por cuenta.
- **Responsable sugerido:** Backend ledger/payments.
- **Criterios de aceptación:** Operación que excede saldo falla con error de dominio estable.
- **Pruebas requeridas:** Tests de saldo insuficiente para pending/available/refund liability.
- **Evidencia de cierre:** Tests verdes.
- **Talla relativa:** S/M.
- **Momento recomendado:** Antes de exponer settlement/refund a API/jobs.
- **Clasificación de continuidad:** BLOQUEANTE.

---

## P2/P3 resumidos para planificación

| ID | Prioridad | Título | Clasificación | Talla |
|---|---|---|---|---|
| AUD-P2-001 | P2 | Comparar metadata completa en replay idempotente del ledger | INCORPORAR INMEDIATAMENTE | S |
| AUD-P2-002 | P2 | Revisar schema `payment_intents` antes de API real | INCORPORAR INMEDIATAMENTE | S/M |
| AUD-P2-003 | P2 | Bloquear/gatear API keys `live` | INCORPORAR INMEDIATAMENTE | S |
| AUD-P2-004 | P2 | Proteger o auditar UPDATE directo de `balance_projections` | INCORPORAR EN LA SIGUIENTE FASE | M |
| AUD-P2-005 | P2 | Definir envelope común para outbox events | INCORPORAR INMEDIATAMENTE | S |
| AUD-P2-006 | P2 | Implementar reconciliación inicial | INCORPORAR EN LA SIGUIENTE FASE | L/XL |
| AUD-P2-007 | P2 | Observabilidad y restore drills | INCORPORAR EN LA SIGUIENTE FASE | L |
| AUD-P2-008 | P2 | Separar provisioning de roles/passwords dev | INCORPORAR EN LA SIGUIENTE FASE | S/M |
| AUD-P2-009 | P2 | Taxonomía pública de errores API | INCORPORAR INMEDIATAMENTE | S |
| AUD-P2-010 | P2 | SBOM/license report transitivo | INCORPORAR EN LA SIGUIENTE FASE | S |
| AUD-P2-011 | P2 | Meta-test FSM ↔ DDL de PaymentIntent | INCORPORAR INMEDIATAMENTE | S |
| AUD-P2-012 | P2 | Crear `scripts/verify-ledger-invariants.sql` | INCORPORAR EN LA SIGUIENTE FASE | S |
| AUD-P2-013 | P2 | Resolver diseño de bucket `reserved` | INCORPORAR EN LA SIGUIENTE FASE | S/M |
| AUD-P2-014 | P2 | Unificar protección anti-mezcla en DB config helpers | INCORPORAR EN LA SIGUIENTE FASE | S |
| AUD-P2-015 | P2 | Versionar API key hashing con HMAC server-side | INCORPORAR EN LA SIGUIENTE FASE | M |
| AUD-P2-016 | P2/P3 | CORS/headers/OpenAPI/load/dependency automation | INCORPORAR EN LA SIGUIENTE FASE | M |
| AUD-P3-001 | P3 | Corregir README/STATE en PR separado | INCORPORAR INMEDIATAMENTE | XS |
| AUD-P3-002 | P3 | Añadir estado de implementación a docs amplias | OPCIONAL | S |
| AUD-P3-003 | P3 | Dockerfile/devcontainer cuando exista E2E sandbox | INCORPORAR EN LA SIGUIENTE FASE | M |
