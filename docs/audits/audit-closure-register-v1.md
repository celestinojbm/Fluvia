# Registro de cierre — Auditoría Independiente v1

Estado: Activo · Se actualiza con CADA cambio de estado de un hallazgo. Reglas:

1. El informe original (`independent-audit-v1/`) es inmutable; este registro es la única fuente del estado vivo de cada hallazgo.
2. **Ningún hallazgo pasa a RESUELTO sin evidencia individual verificable** (código + test + run). Prohibido cerrar en lote.
3. Estados: `RESUELTO` (evidencia completa) · `MITIGADO` (riesgo reducido, resto planificado) · `CERRADO POR DECISIÓN` (decisión documentada, sin código pendiente) · `ACEPTADO` (riesgo aceptado registrado en RISKS) · `PLANIFICADO` (abierto, con ítem de backlog y fase) · `ABIERTO` (sin plan — no debe existir ninguno en este estado).

Contexto: commit auditado `a665b4f` == HEAD al iniciar la integración (cero drift). Lote de remediación inmediata = **AUD-1** (migración `0008_audit_remediations.sql` + fixes de servicio + tests + docs, este commit). Evidencia CI: la URL del run verde del lote se registra en §Evidencia CI al final cuando exista.

## Hallazgos P1

| ID | Estado | Fecha | Evidencia / referencia |
|----|--------|-------|------------------------|
| AUD-P1-001 (FK cuenta-tenant-moneda) | **RESUELTO** (lote AUD-1) | 2026-07-04 | Migración `0008` §1: `UNIQUE (id, tenant_id, currency)` + FK compuesta `ledger_entries_account_coherence_fk` con validación previa de datos. Tests negativos SQL crudo (incluso superuser): `packages/db/test/ledger-invariants.test.ts` → "AUD-P1-001: an entry CANNOT reference another tenant's account" y "entry whose currency differs from its account is rejected" |
| AUD-P1-002 (payments core inexistente) | PLANIFICADO | — | Brecha de fase por diseño (F3). Congelado hasta cerrar prerequisitos (ver plan §10.6.5). No se declara capacidad de pagos en ningún doc (refuerzo AUD-P3-002) |
| AUD-P1-003 (idempotencia API) | PLANIFICADO | — | F2-09 (camino crítico pre-F3, DAG `F108→F209→F301`). La tabla subyacente quedó corregida HOY (ver AUD-P1-009) para no construir el middleware sobre un esquema roto |
| AUD-P1-004 (outbox sin relay) | **RESUELTO** (F2-11) | 2026-07-04 | `@fluvia/outbox`: claim-lease `FOR UPDATE SKIP LOCKED`, publicación fuera de la tx (Nivel A), backoff exponencial con jitter, veneno→dead, barrido de zombies, replay auditado. CA probados: 2 workers concurrentes sin doble entrega ("CA Gate: two concurrent relays never double-deliver"), poison→dead+last_error, lease expirado re-elegible. Wired en `apps/worker` (publisher de log en sandbox; entrega real = F2-12/F3-07) |
| AUD-P1-005 (inbox/webhooks entrantes) | **RESUELTO** (F2-12) | 2026-07-04 | Migración `0010` + `@fluvia/inbox`: firma HMAC-SHA256 (timestamp firmado, tolerancia, tiempo constante) verificada ANTES de persistir; dedup `UNIQUE (provider, provider_event_id)` probado race-safe (6 entregas concurrentes ⇒ 1 fila); procesador claim-lease (2 procesadores sin doble procesamiento); veneno→dead+DLQ con redacción probada (`card_token`→`[REDACTED]`); `ignored_out_of_order` terminal; replay auditado. Handlers de negocio = F3-03 (el desbloqueo que este hallazgo pedía) |
| AUD-P1-006 (rate limiting + MFA) | PLANIFICADO (ampliado HOY) | 2026-07-04 | F1-04b ampliado en BACKLOG: rate limiting por IP/email/ruta + MFA TOTP + step-up en `keys:manage`. Gate de sandbox compartido/usuarios reales. Decisión de modelo MFA = PEND-005 |
| AUD-P1-007 (worker BYPASSRLS/grants) | **RESUELTO** (F2-11, ADR-0011; mitigado antes por 0008) | 2026-07-04 | Migración `0009`: `fluvia_relay` SIN BYPASSRLS (visibilidad cross-tenant por políticas RLS explícitas SOLO en `outbox_events`; UPDATE por columna a los 6 campos de despacho; sin INSERT/DELETE); `fluvia_worker` → cascarón: `NOBYPASSRLS` + revoke total (tablas, secuencias y default privileges de 0002). Meta-tests permanentes: "NO runtime role has BYPASSRLS", "fluvia_worker … ZERO table privileges", "fluvia_relay holds ONLY outbox_events SELECT + column-scoped UPDATE" |
| AUD-P1-008 (evidencia CI no reproducible) | **RESUELTO** (evidencia existía; auditor sin acceso) | 2026-07-04 | GitHub Actions workflow `CI` corre por commit: install, lint, format-check, typecheck, migrate ×2 (no-op check), tests contra PG16 real, gitleaks, `pnpm audit --audit-level high`, SBOM SPDX. Runs #1–#10 verdes; **run #10 = commit auditado `a665b4f`, conclusion=success**. Adopción de proceso: cada handoff/cierre registra la URL del run (este registro, §Evidencia CI) |
| AUD-P1-009 (idempotency_keys sin endpoint) | **RESUELTO** (lote AUD-1) | 2026-07-04 | Migración `0008` §2: columna `endpoint` + PK `(tenant_id, endpoint, key)`; tabla sin consumidores previos (cambio seguro). Test: `ledger-invariants.test.ts` → "AUD-P1-009: idempotency keys are scoped per endpoint". Doc `idempotency.md` ↔ schema vuelven a coincidir |
| AUD-P1-010 (posting sin validación de saldo) | **RESUELTO** (lote AUD-1) | 2026-07-04 | `PostTransactionInput.nonNegativeAccounts` verificado DENTRO de la tx bajo locks de cuenta (race-safe), `InsufficientBalanceError` → rollback total; `PostingService.twoLegged` protege la cuenta debitada (release/refund/settleRefund). Tests: `ledger-service.test.ts` → describe "AUD-P1-010" (sobregiro rechazado sin efectos, frontera exacta en 0 pasa, opt-in explícito) y golden `posting.test.ts` → "cannot release more than merchant.pending nor refund more than merchant.available" |

