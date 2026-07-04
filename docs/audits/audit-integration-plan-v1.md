# Plan de integración de la Auditoría Independiente v1

Estado: Activo · Este documento es la evaluación del constructor; NO modifica el informe original (`independent-audit-v1/`, intacto como evidencia histórica).

## 10.1 Referencias

- Repositorio: `https://github.com/celestinojbm/Fluvia.git` · PR documental: #1 (`docs(audit): add independent audit v1 artifacts`)
- Rama documental: `audit/independent-audit-v1` · Commit documental real: `9c178887562af9c5df0be6a7f06e0adbe0f95c57` (el hash citado en la orden de integración contenía un typo de transcripción de 41 caracteres; título, contenido y diff verificados coinciden)
- Commit auditado: `a665b4ff6a8dca5e64e786b534ce1f2da85455f2` (= F2-04)
- Rama de construcción: `claude/new-session-haeo7h` · Commit al iniciar la reconciliación: `a665b4f` (**idéntico al auditado: cero drift post-línea-base**)
- Fecha de reconciliación: 2026-07-04 · Responsable: agente constructor (sesión activa)
- Verificación del PR: `git diff --name-only origin/claude/new-session-haeo7h...origin/audit/independent-audit-v1` → exactamente los 4 archivos esperados, solo inserciones (+1581), un commit. **Exclusivamente documental: confirmado.**

## 10.2 Estado del proyecto antes de integrar la auditoría

