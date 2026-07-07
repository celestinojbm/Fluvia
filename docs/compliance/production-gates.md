# Production Gates

Estado: Activo · Ningún entorno de Fluvia puede declararse "producción" sin completar los gates aplicables (V4 §51). Este documento es el checklist de evidencia; cada ítem enlazará a su prueba cuando exista.

## Estado global: 🔴 PRE-PRODUCCIÓN (Fase 2 — sandbox; live keys bloqueadas por código)

## 1. Gates técnicos mínimos

### Gate Ledger — 🟢 técnico (F2-02…F2-08 completos; revisión formal en Fase 6)

- [x] **Cada transacción balancea por activo/moneda a nivel de MOTOR** (constraint trigger diferido `FLUVIA_UNBALANCED`; probado con SQL crudo incluso como superusuario; compensación cross-moneda rechazada; cabeceras vacías rechazadas — `ledger-invariants.test.ts`, F2-02)
- [x] Inmutabilidad de asientos a nivel motor (`FLUVIA_IMMUTABLE`)
- [x] Modelo causal: `source_type/source_id` + `reverses_tx_id` con FK (F2-01)
- [x] **Coherencia cuenta-tenant-moneda a nivel de MOTOR**: FK compuesta `(account_id, tenant_id, currency)` — ni el superusuario puede enlazar un asiento a una cuenta de otro tenant u otra moneda (migración 0008, AUD-P1-001 — `ledger-invariants.test.ts`)
- [x] **Guarda de saldo no-negativo race-safe** en operaciones que lo exigen (release/refund): `nonNegativeAccounts` bajo locks de cuenta, rollback total (AUD-P1-010 — golden tests en `posting.test.ts`)
- [x] **Replay idempotente con huella causal completa**: reason/source/reverses divergentes ⇒ conflicto, jamás replay silencioso (AUD-P2-001 — `ledger-service.test.ts`)
- [x] **Scripts externos al ORM verifican invariantes** (F2-06): `scripts/verify-ledger-invariants.sql` autocontenido, en CI tras la suite y ejecutable por cron/post-restore; detecta corrupción sembrada (probado en `drift.test.ts`)
- [x] **Rebuild de proyección == ledger** (F2-05): `rebuildProjection` bajo lock de cuenta, property test con transferencias y rebuilds concurrentes; drift check programado (`ledger_projection_drift()` + watcher en worker)
- [x] **Compensaciones vía servicio** (F2-07): espejo exacto, reversión única a nivel de MOTOR (índice único parcial, carrera concurrente probada), no-reversión-de-reversiones, razón obligatoria + auditoría atómica, idempotente (`reversal.test.ts`)
- [x] **Concurrencia sin duplicados ni drift** (F2-08): suite formal reproducible (PRNG seeded) — conservación exacta bajo 120 postings concurrentes, presión de deadlock, carrera masiva de idempotencia N→1, presión mixta con rebuilds y reversal (`concurrency.test.ts`)

### Gate Multi-tenant — 🟢 técnico (revisión formal en Fase 6)

- [x] Tenant A no lee ni escribe datos de Tenant B vía RLS (lectura, escritura por PK, UPDATE masivo, INSERT…SELECT, JOINs, sondas EXISTS, agregados — `tenant-escape.test.ts`)
- [x] Pool de conexiones no fuga contexto (test explícito de la MISMA conexión a través de transacciones A → sin contexto → B)
- [x] Autorización de aplicación (RBAC) activa con matriz verificada celda a celda (F1-04c)
- [x] Tests de bypass administrativo: `withPlatformOperation` exige razón, audita en la misma transacción (riesgo alto) y hace rollback conjunto (F1-06)
- [x] Suite ampliada de tenant escape en CI, incluidos **meta-tests estructurales** que verifican en `pg_catalog` que TODA tabla (presente o futura) con `tenant_id` tiene RLS forzado + política, que ningún rol de runtime tiene DELETE y que app/worker no tienen privilegio alguno sobre credenciales (F1-06)
- [x] **AUD-P1-007 CERRADO (F2-11, ADR-0011)**: NINGÚN rol de runtime tiene BYPASSRLS (meta-test permanente en `tenant-escape.test.ts`); `fluvia_worker` = cascarón sin privilegios; `fluvia_relay` solo ve `outbox_events` (políticas RLS explícitas + UPDATE por columna)
- [x] Relay del outbox sin doble entrega con 2 workers concurrentes (SKIP LOCKED + lease, probado en `packages/outbox/test/relay.test.ts`); dead + replay exclusivamente vía operación de plataforma auditada
- Nota de límite documentado: RLS defiende contra bugs de lógica, no contra ejecución de SQL arbitrario con el rol app (ver `architecture/multi-tenancy.md` §7); mitigación = consultas 100% parametrizadas + revisión Fase 6.

### Gate Idempotencia — 🟢 técnico (F2-09/F2-10; revisión formal en Fase 6)

- [x] Tabla `idempotency_keys` con PK `(tenant_id, endpoint, key)` conforme al contrato de `idempotency.md` (migración 0008, AUD-P1-009)
- [x] **Mismo key + mismo payload → mismo resultado**: replay exacto (status+body persistidos) sin re-ejecutar el handler, probado a nivel servicio y sobre HTTP real (`idempotency.test.ts`, `idempotency-http.test.ts`)
- [x] **Mismo key + payload distinto → rechazado**: hash canónico sha256; 422 `idempotency_key_reuse`; el handler jamás se ejecuta
- [x] **Crash recovery no duplica**: claim+efecto+respuesta en UNA transacción — kill pre-COMMIT ⇒ rollback conjunto y reintento limpio; kill post-COMMIT ⇒ replay. Carrera 8 concurrentes ⇒ exactamente 1 efecto; property test: efectos==1 para toda secuencia de reintentos
- [x] **Pérdida de Redis no duplica**: Redis NO está en el camino (PostgreSQL única fuente, ADR-0006); si algún día se añade fast-path, este ítem se re-verifica con caída simulada