## Hallazgos P2

| ID | Estado | Fecha | Evidencia / referencia |
|----|--------|-------|------------------------|
| AUD-P2-001 (replay sin metadata causal) | **RESUELTO** (lote AUD-1) | 2026-07-04 | `service.ts replay()` compara `reason`, `source_type`, `source_id`, `reverses_tx_id` contra la fila persistida además de la firma de entries; divergencia ⇒ `IdempotencyConflictError`. Tests: "rejects key reuse when only the REASON differs" y "…only the SOURCE differs" |
| AUD-P2-002 (payment_intents mínima) | PLANIFICADO | — | Rediseño completo del schema en F3-01 (tabla actual sin consumidores; no se parchea dos veces) |
| AUD-P2-003 (API keys live sin frontera) | **RESUELTO** (lote AUD-1) | 2026-07-04 | `ApiKeyService.create` rechaza `environment='live'` con `LiveKeysDisabledError` (HTTP 403 `live_keys_disabled`). Opción más restrictiva y reversible de las dos que ofrecía el auditor; desbloqueo futuro = production gates + decisión humana **PEND-004**. Test: "refuses to create live-environment keys while no live plane exists" (verifica además que no persiste nada) |
| AUD-P2-004 (projections actualizables) | **MITIGADO**; resto en F2-05 | 2026-07-04 | Ya existían guard de versión optimista + `verifyProjection`. HOY (0008 §3): worker pierde TODO privilegio sobre `balance_projections`. Pendiente F2-05: job programado de drift con alerta |
| AUD-P2-005 (outbox sin envelope) | **RESUELTO** (F2-11) | 2026-07-04 | `@fluvia/events`: envelope `event_id (evt_uuid)/schema_version/occurred_at/producer/resource/data` con schema Zod estricto; el productor valida al emitir (`buildEnvelope`) y el relay re-valida al despachar (no conforme = veneno→dead). Ledger migrado al sobre (test del envelope en `ledger-service.test.ts`); contrato documentado en `outbox-inbox.md` §1 |
| AUD-P2-006 (conciliación) | PLANIFICADO | — | F4 (sin cambio de plan; ya bloqueaba proveedor real). `reconciliation.md` ahora declara explícitamente que nada está construido |
| AUD-P2-007 (observabilidad/restore/runbooks) | PLANIFICADO | — | F1-07 (observabilidad), F4-06 (restore drill), F6 (runbooks) — sin cambio de plan |
| AUD-P2-008 (passwords dev en migraciones) | **ACEPTADO** (pre-existente R-12) + mejora a F1-09 | — | Registrado como R-12 en RISKS.md ANTES de la auditoría (coincidencia auditor-constructor). Mejora adoptada: en F1-09 la migración 0002 fallará fuera de local si los roles no existen con password gestionado |
| AUD-P2-009 (taxonomía de errores) | PLANIFICADO | — | F1-08 (ya era bloqueante pre-API pública vía DAG). Mitigante vigente: solo errores de dominio con mensajes controlados exponen `message`; 5xx nunca filtran detalle |
| AUD-P2-010 (SBOM/licencias) | **MITIGADO**; license report a F6 | 2026-07-04 | SBOM SPDX ya se genera como artifact en cada run de CI (auditor sin acceso a Actions). Pendiente: reporte de licencias transitivas + cierre F0-VER antes de release |
| AUD-P2-011 (FSM docs ↔ DDL sin meta-test) | PLANIFICADO | — | Criterio añadido a F3-01: meta-test que compara estados/transiciones del doc contra CHECK constraints/código FSM |
| AUD-P2-012 (verify-ledger-invariants.sql) | PLANIFICADO | — | F2-06 (Gate Ledger). La FK compuesta de HOY fortalece las invariantes que ese script verificará fuera del ORM |
| AUD-P2-013 (bucket reserved vs cuentas) | **CERRADO POR DECISIÓN** | 2026-07-04 | Decisión: reservas = CUENTAS del Chart (`merchant.reserve`, `dispute.reserve`, `refund.liability`); los buckets expresan liquidez (`available`/`pending`), no propósito. `ledger-design.md` §2/§6 corregido (la mención a `reserved` era resto del spike). Si Fase 4 demuestra necesidad de bucket, exigirá ADR nuevo |
| AUD-P2-014 (dbUrls sin anti-mezcla) | **RESUELTO** (lote AUD-1) | 2026-07-04 | `dbUrlsFromEnv`: defaults dev SOLO con `FLUVIA_ENV`/`NODE_ENV` local/test; en cualquier otro entorno lanza `FLUVIA_CONFIG` listando las URLs faltantes (FLUVIA_ENV tiene precedencia). Tests: `packages/db/test/config.test.ts` (4 casos, incluye precedencia) |
| AUD-P2-015 (HMAC server-side keys) | PLANIFICADO (pre-sandbox) | — | Ítem AUD-P2-015 en backlog: `key_hash_version` + HMAC con secreto server-side antes de sandbox compartido. Mitigante actual: 24 bytes de entropía hacen impracticable cracking offline del SHA-256 |
| AUD-P2-016 (CORS/headers/OpenAPI/load) | PLANIFICADO | — | OpenAPI ya estaba en F3-02; CORS/security headers a F3 (primer consumo browser); load a F2-08/F6 |

