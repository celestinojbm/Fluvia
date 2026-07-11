# Production Gates

Estado: Activo · Ningún entorno de Fluvia puede declararse "producción" sin completar los gates aplicables (V4 §51). Este documento es el checklist de evidencia; cada ítem enlaza a su prueba cuando existe. **Reconciliado con el baseline post-F6 (RA-F6-003, 2026-07-10). F6 APROBADA para el alcance `sandbox cerrado / hardening sandbox` por ratificación de Hermes (2026-07-11, decisión #28; baseline `8f126c4`, CI run #368) — la aprobación NO mueve ningún gate de producción ni de sandbox compartido.**

## Estado global: 🔴 PRE-PRODUCCIÓN — SANDBOX CERRADO (F1–F4 + hardening F6 completos, auditados y ✅ APROBADOS para el alcance sandbox/hardening por Hermes; Fase 5 NO iniciada; live keys bloqueadas por código; exposición pública CONGELADA por decisión #24; producción y sandbox compartido siguen 🔴 BLOQUEADOS)

## 0. Estadios — qué autoriza cada uno (separación RA-F6-003)

### Estadio ACTUAL: sandbox cerrado ✅ APROBADO (F6 hardening ratificado por Hermes — lo único autorizado hoy)

- **F6 APROBADA para este alcance** (ratificación de Hermes 2026-07-11; baseline `8f126c4`, CI run #368; 0 P0/P1/P2 del delta F6). La aprobación es EXCLUSIVA de este estadio: NO habilita el siguiente ni el final.
- Desarrollo y test controlado contra PostgreSQL 16 real; la evidencia del hardening es la CI por commit (suite + invariantes [1]–[9] + 3 drills + gitleaks/audit/licencias-strict/SBOM/grype) + las dos auditorías independientes integradas + la re-auditoría F6 delta + la ratificación corta F6-DELTA-001 (registro de cierre §F6 Final Approval).
- **MockProvider es el ÚNICO proveedor** — no se mueve dinero real.
- **Sin credenciales `live`** — emisión bloqueada por código (`LiveKeysDisabledError`) hasta gates + decisión humana (PEND-004).
- **Sin exposición pública** (freeze decisión #24) · **Fase 5 NO iniciada**.

### Estadio SIGUIENTE: sandbox compartido 🔴 (requiere PEND-006 — decisión humana + gates de exposición)

Pendientes ya documentados en el threat model §5 (ninguno nuevo): `trustProxy` acotado al poner un proxy delante (el keying por `req.ip` de los rate limits lo exige) · Origin-check · CSP con nonce · cookie `Secure` por entorno · store COMPARTIDO como default del rate limiting (el backend Redis ya está probado multi-instancia — TM-03; hoy el default es in-memory mono-instancia) · aserción de `normal_side` en startup · valor definitivo de retención de idempotency keys (>= ventana de retry del cliente, decisión del propietario).

### Estadio FINAL: producción / release público 🔴 (BLOQUEADO)

Bloqueado por (todos ya documentados; nada nuevo): proveedor real NO integrado (F5, tras la matriz jurisdiccional Colombia con verificación legal) · secret manager real pendiente (enfoque decidido en ADR-0012; vendor + integración al desplegar) · credenciales `live` bloqueadas (PEND-004) · **revisión legal LGPLv3 de `@img/sharp-libvips-linux-x64` antes del PRIMER release público/comercial** + obligaciones de atribución registradas (`license-policy.md` / `license-exceptions.json`) · cifrado field-level de credenciales de proveedor (F5) · infra de backup de producción (PITR/offsite) · copia offsite de los anchors del ledger (operador) · los gates de exposición del estadio anterior · TODOS los gates organizacionales/regulatorios de §2.

## 1. Gates técnicos mínimos

### Gate Ledger — 🟢 técnico (F2-02…F2-08 + hardening F6: hash-chain [7], anclaje [8], no-negatividad [9]; revisado en F6 — security review interna + re-auditoría delta)

- [x] **Cada transacción balancea por activo/moneda a nivel de MOTOR** (constraint trigger diferido `FLUVIA_UNBALANCED`; probado con SQL crudo incluso como superusuario; compensación cross-moneda rechazada; cabeceras vacías rechazadas — `ledger-invariants.test.ts`, F2-02)
- [x] Inmutabilidad de asientos a nivel motor (`FLUVIA_IMMUTABLE`)
- [x] Modelo causal: `source_type/source_id` + `reverses_tx_id` con FK (F2-01)
- [x] **Coherencia cuenta-tenant-moneda a nivel de MOTOR**: FK compuesta `(account_id, tenant_id, currency)` — ni el superusuario puede enlazar un asiento a una cuenta de otro tenant u otra moneda (migración 0008, AUD-P1-001 — `ledger-invariants.test.ts`)
- [x] **Guarda de saldo no-negativo race-safe** en operaciones que lo exigen (release/refund): `nonNegativeAccounts` bajo locks de cuenta, rollback total (AUD-P1-010 — golden tests en `posting.test.ts`)
- [x] **Replay idempotente con huella causal completa**: reason/source/reverses divergentes ⇒ conflicto, jamás replay silencioso (AUD-P2-001 — `ledger-service.test.ts`)
- [x] **Scripts externos al ORM verifican invariantes — checks [1]–[9]** (F2-06 + F6): `scripts/verify-ledger-invariants.sql` autocontenido — balanceo, append-only, proyección==recomputo, **hash-chain [7]**, **anclaje externo [8]**, **no-negatividad de cuentas protegidas [9]** — en CI tras la suite, sobre la copia del restore drill y ejecutable por cron/post-restore; detecta corrupción sembrada (`drift.test.ts` + teeth tests de [7]/[8]/[9]). La lista protegida de [9] está guardada contra drift chart↔SQL por el meta-test `packages/ledger/test/chart-nonneg-sync.test.ts` (RA-F6-005)
- [x] **Rebuild de proyección == ledger** (F2-05): `rebuildProjection` bajo lock de cuenta, property test con transferencias y rebuilds concurrentes; drift check programado (`ledger_projection_drift()` + watcher en worker)
- [x] **Compensaciones vía servicio** (F2-07): espejo exacto, reversión única a nivel de MOTOR (índice único parcial, carrera concurrente probada), no-reversión-de-reversiones, razón obligatoria + auditoría atómica, idempotente (`reversal.test.ts`)
- [x] **Concurrencia sin duplicados ni drift** (F2-08): suite formal reproducible (PRNG seeded) — conservación exacta bajo 120 postings concurrentes, presión de deadlock, carrera masiva de idempotencia N→1, presión mixta con rebuilds y reversal (`concurrency.test.ts`)

### Gate Multi-tenant — 🟢 técnico (revisado en F6 — security review interna + re-auditoría delta)

- [x] Tenant A no lee ni escribe datos de Tenant B vía RLS (lectura, escritura por PK, UPDATE masivo, INSERT…SELECT, JOINs, sondas EXISTS, agregados — `tenant-escape.test.ts`)
- [x] Pool de conexiones no fuga contexto (test explícito de la MISMA conexión a través de transacciones A → sin contexto → B)
- [x] Autorización de aplicación (RBAC) activa con matriz verificada celda a celda (F1-04c)
- [x] Tests de bypass administrativo: `withPlatformOperation` exige razón, audita en la misma transacción (riesgo alto) y hace rollback conjunto (F1-06)
- [x] Suite ampliada de tenant escape en CI, incluidos **meta-tests estructurales** que verifican en `pg_catalog` que TODA tabla (presente o futura) con `tenant_id` tiene RLS forzado + política, que ningún rol de runtime tiene DELETE y que app/worker no tienen privilegio alguno sobre credenciales (F1-06)
- [x] **AUD-P1-007 CERRADO (F2-11, ADR-0011)**: NINGÚN rol de runtime tiene BYPASSRLS (meta-test permanente en `tenant-escape.test.ts`); `fluvia_worker` = cascarón sin privilegios; `fluvia_relay` solo ve `outbox_events` (políticas RLS explícitas + UPDATE por columna)
- [x] Relay del outbox sin doble entrega con 2 workers concurrentes (SKIP LOCKED + lease, probado en `packages/outbox/test/relay.test.ts`); dead + replay exclusivamente vía operación de plataforma auditada
- [x] **Parametrización + roles deny-by-default (F6)**: candado ESTÁTICO (`sql-parameterization.test.ts` — en un literal SQL de sentencia completa toda `${}` es un identificador vetado o un número de config no parametrizable, nunca un valor; ADEMÁS prohíbe concatenación y composición desde fragmentos) + suite BEHAVIORAL de SQLi (`sql-injection.test.ts` — payloads hostiles round-trip como dato, tabla intacta, RLS respetado) + meta-tests de roles que enumeran TODOS los `fluvia_%` de `pg_catalog` (rol nuevo = build roto; ninguno super/bypassrls/createrole/DELETE) + lint de arquitectura (ninguna ruta instancia el pool admin)
- Nota de límite documentado: RLS defiende contra bugs de lógica, no contra ejecución de SQL arbitrario con el rol app (ver `architecture/multi-tenancy.md` §6.5); mitigación = consultas 100% parametrizadas (ahora con GATE estático + behavioral, F6) + revisión Fase 6.

### Gate Idempotencia — 🟢 técnico (F2-09/F2-10; revisado en F6 — RA-F6-001 cerró las cotas transaccionales completas vía `withTenantTransaction`, delta audit aprobado)

- [x] Tabla `idempotency_keys` con PK `(tenant_id, endpoint, key)` conforme al contrato de `idempotency.md` (migración 0008, AUD-P1-009)
- [x] **Mismo key + mismo payload → mismo resultado**: replay exacto (status+body persistidos) sin re-ejecutar el handler, probado a nivel servicio y sobre HTTP real (`idempotency.test.ts`, `idempotency-http.test.ts`)
- [x] **Mismo key + payload distinto → rechazado**: hash canónico sha256; 422 `idempotency_key_reuse`; el handler jamás se ejecuta
- [x] **Crash recovery no duplica**: claim+efecto+respuesta en UNA transacción — kill pre-COMMIT ⇒ rollback conjunto y reintento limpio; kill post-COMMIT ⇒ replay. Carrera 8 concurrentes ⇒ exactamente 1 efecto; property test: efectos==1 para toda secuencia de reintentos
- [x] **Pérdida de Redis no duplica**: Redis NO está en el camino (PostgreSQL única fuente, ADR-0006); si algún día se añade fast-path, este ítem se re-verifica con caída simulada
- [x] **Retención + salud de huérfanos (F6, threat model §5)**: retención configurable (`IDEMPOTENCY_RETENTION_HOURS`, default 24 h, fijada explícita en `expires_at`) con la regla «>= ventana de retry del cliente» documentada (valor final = decisión del dueño antes de PEND-006); `IdempotencyWatchdog` + `sweep_idempotency_orphans()` (0041) alertan sobre claims `in_progress` envejecidos (>1 h) que bloquean su key hasta la purga (`idempotency-watchdog.test.ts`)

### Gate Conciliación — 🟢 técnico (F4 completa — criterio de salida cumplido; reconciliación contra proveedor REAL llega con F5)

- [x] Archivo simulado produce discrepancias detectadas (F4-02: motor/batch/casos; drill `reconciliation-discrepancy` **9/9** ejecutado — runbook con Drill ✅)
- [x] Casos creados, sin corrección silenciosa, evidencia de resolución (F4-03: four-eyes como CHECK en BD, ajustes solo vía cuentas transitorias `suspense`/`recon.differences`, panel admin con gate `reconciliation:manage`; evidencia CI por incremento en `audit-closure-register-v1.md`)

### Gate Seguridad — 🔴

- [x] Credenciales `live` imposibles de emitir por código (`LiveKeysDisabledError`) hasta pasar gates + decisión humana PEND-004 (AUD-P2-003)
- [x] Anti-mezcla de entornos: arranque falla fuera de local/test sin URLs de BD explícitas (`dbUrlsFromEnv` + `@fluvia/config`, AUD-P2-014)
- [x] **MFA TOTP + step-up + rate limiting** (F1-04b, AUD-P1-006): TOTP RFC 6238 con anti-replay, secreto cifrado en reposo, backup codes de un solo uso, step-up en `keys:manage`, rate limiting por email/IP en auth — todo probado sobre HTTP. Nota: el limitador tiene backend COMPARTIDO en Redis (TM-03, ADR-0002 — `RedisFixedWindowLimiter`, fail-open logueado, probado multi-instancia contra Redis real en CI); el in-memory queda como default mono-instancia
- [x] **Ciclo de vida de sesión endurecido (F6, threat model §5)**: **idle-timeout** (`SESSION_IDLE_TIMEOUT_MS`, default 30 min — sesión ociosa inválida antes del expiry absoluto; reloj refrescado en cada uso) + **`POST /v1/auth/logout-all`** (revoca TODAS las sesiones del usuario, auditado; hook para revoke-all-al-cambiar-credencial). Probado (`auth-service.test.ts` idle, `auth-routes.test.ts` logout-all). Queda acoplado al canal de email: recuperación de cuenta + respuesta neutral en `register` (§5 Auth)
- [x] **API keys con HMAC server-side** (AUD-P2-015): pepper fuera de la base, versionado de hash con upgrade perezoso v1→v2 probado — dump-resistance para credenciales de integración
- [x] **Purga solo por job auditado** (F1-09): `purge_technical_data()` es la única puerta de DELETE (clases técnicas, predicados fijos, auditoría atómica); clases financieras imborrables incluso con el escape activo (probado); roles dev imposibles de crear fuera de local (guard AUD-P2-008 probado end-to-end)
- [x] **Observabilidad base operativa** (F1-07): métricas agregadas anónimas (sin ids de tenant — probado), alertas baseline definidas (`observability.md` §4). Pendiente para producción: `/metrics` en red interna de scrape y dashboards (F6)
- [x] **Threat model actualizado** (F6): `docs/security/threat-model.md` reescrito por STRIDE contra el sistema implementado y verificado (89 controles citados a código/migración/test), con el **backlog de riesgo residual F6** (§5). Base: inventario relevado + las dos auditorías independientes integradas (0 P1/0 P2 abiertos)
- [x] **Secret/dependency scanning + tenant-escape** (F1-02/F1-06): gitleaks + `pnpm audit --audit-level high` + SBOM SPDX en CI; suite de tenant-escape + meta-tests estructurales en `pg_catalog` (tablas y roles futuros). SSRF: guard completo (`ssrf.ts`, deniega TODAS las IPs resueltas) + bundle F6 probado (failover solo-sin-conexión entre IPs validadas — cierra V2-N2 —, `rejectUnauthorized:true` explícito contra receptor TLS self-signed, ingest con rate limit por IP y test del body >1 MiB). Nota: el keying por `req.ip` de los rate limits exige `trustProxy` acotado al poner un proxy delante (threat model §5, bloqueante de PEND-006)
- [x] **Cadena de suministro gated (F6)**: grype rompe el build ante High/Critical no aceptadas (registro de aceptación versionado: `.grype.yaml` vacío + proceso en [`vulnerability-acceptance.md`](../security/vulnerability-acceptance.md)); `.gitleaks.toml` versionado (excepciones por code review, no flags ad-hoc); imagen base pineada por digest; Dependabot semanal (npm/actions/docker); redacción del logger ampliada y PROBADA (`log-redaction.test.ts`)
- [x] **Los 6 P2 del threat model §5 cerrados (F6)**: TM-01 (gate de cobertura de no-negatividad), TM-02 (step-up por password sin MFA, migr. 0040), TM-03 (rate limiter compartido en Redis, probado multi-instancia), TM-04 (restore + worker-down drills en CI), TM-05 (PII erasure por pseudonimización), TM-06 (guard PCI de datos de tarjeta) — cada uno con tests + evidencia CI en el registro
- [x] **Licencias transitivas gated (RA-F6-004, F6)**: política versionada (`license-policy.md`) + `pnpm licenses:check --strict` en CI (licencia prohibida, desconocida o restringida SIN decisión humana = build roto) + reporte reproducible (`license-report.md`) + registro de decisiones (`license-exceptions.json` — 2 excepciones aceptadas por el propietario el 2026-07-10; la aceptación NO autoriza producción y la LGPL exige **revisión legal antes del primer release**)
- [ ] **Resto (P3 del threat model §5)**: breaker compartido al escalar el worker; `trustProxy` acotado + Origin-check/CSP-nonce/`Secure` (PEND-006). Nota de reconciliación: el ADR de secret-manager (**ADR-0012**) y las TRES rotaciones de claves (webhook-enc, MFA, pepper) quedaron **HECHOS en F6**; lo pendiente es el vendor + integración al desplegar (F5)

### Gate Restore — 🟢 técnico (infra de backup de prod pendiente, F6/F7)

- [x] **Procedimiento de restore probado en drill, ejecutado EN CI por commit** (F6, cierra la pata restante de AUD-P2-007; TM-04 del threat model): backup `pg_dump -Fc` → `pg_restore --exit-on-error` (code=0 asserteado) en base fresca → `verify-ledger-invariants.sql`→`FLUVIA_INVARIANTS_OK` sobre la copia → paridad fuente↔copia (conteos de 4 tablas + Σamount + saldo del marcador + checksums row-level de asientos y transacciones, RPO=0) → drift inyectado DETECTADO + `rebuildProjection` explícito → RLS FORZADO + políticas preservadas. `pnpm --filter @fluvia/api run drill:restore` (`apps/api/drills/restore-drill.ts`, **PASS 7/7**) — ahora corre en el job `quality` de CI tras la suite (sobre la BD poblada por los tests, como una copia real), no solo local; runbook [`docs/ops/runbooks/backup-restore.md`](../ops/runbooks/backup-restore.md). Cubre restaurado + ledger verificado + proyecciones reconstruidas + base para conciliación post-restore.
- [x] **Drill de resiliencia «worker caído» ejecutado EN CI por commit** (F6, TM-04 — el último drill que quedaba manual): reinicio (`checkReady`) → el relay del outbox y el processor del inbox **DRENAN su backlog solos** (delivered/processed) → el `ProjectionDriftWatcher` **DETECTA** el drift acumulado durante la caída → reparación **EXPLÍCITA** (`rebuildProjection`, nunca automática) deja el watcher limpio. `pnpm --filter @fluvia/api run drill:worker-down` (`apps/api/drills/worker-down-drill.ts`, **PASS 5/5**), solo-PG (sin Redis), sobre roles de mínimo privilegio; drenado **dirigido por objetivo** (robusto al backlog heredado de la suite, no un cap ciego) y deja la BD consistente para el restore drill; runbook [`docs/ops/runbooks/worker-down.md`](../ops/runbooks/worker-down.md).
- [ ] **Infra de backup de producción**: cadencia/retención/cifrado en reposo/offsite + PITR/WAL para RPO→segundos — decisión de despliegue (F6/F7), no se simula. El criterio del gate (restaurar + verificar + reconstruir) es idéntico y ya está probado y verificado en CI.

## 2. Gates organizacionales y regulatorios (todos 🔴, requieren humanos)

Jurisdicción definida ✅ **Colombia** (decisión #15, ex PEND-001; la matriz jurisdiccional aún requiere verificación legal — bloquea F5) · revisión legal · contrato con proveedor · ToS · privacy policy · refund policy · KYC/KYB · AML · sanciones · evaluación PCI aplicable · incident response operativo · on-call · monitoring y alertas · reconciliation operativa · load tests · rotación de secretos · gestión de vulnerabilidades · merchant freeze · pending payment procedure · política de retención · access matrix · payout review · procedimiento de disputas · procedimiento de fraude · soporte operativo · plan de continuidad · repositorio de evidencia · revisión de aislamiento · validación de ledger · revisión de idempotencia · certificación con proveedor · separación sandbox-producción.

**Regla operativa:** este archivo se actualiza en el mismo PR que aporta la evidencia de cada ítem; marcar un ítem sin enlace a evidencia es una violación de gobernanza (§2 "no declarar capacidades inexistentes").