- Working tree limpio; sin cambios locales que proteger.
- Último incremento completado: **F2-04** (Chart of Accounts + posting rules, commit `a665b4f`, CI run #10 verde).
- Incremento en curso: ninguno a medias (F2-04 cerrado y entregado).
- Próximo planificado: **F2-11** (outbox relay worker), alternativa F2-05/06/08.
- Tests en verde: **162/162** local + CI GitHub Actions runs #1–#10 verdes (uno por commit, incluido el auditado). Tests fallidos: 0. Pendientes: los de fases futuras.
- Bloqueadores previos: PEND-002 (pricing, solo Fase 4), F0-VER (licencias referencias).
- Riesgos conocidos previos: R-01…R-13 en `docs/agents/RISKS.md` (varios coinciden con hallazgos del auditor: R-12 = AUD-P2-008).

## 10.3 Resumen ejecutivo de la auditoría

- Veredicto: **CONTINUAR SOLO EN ÁREAS NO AFECTADAS** — sin reinicio, congelar pagos públicos/checkout/proveedor/webhooks externos/live hasta cerrar bloqueantes.
- P0: **0** · P1: **10** (001–008 + 009/010 del addendum) · P2: **16** (001–016) · P3: **3**.
- Limitaciones del auditor: sin instalación de dependencias (eslint/vitest no ejecutables), sin Docker/psql (migraciones y suites NO ejecutadas), **sin acceso a GitHub Actions** (los runs verdes existentes no fueron visibles), sin infra/secrets/datos.
- No revisado: infraestructura real, historial gitleaks local, proveedor externo (no existe).

## 10.4 Matriz de reconciliación

Convenciones: HEAD == commit auditado ⇒ ningún hallazgo pudo resolverse "después"; las clasificaciones distintas de VIGENTE se sustentan en evidencia que el auditor no pudo ver (p.ej. CI). Talla y fase según backlog propio.

| ID | Sev | Título corto | Estado reconciliado | Evidencia del constructor | Decisión | Prioridad final | Fase | ¿Bloquea trabajo actual? | Talla |
|----|-----|--------------|--------------------|---------------------------|----------|-----------------|------|--------------------------|-------|
| AUD-P1-001 | P1 | `ledger_entries` sin invariante BD tenant/moneda-cuenta | **VIGENTE** — FK simple a `ledger_accounts(id)`; sólo el servicio valida | Inspección `0001:72-84` confirmada | **Corregir AHORA** (migración 0008: FK compuesta `(account_id, tenant_id, currency)` + tests SQL crudo) | P1 | Inmediata | Sí: nuevas mutaciones financieras hasta migrar | S |
| AUD-P1-002 | P1 | Payments core no implementado | **VIGENTE como brecha PLANIFICADA** (F3 por diseño; DAG ya exige F2-09 antes de F3-02) | `BACKLOG.md` F3; DAG | Confirmar congelación de F3 hasta cerrar prerequisitos (ya era el plan) | P1 (gate de F3) | F3 | No (nada se construye sobre ello hoy) | L |
| AUD-P1-003 | P1 | Idempotencia API no implementada | **VIGENTE PLANIFICADA** (F2-09 en camino crítico pre-F3) | DAG `F108→F209→F301` | Mantener secuencia; ver AUD-P1-009 (corregir tabla antes) | P1 | F2-09 | No | M |
| AUD-P1-004 | P1 | Outbox sin relay | **VIGENTE PLANIFICADA** — F2-11 era exactamente el próximo incremento propuesto | STATE.md §próximo incremento | Ejecutar F2-11 como siguiente incremento, incorporando P1-007 y P2-005 | P1 | F2-11 (siguiente) | No (nada depende de entrega de eventos aún) | M |
| AUD-P1-005 | P1 | Inbox/webhooks entrantes no implementados | **VIGENTE PLANIFICADA** (F2-12) | BACKLOG F2-12 | Mantener secuencia F2-11→F2-12; bloquea MockProvider asíncrono (F3-03) | P1 | F2-12 | No | M |
| AUD-P1-006 | P1 | Sin rate limiting; MFA/step-up pendiente | **VIGENTE** — MFA ya reconocido (F1-04b); rate limiting no tenía ítem explícito | STATE/BACKLOG F1-04b | Ampliar F1-04b: rate limiting por IP/email/ruta + MFA TOTP + step-up para `keys:manage`. Bloqueante para usuarios reales/sandbox compartido, no para trabajo interno actual | P1 (gate de sandbox) | F1-04b (antes de F3 UI) | No hoy (solo local/test) | M/L |
| AUD-P1-007 | P1 | `fluvia_worker` BYPASSRLS + grants amplios | **VIGENTE** — riesgo latente (worker aún placeholder) | `0002:22-33` | Rediseñar privilegios DENTRO de F2-11 (rol mínimo del relay ANTES de que exista consumidor); + REVOKE UPDATE de worker sobre `balance_projections` | P1 | F2-11 (integrado) | Sí para desplegar worker real (aún no existe) | M |
| AUD-P1-008 | P1 | Evidencia CI/tests no reproducible para el commit | **YA RESUELTO (evidencia existente no visible para el auditor)** — GitHub Actions corre install+lint+format+typecheck+migrate(×2)+tests+gitleaks+audit+SBOM por commit; runs #1–#10 verdes; **run #10 = commit auditado `a665b4f`, conclusion=success** (verificado en sesión vía API) | Runs en `https://github.com/celestinojbm/Fluvia/actions` (workflow CI); extracciones en STATE.md | Registrar URLs de runs como evidencia formal en el closure register y en cada handoff (adopción de la recomendación de proceso del auditor) | Cerrado | — | No | XS |
| AUD-P1-009 | P1 | `idempotency_keys` sin `endpoint` en PK (contradice `idempotency.md`) | **VIGENTE** — discrepancia doc-schema real; tabla aún sin uso (fix barato ahora) | `0001:113-125` vs `idempotency.md` | **Corregir AHORA** (migración 0008: columna `endpoint` + PK `(tenant_id, endpoint, key)`) | P1 | Inmediata | No (tabla inerte) | S |
| AUD-P1-010 | P1 | Posting sin validación de saldo (settlement/refund pueden dejar pasivos negativos) | **VIGENTE** — el constructor lo había notado pero NO lo registró visiblemente (fallo de trazabilidad propio, reconocido) | `posting.ts` twoLegged sin pre-check | **Corregir AHORA**: guard race-safe `nonNegativeAccounts` dentro de la transacción de posting (bajo locks) + `InsufficientBalanceError` + golden tests | P1 | Inmediata | Sí: exponer settlement/refund sin esto | S/M |
| AUD-P2-001 | P2 | Replay idempotente no compara reason/source/reverses | **VIGENTE** | `service.ts` replay solo entries | **Corregir AHORA** (comparar metadata contra fila `ledger_transactions`) | P2→ahora (S) | Inmediata | No | S |
| AUD-P2-002/011 | P2 | `payment_intents` mínima vs FSM documentada | **VIGENTE** — tabla spike sin consumidores | `0001:127-149` | Rediseñar schema en F3-01 con **meta-test FSM↔DDL** (criterio añadido al backlog F3-01) | P2 | F3-01 | No | S/M |
| AUD-P2-003 | P2 | API keys `live` sin frontera operacional | **VIGENTE** | `api-keys.ts` | **Corregir AHORA**: bloquear creación de keys `live` (error estable) hasta gates live + decisión humana; opción más segura y reversible de las dos que ofrece el auditor | P2→ahora | Inmediata | No | S |
| AUD-P2-004 | P2 | `balance_projections` actualizable por app/worker | **PARCIALMENTE RESUELTO** — guard de versión + `verifyProjection` existen; falta drift job y reducción worker | `service.ts` guard; F2-05 backlog | REVOKE UPDATE al worker ahora (0008); drift check queda en F2-05 | P2 | 0008 + F2-05 | No | S |
| AUD-P2-005 | P2 | Outbox sin envelope común | **VIGENTE** | payload libre + schema_version por convención | Incorporar helper de envelope AL incremento F2-11 | P2 | F2-11 | No | S |
| AUD-P2-006 | P2 | Conciliación no implementada | **VIGENTE PLANIFICADA** (F4) | BACKLOG F4 | Sin cambio de plan; bloquea proveedor real (ya reflejado) | P2 | F4 | No | L |
| AUD-P2-007 | P2 | Observabilidad/restore/runbooks | **VIGENTE PLANIFICADA** (F1-07/F4-06/F6) | BACKLOG | Sin cambio de plan | P2 | F1-07+ | No | M/L |
| AUD-P2-008 | P2 | Passwords dev en migraciones | **RIESGO ACEPTADO** (ya registrado como R-12 antes de la auditoría) + mejora concreta adoptada: fallar fuera de local si roles no existen (se añade a F1-09) | RISKS.md R-12 | Mantener aceptación temporal; implementar guard en F1-09 | P2 | F1-09 | No | S |
| AUD-P2-009 | P2 | Taxonomía de errores pendiente; `err.message` en respuestas | **VIGENTE PLANIFICADA** (F1-08, ya adelantada por auditoría propia D2) — mitigante: solo errores de dominio con mensajes controlados exponen message; 5xx ocultos | `app.ts` DOMAIN_ERROR_HTTP | Mantener F1-08 como bloqueante pre-API pública (ya lo era vía DAG F108→F209) | P2 | F1-08 | No | S |
| AUD-P2-010 | P2 | SBOM/licencias transitivas | **PARCIALMENTE RESUELTO** — SBOM SPDX se genera como artifact en CADA run de CI (auditor sin acceso); falta license report transitivo + F0-VER | `ci.yml` job security; artifacts por run | Registrar artifact como evidencia; license report a F6/pre-release | P2 | F6 | No | S |
| AUD-P2-012 | P2 | Falta `scripts/verify-ledger-invariants.sql` | **VIGENTE PLANIFICADA** (F2-06, ya en backlog y gate) | BACKLOG F2-06 | Sin cambio; la migración 0008 fortalece las invariantes que ese script verificará | P2 | F2-06 | No | S |
| AUD-P2-013 | P2 | Ambigüedad bucket `reserved` vs cuentas reserve | **RESUELTO POR DECISIÓN (ahora)**: las reservas se modelan como CUENTAS (`merchant.reserve`, `dispute.reserve`), NO como bucket; el bucket expresa estado de liquidez (available/pending), no propósito. Documentado en `ledger-design.md` | decisión + doc | Cerrado con doc; si Fase 4 demuestra necesidad de bucket, ADR nuevo | Cerrado | — | No | XS |
| AUD-P2-014 | P2 | `dbUrlsFromEnv` sin anti-mezcla | **VIGENTE** | `db/config.ts` | **Corregir AHORA**: falla fuera de local/test sin URLs explícitas (mismo criterio que `@fluvia/config`) | P2→ahora | Inmediata | No | S |
| AUD-P2-015 | P2 | API keys SHA-256 puro (sin HMAC server-side) | **RECOMENDACIÓN FUTURA** — entropía de 24 bytes hace impracticable el cracking offline; HMAC versionado añade defensa si se filtra SOLO la BD | api-keys.ts | Backlog AUD-P2-015 antes de sandbox compartido (con `key_hash_version`) | P2 | pre-sandbox | No | M |
| AUD-P2-016 | P2/P3 | CORS/headers/OpenAPI/load/renovate | **RECOMENDACIÓN FUTURA** (OpenAPI ya estaba en F3-02) | BACKLOG F3 | A F3/hardening | P2/P3 | F3/F6 | No | M |
| AUD-P3-001 | P3 | README dice "Fase 0" | **VIGENTE** | README.md:5 | **Corregir AHORA** | P3→ahora | Inmediata | No | XS |
| AUD-P3-002 | P3 | Docs de diseño sin estado de implementación | **VIGENTE** — aceptada (excelente para agentes) | docs/architecture | **Corregir AHORA**: bloque "Estado de implementación" en docs de diseño no implementados | P3→ahora | Inmediata | No | S |
| AUD-P3-003 | P3 | Sin Dockerfile/compose completo | **RECOMENDACIÓN FUTURA** (F3, con E2E sandbox) | — | Backlog F3 | P3 | F3 | No | M |

Re-clasificaciones del addendum del propio auditor (sesiones bearer, rotación de sesión, registro abierto, Dockerfile, password complexity): **aceptadas tal cual** — coinciden con el análisis del constructor.

## 10.5 Impacto sobre el proceso activo

- **Continúa sin cambios**: todo el núcleo ya construido (money, db/RLS, identity, auth, audit, ledger, posting) — el auditor pide conservarlo explícitamente. La Fase 2 sigue siendo la fase actual.
- **Se ajusta**: el próximo incremento (F2-11) **absorbe** AUD-P1-007 (rol mínimo del relay, sin BYPASSRLS amplio) y AUD-P2-005 (envelope de eventos) como criterios de aceptación adicionales.
- **Se antepone**: un incremento de remediación inmediata (lote AUD-1, este mismo turno) con los fixes de talla S/M vigentes: P1-001, P1-009, P1-010, P2-001, P2-003, P2-004(parcial), P2-014, P3-001, P3-002, P2-013(doc).
- **Se pausa/confirma congelado** (ya era el plan; ahora es compromiso explícito ante auditoría): API pública de pagos, checkout, MockProvider asíncrono "realista", webhooks externos, conciliación operativa, cualquier uso `live`.
- **No se reescribe**: ledger, RLS, stack, monolito — por mandato del auditor y evidencia propia.
- **Paralelizable**: F1-07/F1-08 (observabilidad/taxonomía) siguen intercalables.

## 10.6 Plan integrado

1. **AUD-1 (ahora, este incremento)**: migración 0008 (FK compuesta ledger_entries + endpoint en idempotency_keys + REVOKE UPDATE worker en projections) · guard de saldos no-negativos en posting · huella idempotente completa · bloqueo de live keys · anti-mezcla en dbUrls · README/estados de docs. Tests para cada fix (los negativos habrían fallado antes).
2. **F2-11 + AUD-P1-007 + AUD-P2-005** (siguiente incremento): outbox relay con rol dedicado de privilegio mínimo + envelope común + 2-workers-sin-doble-entrega + DLQ.
3. **F2-12** (inbox durable) → luego **F2-09/F2-10** (idempotencia API sobre tabla ya corregida) → **F2-05/F2-06/F2-08** (cierran Gate Ledger).
4. **F1-04b ampliado** (MFA + step-up + rate limiting) antes de cualquier usuario real/sandbox compartido; F1-08 antes de API pública (sin cambio de DAG: ya era prerequisito).
5. F3 permanece congelada hasta: P1-001 ✓(hoy), P1-003, P1-005, P2-011(meta-test), F1-08.
6. **Decisiones humanas abiertas** (no bloquean el plan anterior): política definitiva de live keys (hoy: bloqueadas por completo), modelo MFA/recuperación de cuenta, condiciones del sandbox compartido. Registradas como PEND-004/005/006.
7. **Próxima re-auditoría** (criterio del auditor, adoptado): tras cerrar P1-001/003/004/005/006/007 — estimado al final de Fase 2.
8. ADRs: no se requiere ADR nuevo para los fixes (refuerzan decisiones existentes); el rediseño de roles del worker en F2-11 SÍ llevará ADR-0011.
9. Production gates afectados: Gate Ledger suma la invariante cuenta-tenant-moneda (hoy); Gate Idempotencia hereda AUD-P1-009 (hoy); Gate Multi-tenant suma reducción del worker (F2-11).