## Hallazgos P3

| ID | Estado | Fecha | Evidencia / referencia |
|----|--------|-------|------------------------|
| AUD-P3-001 (README desactualizado) | **RESUELTO** (lote AUD-1) | 2026-07-04 | README reescrito: estado real (Fase 2), tabla completa de paquetes, PEND resueltas/abiertas, negativa explícita de capacidades productivas y live keys |
| AUD-P3-002 (docs sin estado de implementación) | **RESUELTO** (lote AUD-1) | 2026-07-04 | Bloque "Estado de implementación" fechado en: `webhook-delivery.md`, `reconciliation.md`, `payment-lifecycle.md`, `payment-state-machines.md`, `outbox-inbox.md`, `idempotency.md` — distinguen DISEÑO / PARCIAL / construido con referencias a fase |
| AUD-P3-003 (Dockerfile/compose completo) | PLANIFICADO | — | F3 (junto a E2E sandbox) |

## Decisiones humanas abiertas derivadas (no bloquean el plan)

- **PEND-004**: política definitiva de credenciales `live` (hoy: creación bloqueada por código). Propietario: humano.
- **PEND-005**: modelo MFA/recuperación de cuenta (TOTP propuesto). Propietario: humano.
- **PEND-006**: condiciones para abrir sandbox compartido (requiere F1-04b + AUD-P2-015). Propietario: humano.

## Evidencia CI

- Runs #1–#10: verdes (uno por commit hasta `a665b4f` = commit auditado, run #10).
- Runs #11–#12: rama documental de la auditoría (`9c17888`), verdes.
- **Lote AUD-1: run #13 VERDE** — commit `4cdfcb0`, `https://github.com/celestinojbm/Fluvia/actions/runs/28716967441` (install, lint, format, typecheck, migrate ×2 incl. 0008, 174 tests contra PG16, gitleaks, audit, SBOM).
- **F2-11 (cierra AUD-P1-004/007 y AUD-P2-005): run #15 VERDE** — commit `1ecc533`, `https://github.com/celestinojbm/Fluvia/actions/runs/28717692510` (migrate ×2 incl. 0009, 195 tests incl. relay multi-worker y meta-tests de roles).

## Criterio de re-auditoría (adoptado del auditor)

Solicitar re-auditoría al cerrar P1-003, ~~P1-004~~ ✓, P1-005, P1-006 y ~~el rediseño completo de P1-007~~ ✓ — estimado: final de Fase 2. Quedan: P1-003 (F2-09) y P1-006 (F1-04b) — ~~P1-005~~ ✓ (F2-12, 2026-07-04).