### Gate Conciliación — 🔴

- [ ] Archivo simulado produce discrepancias detectadas (F4-02)
- [ ] Casos creados, sin corrección silenciosa, evidencia de resolución (F4-03)

### Gate Seguridad — 🔴

- [x] Credenciales `live` imposibles de emitir por código (`LiveKeysDisabledError`) hasta pasar gates + decisión humana PEND-004 (AUD-P2-003)
- [x] Anti-mezcla de entornos: arranque falla fuera de local/test sin URLs de BD explícitas (`dbUrlsFromEnv` + `@fluvia/config`, AUD-P2-014)
- [x] **MFA TOTP + step-up + rate limiting** (F1-04b, AUD-P1-006): TOTP RFC 6238 con anti-replay, secreto cifrado en reposo, backup codes de un solo uso, step-up en `keys:manage`, rate limiting por email/IP en auth — todo probado sobre HTTP. Nota Nivel C: el limitador es in-memory mono-instancia; store compartido requerido antes del sandbox compartido (PEND-006)
- [x] **API keys con HMAC server-side** (AUD-P2-015): pepper fuera de la base, versionado de hash con upgrade perezoso v1→v2 probado — dump-resistance para credenciales de integración
- [x] **Purga solo por job auditado** (F1-09): `purge_technical_data()` es la única puerta de DELETE (clases técnicas, predicados fijos, auditoría atómica); clases financieras imborrables incluso con el escape activo (probado); roles dev imposibles de crear fuera de local (guard AUD-P2-008 probado end-to-end)
- [x] **Observabilidad base operativa** (F1-07): métricas agregadas anónimas (sin ids de tenant — probado), alertas baseline definidas (`observability.md` §4). Pendiente para producción: `/metrics` en red interna de scrape y dashboards (F6)
- [x] **Threat model actualizado** (F6): `docs/security/threat-model.md` reescrito por STRIDE contra el sistema implementado y verificado (89 controles citados a código/migración/test), con el **backlog de riesgo residual F6** (§5). Base: inventario relevado + las dos auditorías independientes integradas (0 P1/0 P2 abiertos)
- [x] **Secret/dependency scanning + tenant-escape** (F1-02/F1-06): gitleaks + `pnpm audit --audit-level high` + SBOM SPDX en CI; suite de tenant-escape + meta-tests estructurales en `pg_catalog` (tablas y roles futuros). SSRF: guard completo (`ssrf.ts`, deniega TODAS las IPs resueltas)
- [ ] **Resto (del backlog del threat model §5)**: registro de aceptación de vulnerabilidades High/Critical + escaneo del SBOM (grype) gated; suite de pruebas SSRF (failover V2-N2, TLS self-signed) y de SQL-injection/parametrización; ítems P2 (no-negatividad de motor, step-up sin MFA, rate limiter compartido, PII erasure, guard PCI) antes del sandbox compartido / F5

### Gate Restore — 🟡

- [x] **Procedimiento de restore probado en drill** (F6, cierra la pata restante de AUD-P2-007): backup `pg_dump -Fc` → `pg_restore --exit-on-error` (code=0 asserteado) en base fresca → `verify-ledger-invariants.sql`→`FLUVIA_INVARIANTS_OK` sobre la copia → paridad fuente↔copia (conteos de 4 tablas + Σamount + saldo del marcador + checksums row-level de asientos y transacciones, RPO=0) → drift inyectado DETECTADO + `rebuildProjection` explícito → RLS FORZADO + políticas preservadas. `pnpm --filter @fluvia/api run drill:restore` (`apps/api/drills/restore-drill.ts`, **PASS 7/7** local); runbook [`docs/ops/runbooks/backup-restore.md`](../ops/runbooks/backup-restore.md). Cubre restaurado + ledger verificado + proyecciones reconstruidas + base para conciliación post-restore.
- [ ] **Infra de backup de producción**: cadencia/retención/cifrado en reposo/offsite + PITR/WAL para RPO→segundos — decisión de despliegue (F6/F7), no se simula. El criterio del gate (restaurar + verificar + reconstruir) es idéntico y ya está probado en drill.

## 2. Gates organizacionales y regulatorios (todos 🔴, requieren humanos)

Jurisdicción definida (PEND-001) · revisión legal · contrato con proveedor · ToS · privacy policy · refund policy · KYC/KYB · AML · sanciones · evaluación PCI aplicable · incident response operativo · on-call · monitoring y alertas · reconciliation operativa · load tests · rotación de secretos · gestión de vulnerabilidades · merchant freeze · pending payment procedure · política de retención · access matrix · payout review · procedimiento de disputas · procedimiento de fraude · soporte operativo · plan de continuidad · repositorio de evidencia · revisión de aislamiento · validación de ledger · revisión de idempotencia · certificación con proveedor · separación sandbox-producción.

**Regla operativa:** este archivo se actualiza en el mismo PR que aporta la evidencia de cada ítem; marcar un ítem sin enlace a evidencia es una violación de gobernanza (§2 "no declarar capacidades inexistentes").
