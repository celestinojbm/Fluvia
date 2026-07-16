# F6.5C — Plan de ejecución: onboarding mock + showroom (sandbox cerrado)

Estado: **PLAN CON DECISIONES DEL PROPIETARIO RESUELTAS (B1–B5) — ninguna implementación iniciada** · Fecha: 2026-07-16 (rev. 3: reset ejecutable con conexión de mantenimiento + merchant onboarding recuperable; rev. 2: decisiones B1–B5 + corrección del modelo transaccional de C2) · Autor: sesión constructora (Claude) · Alcance autorizado: **solo planificación (docs-only)**.

Este documento es el plan técnico ejecutable de F6.5C («Onboarding mock + demo data showroom», definida en `docs/phases/f6-5-sandbox-product-plan.md` §F6.5C). Cada afirmación sobre el código cita archivo y símbolo verificados en el baseline. Lo que no está verificado se marca como pregunta o supuesto.

---

## 1. Baseline y estado previo

- **Baseline exacto**: `8ec1ed4ef4df7867ff3611475f1c702b27987135` — merge del PR #42 a `claude/new-session-haeo7h`. CI post-merge run 29453210633 verde (ambos jobs completed/success).
- **F6.5B: CERRADA para sandbox cerrado.** Tercera delta externa de Hermes: `PASS WITH FINDINGS`, gate 0 P0 / 0 P1 / 0 P2 / 0 P3. Findings: RA-F65B-EXT-001 CLOSED · RA-F65B-EXT-002 CLOSED · RA-F65B-DELTA2-001 CLOSED · RA-F65B-DELTA2-002 CLOSED · RA-F65B-DELTA3-001 = hardening no bloqueante.
- **F6.5C: autorizada ÚNICAMENTE para planificación.** La implementación (F6.5C1…C4) exige autorización individual del propietario por PR.
- Guardrails permanentes vigentes: MockProvider único proveedor; sin credenciales reales; no live/producción/exposición pública/deploy/sandbox compartido; freeze #24; F5.1–F5.4 bloqueadas; emails reales prohibidos; auditoría histórica inmutable; `docs/compliance/license-exceptions.json` protegido; badge «SANDBOX — dinero simulado» en toda UI futura; no tocar `docs/audits/independent-audit-v1/`, `packages/ledger/`, `packages/idempotency/`, `packages/db/migrations/`, `.github/`.

---

## 2. Arquitectura observada (descubrimiento con citas)

### 2.1 Identity y sesión

**Login y sesiones — existen y son maduros.**

- Rutas: `POST /v1/auth/login`, `/mfa/verify`, `/register`, `/verify-email`, `/mfa/{setup,activate,disable,step-up}`, `/step-up/password`, `/logout`, `/logout-all`, `GET /v1/auth/session` — registradas por `registerAuthRoutes` (`apps/api/src/routes/auth.ts`), servidas por `AuthService` (`packages/auth/src/service.ts`).
- Password hashing: scrypt de `node:crypto` con parámetros OWASP (`SCRYPT_N=32768`, `r=8`, `p=1`, key 64, salt 16) y formato versionado `scrypt$N$r$p$salt$hash` — `hashPassword`/`verifyPassword`/`dummyPasswordHash` (`packages/auth/src/passwords.ts`). `verifyPassword` usa `timingSafeEqual`.
- Política de password: `PasswordSchema = z.string().min(10).max(128)` (`packages/auth/src/schemas.ts:7`) — longitud como control principal, sin reglas de composición (estilo NIST). Email: `z.string().trim().email().max(254)`.
- Sesiones: tabla `sessions` en Postgres (`packages/db/migrations/0004_auth_sessions.sql`), token `fluvia_sess_…` con solo SHA-256 en reposo (`packages/auth/src/tokens.ts`), TTL absoluto 24 h + idle-timeout 30 min (`AuthServiceOptions`, `service.ts:174-201`), revocación (`logout`, `revokeAllSessions`). Cookie del dashboard: `fluvia_session` httpOnly, `SameSite=lax`, `secure` en producción, maxAge 8 h (`apps/dashboard/app/api/session/route.ts:30-36`); el token jamás llega al JS del navegador (proxy server-side `proxySessionPost`, `apps/dashboard/app/lib/proxy.ts`).
- MFA/TOTP: RFC 6238 propio (`packages/auth/src/totp.ts`), secreto cifrado AES-256-GCM con keyring rotable, retos `mfa_challenges`, backup codes, anti-replay por step. Step-up: `security.stepUp` (`apps/api/src/security.ts:90-98`, ventana 15 min) exigido en `keys:manage` y en el ciclo de vida de MFA; step-up por password para usuarios sin MFA (`stepUpWithPassword`, `service.ts:815`).
- Rate limiting: `FixedWindowLimiter` / `RedisFixedWindowLimiter` (`apps/api/src/rate-limit.ts`); `DEFAULT_AUTH_RATE_LIMITS` (`apps/api/src/routes/auth.ts:29-34`): login 5/60 s por email + 20/60 s por IP, **register 5/60 s por IP**, mfa/step-up 20/60 s por IP. Lockout por cuenta (`failed_login_attempts`/`locked_until`, 5 intentos / 15 min).
- Auditoría de auth: catálogo `AUDIT_ACTIONS` (`packages/audit/src/index.ts:10-52`) incluye `user.registered`, `user.email_verified`, `auth.login_succeeded/failed`, `auth.account_locked`, `auth.mfa_*`, `auth.step_up*`. `insertAuditEvent` corre con el client de la MISMA transacción; tabla `audit_events` inmutable por triggers + grants (`0006_audit_log.sql`). La auditoría NO tiene hash-chain (el hash-chain es solo del ledger, 0042/0043).
- CSRF (dashboard): `assertTrustedMutationRequest` (`apps/dashboard/app/lib/csrf.ts:133`) — `Sec-Fetch-Site: same-origin` estricto, Origin COMPLETO exacto (`canonicalDashboardOrigin`, fail-closed), header `X-Fluvia-CSRF: 1` — aplicado a los 7 proxies mutantes de F6.5B1/B2 + resend (cerrado por la tercera delta de Hermes).

**Capacidad de signup existente (clave para C1):**

- `POST /v1/auth/register` EXISTE (`auth.ts:63-79` → `AuthService.register`, `service.ts:218-249`): crea `users` (email + password_hash) + token de verificación de un solo uso en `email_verification_tokens` + audit `user.registered`. **El token se expone en la respuesta SOLO en `local`/`test`** (`exposeVerificationToken`, `apps/api/src/app.ts:231-238`) — el canal de email real no existe (mock por diseño; pendiente F3/F5).
- `POST /v1/auth/verify-email` EXISTE (`AuthService.verifyEmail`, `service.ts:251-275`): consume el token y sella `users.email_verified_at`. El login EXIGE email verificado (`EmailNotVerifiedError`, `service.ts:338-340`).
- **NO existe UI de signup**: `apps/dashboard/app/` solo tiene `login/` y `logout/`; no hay `register/` ni `signup/`.
- **NO existe símbolo `createUser`** genérico; la creación de usuarios vive en `register` (plano `fluvia_auth`), `createOrganizationWithOwner` (plano plataforma, sin password) y `seedDemo` (SQL directo admin).

**Conclusión**: SÍ existe un servicio reutilizable para crear usuarios con credenciales — `AuthService.register` + `verifyEmail`. F6.5C1 NO debe inventar un plano de auth paralelo: debe consumir estas rutas existentes desde una UI nueva.

### 2.2 Organizaciones y merchants

- **Creación de organización**: `createOrganizationWithOwner(adminPool, input)` (`packages/identity/src/platform.ts:23`) — plano de PLATAFORMA (pool admin; las políticas RLS no permiten a `fluvia_app` insertar en `organizations` ni escribir `users`). Atómico (BEGIN/COMMIT manual, `platform.ts:32-68`): `organizations` + `users` (email, SIN password) + `memberships` con `role='owner'`. Valida `CreateOrganizationSchema` (`packages/identity/src/schemas.ts:11`; slug `/^[a-z0-9][a-z0-9-]{1,48}$/`). Errores tipados `OrganizationSlugTakenError` / `EmailTakenError`.
  - **Sin llamador de producción**: solo tests (`packages/identity/test/identity.test.ts`). NO existe `POST /v1/organizations`. NO emite auditoría (no hay acción `organization.created` en `AUDIT_ACTIONS`).
- **Memberships**: tabla `memberships` (`0003_identity_tenancy.sql:46-56`), roles CHECK `owner|admin|developer|finance|support|analyst|read_only`, `UNIQUE (tenant_id, user_id)`. **NO hay servicio de gestión de memberships** (invitar/añadir/cambiar rol/revocar) ni auditoría `membership.*`; solo lectura: `IdentityService.getMemberRole`/`listMembers` (`packages/identity/src/tenant-service.ts:190,200`), `AuthService.listMemberships` (`service.ts:921`, función SQL `auth_list_memberships`).
- **Merchants**: tabla `merchants` (`0003:63-74`, defaults Colombia: country `CO`, currency `COP`, `UNIQUE (tenant_id, name)`). Servicio: `IdentityService.createMerchant(tenantId, input, audit?)` (`tenant-service.ts:89`) en `withTenantTransaction`, con audit `merchant.created` atómico. Endpoint EXISTENTE: `POST /v1/organizations/:orgId/merchants` (`apps/api/src/routes/organizations.ts:95`, permiso `merchants:write`).
- **Merchant «funcional»**: la fila de `merchants` + el chart de cuentas materializado por `PostingService.ensureChart(tenantId, merchantId, currency)` (`packages/ledger/src/chart-of-accounts.ts:52-54`; usado por seeds en `packages/seeds/src/seed.ts:110`). API keys y webhook endpoints son POR TENANT (organización), no por merchant.
- **RBAC**: matriz declarativa `ROLE_PERMISSIONS` (`packages/identity/src/rbac.ts:45-69`); guard `security.org(permission)` (`apps/api/src/security.ts:100-112`) con 404 indistinguible anti-BOLA.
- **Tenant isolation**: `withTenantTransaction` (`packages/db/src/pool.ts:86`, `SET LOCAL app.tenant_id`) + RLS FORZADO con política `tenant_isolation` (`0002_enable_rls.sql:88-106`); `users` global con política `user_visible_via_membership` SELECT-only (`0003:121-131`); escritura de `users` vedada a `fluvia_app`.
- **Transacciones**: `withTenantTransaction` (plano tenant) y `withPlatformOperation(adminPool, {reason}, fn)` (`packages/audit/src/index.ts:211` — plano plataforma, exige `reason`, audita `platform.operation` riesgo alto en la misma tx). No existe `withAdminTransaction` genérico sin auditoría — y no debe crearse.

### 2.3 Seeds (estado actual)

- Entrypoint: `pnpm seed` → `packages/seeds/src/run.ts` → `seedDemo(env, pools)` (`packages/seeds/src/seed.ts:77-148`).
- **Determinismo**: UUID v5 sobre namespace fijo — `seedUuid(key)` (`packages/seeds/src/deterministic.ts:13-23`, `SEED_NAMESPACE` en `:7`); claves fijas (`'org:demo-fluvia'`, …). Cero `faker`/`Math.random`/`Date.now` en datos (única no-determinista: la sal de scrypt del password, persistida solo en el alta inicial por `ON CONFLICT DO NOTHING`, `seed.ts:87-94`).
- **Identidad por SQL directo (pool admin)**: `INSERT INTO organizations/users/memberships/merchants … ON CONFLICT DO NOTHING` (`seed.ts:81-105`). **Ledger por la VÍA NORMATIVA**: `LedgerService` + `PostingService` con rol `fluvia_app` bajo RLS (`seed.ts:107-132`) — `ensureChart` + `capturePayment` + `releaseSettlement` con idempotency keys fijas (`'seed:demo:capture-1'`, `'seed:demo:release-1'`).
- **Idempotencia probada**: segunda corrida añade CERO filas y devuelve ids idénticos (`packages/seeds/test/seed.test.ts:67-89`; replay por huella en `LedgerService.postTransaction`, `packages/ledger/src/service.ts:206,219,370`).
- **Guard de entorno**: `SeedEnvironmentError` si `env ∉ {local,test}` ANTES de tocar la BD (`seed.ts:78`, probado con pools rotos en `seed.test.ts:57-65`) + anti-mezcla de credenciales en config (`packages/db/src/config.ts:36-93`, `packages/config/src/index.ts:269-275`) + guard de roles en migraciones (GUC `fluvia.environment`, `packages/db/src/migrate.ts:40`).
- **NO existe** ningún mecanismo de reset (`demo:reset`, truncate, drop): DELETE/TRUNCATE están bloqueados por trigger en las tablas core; la limpieza entre corridas de test se hace creando tenants frescos (`packages/db/src/testing.ts:8-10`).
- **Datos actuales del seed**: 1 org (`Demo Fluvia`), 2 users (`owner@demo.fluvia.test`/`dev@demo.fluvia.test`), 2 memberships, 1 merchant (`Demo Store`), 2 tx de ledger (capture 500.000 COP con fees 14.500/19.500 + release 300.000) → `pending=180500`, `available=300000` (verificado en `seed.test.ts:91-96`). **NO crea** intents, sesiones, links, refunds, disputes, payouts, webhooks, customers ni API keys.
- **Invariantes**: `scripts/verify-ledger-invariants.sql` (checks [1]–[9]) corre en CI tras la suite (`.github/workflows/ci.yml:81-82`).
- **Tests**: PostgreSQL 16 y Redis 7 REALES (docker-compose local; service containers en CI, `ci.yml:24-46`); `createTestContext()` (`packages/db/src/testing.ts:52-114`).

### 2.4 Producto y recorrido de demo (inventario)

Piezas EXISTENTES del recorrido onboarding → link → checkout → pago → webhook → refund → disputa → payout → conciliación:

| Pieza | Estado | Evidencia |
| --- | --- | --- |
| Payment links (API + UI crear + página pública `/l/[id]`) | ✅ completo | `PaymentLinkService` (`packages/payments-core/src/payment-links.ts`), `apps/api/src/routes/payment-links.ts`, `apps/dashboard/app/o/[orgId]/payment-links/`, `apps/checkout/app/l/[id]/` |
| Checkout alojado (status/confirm por `client_secret` + UI) | ✅ completo | `CheckoutSessionService` (`packages/payments-core/src/checkout.ts`), `apps/checkout/app/c/[id]/`, `checkout-client.tsx` (tokens `tok_approve`/`tok_decline`/`tok_pse`) |
| MockProvider (tokens mágicos deterministas) | ✅ | `MockPaymentProvider` (`packages/payments-core/src/provider.ts`): `tok_approve`, `tok_decline`, `tok_decline_insufficient`, `tok_pse` (async), `tok_timeout`; refs `mock_<sha256(attemptId)>` |
| Webhooks salientes (endpoints, firma, deliverer, retries, UI, resend) | ✅ completo | `packages/webhooks/src/*`, `apps/worker/src/main.ts:186,346`, `apps/dashboard/app/o/[orgId]/webhook-{endpoints,events}/` |
| Refunds (servicio 2 fases + API + UI) | ✅ completo | `RefundService` (`packages/payments-core/src/refunds.ts`), `apps/api/src/routes/refunds.ts`, `apps/dashboard/app/o/[orgId]/refunds/` |
| Disputes (motor + lectura + evidencia + UI) | ✅ motor; apertura SOLO por webhook firmado | `DisputeService` (`packages/payments-core/src/disputes.ts`: `openFromProvider`, `resolve`), `apps/api/src/routes/disputes.ts` (sin endpoint de apertura — intencional), ingesta `POST /v1/providers/mock/webhook` (`apps/api/src/routes/provider-webhooks.ts`) vía `createMockInboxRegistration` (`packages/payments-core/src/mock-webhook.ts`) |
| Payouts (servicio + API; Mock aprueba síncrono → `paid`) | ✅ backend; UI solo lectura | `PayoutService` (`packages/payments-core/src/payouts.ts`), `apps/api/src/routes/payouts.ts`, `apps/dashboard/app/o/[orgId]/payouts/` |
| Conciliación (motor + API + watchdog + UI lectura + casos four-eyes) | ✅ | `ReconciliationService` (`packages/reconciliation/src/index.ts`), `apps/api/src/routes/settlements.ts`, `apps/worker/src/reconciliation-watchdog.ts`, `apps/dashboard/app/o/[orgId]/{reconciliation,cases}/` |
| Badge SANDBOX global | ✅ | `SandboxBadge` en `apps/dashboard/app/lib/sandbox-badge.tsx` + `apps/dashboard/app/layout.tsx:14`; espejo en `apps/checkout/app/sandbox-badge.tsx` |

**Lo que FALTA para una demo desde cero en <10 minutos** (gaps reales):

1. **Onboarding autoservicio**: no hay UI de signup ni endpoint/UI de creación de organización; hoy la ÚNICA vía para tener org+merchant+usuario es `pnpm seed` (org fija `Demo Fluvia`).
2. **Dataset showroom**: el seed no crea intents/links/sesiones/refunds/disputes/payouts/webhooks — las listas del dashboard arrancan vacías.
3. **Ramas por webhook entrante sin tooling**: disputa (`dispute.opened|won|lost`) y pago async `tok_pse` requieren fabricar a mano un HMAC firmado contra `/v1/providers/mock/webhook`; existe la primitiva `signWebhookPayload` (`packages/inbox/src/signature.ts`) pero ningún helper ejecutable.
4. **Reset**: no existe `demo:reset`.
5. **Guion**: no hay guía paso a paso del recorrido; `docker-compose.yml` no levanta dashboard (:3200) ni checkout (:3100), y no hay script `dev` raíz que orqueste los 4 procesos.
6. Menores (fuera de alcance F6.5C, candidatos F6.5D): UI de miembros, UI de crear payout, carga de settlement lines desde dashboard.

---

## 3. Threat model de F6.5C (sandbox cerrado — controles honestos)

Principio: no se diseña «seguridad de producción»; se reutilizan los controles existentes sin debilitarlos y se declaran los residuales. El sandbox es LOCAL y no expuesto (freeze #24).

| # | Amenaza | Mitigación (control concreto) | Residual declarado |
| --- | --- | --- | --- |
| 1 | Account enumeration | Login ya anti-enumeración (`dummyPasswordHash` + timing, `service.ts:303-306`; lockout). El signup reutiliza `register` SIN cambiar su contrato de errores. | `register` ES un oráculo de existencia (email duplicado) — deuda ya documentada en HANDOFF («neutralizar `register` necesita el canal de email»); aceptado para sandbox cerrado, acotado por rate limit 5/60 s/IP. C1 NO debe añadir oráculos nuevos en la UI. |
| 2 | Signup spam | Rate limit existente por IP en `/v1/auth/register` (`DEFAULT_AUTH_RATE_LIMITS`, `auth.ts:29-34`) + sandbox local sin exposición. Sin CAPTCHA (capacidad simulada — Nivel A). | Abuso local irrelevante (atacante = operador). |
| 3 | Password validation inconsistente | UNA fuente: `PasswordSchema` (`schemas.ts:7`) re-validada en el servicio (`RegisterSchema.parse`, `service.ts:219`). La UI de signup NO define reglas propias; muestra los errores del catálogo. | — |
| 4 | Bypass de email verification | El sello lo pone SOLO `AuthService.verifyEmail` consumiendo el token de un solo uso; el flujo mock encadena register→verify server-side en el BFF con el MISMO servicio (decisión B3), jamás `UPDATE users` directo. **El token JAMÁS llega al navegador ni a logs/auditoría/errores** (queda confinado al handler BFF); la respuesta al browser no lo contiene. Login sigue exigiendo `email_verified_at`; sin auto-login tras signup. | El token viaja en la respuesta API→BFF en local/test (`app.ts:231-238`) — por diseño, mock declarado en la UI. |
| 5 | Creación duplicada de organización | **Idempotencia NATURAL de la operación** (no `@fluvia/idempotency` — su contrato exige `tenantId` y `withTenantTransaction`, `packages/idempotency/src/index.ts:92,187-205`, inaplicable pre-tenant; ver §4-C2): `SELECT … FOR UPDATE` de la fila del usuario serializa requests concurrentes del mismo usuario; lookup de membership `owner` existente ⇒ mismo payload normalizado devuelve la org existente (replay natural), payload distinto ⇒ 409 `onboarding_already_completed`; `organizations_slug_key` UNIQUE (motor) + `OrganizationSlugTakenError` (`platform.ts:42`) protege colisiones globales. | No hay replay byte-for-byte de una respuesta persistida (declarado; suficiente para onboarding). |
| 6 | Owner membership incompleta (org huérfana) | Org + membership owner se insertan en UNA transacción (patrón `createOrganizationWithOwner`, `platform.ts:32-68`); rollback total ante fallo. Test de rollback obligatorio (patrón RA-F65B-003). | — |
| 7 | Tenant escape | Sin cambios al modelo: RLS FORZADO + `withTenantTransaction`; la operación de plataforma corre acotada a la función sancionada y auditada. Tests de aislamiento (404 indistinguible) en las rutas nuevas. | — |
| 8 | Privilegios excesivos | El creador recibe `owner` SOLO de la org que crea; ningún cambio a `ROLE_PERMISSIONS`; el endpoint nuevo exige sesión (no API key — los planos no se cruzan, `security.ts:60-64`). | — |
| 9 | CSRF en signup/onboarding | Todo proxy mutante NUEVO del dashboard nace con `assertTrustedMutationRequest` + `X-Fluvia-CSRF` (patrón cerrado por Hermes, `csrf.ts:133`). Nota: signup es pre-sesión (login-CSRF, misma naturaleza que `POST /api/session`, deuda separada documentada) — el guard se aplica igualmente por consistencia. | Login-CSRF del `POST /api/session` preexistente = deuda separada, NO se amplía aquí. |
| 10 | Creación parcial usuario/org/merchant | Dos operaciones compensables (decisión #1): (a) signup atómico por `register` (una tx en el plano auth); (b) **Paso A** de C2: org+membership owner atómicos en UNA transacción de plataforma; (c) **Paso B** de C2: merchant + chart en el plano tenant, re-entrante mediante el helper explícito `ensureMerchantForOnboarding` (§4-C2 — `createMerchant` solo NO es re-entrante: lanza `MerchantNameTakenError` ante duplicado, `tenant-service.ts:116-118`) + `ensureChart` idempotente + retry desde el wizard. NO existe transacción distribuida entre adminPool y appPool. Un usuario sin org es un estado VÁLIDO (CTA de onboarding); una org sin owner es IMPOSIBLE (atomicidad del Paso A). | Merchant/chart pueden quedar pendientes si el operador abandona el wizard — la org sigue válida, el dashboard muestra onboarding incompleto y permite reintentar (re-entrada por estado real, no por memoria). |
| 11 | Secretos en respuestas o logs | Sin secretos nuevos. El password jamás se loguea (redacción `LOG_REDACT` probada, `log-redaction.test.ts`); el token de verificación solo en la respuesta API→BFF local/test (existente) y NUNCA hacia el navegador, logs, auditoría ni mensajes de error (regla B3); `redactSummary` en auditoría (`packages/audit/src/index.ts:114`); las acciones nuevas `organization.created`/`membership.created` llevan solo IDs de tenant/org/user — sin email, password, token ni secretos en summary/metadata (regla B5). | — |
| 12 | Seeds que burlen servicios | Regla C3: TODO el dinero y recursos de producto entran por servicios normativos (`PaymentIntentService`/`CheckoutSessionService`/`RefundService`/`PayoutService`/`DisputeService.openFromProvider`/`ReconciliationService`), igual que hoy el ledger (`seed.ts:16-18`). **Decisión B4**: C3 NO añade SQL directo nuevo para users/orgs/memberships/merchants — usa `createOrganizationForUser` (C2) y los servicios tenant existentes; el seed mínimo actual (`seedDemo`) no se reescribe. | — |
| 13 | Reset contra una base incorrecta | **Guard de 10 condiciones fail-closed, ejecutado COMPLETO antes de abrir cualquier conexión** (decisión B2, §6): env ∈ {local,test} · confirmación literal `--confirm RESET_FLUVIA_SHOWROOM` · target exacto `fluvia_showroom` o `fluvia_showroom_test_*` · target fuera de la denylist · todas las URLs target con el MISMO dbname · todos los hosts loopback · maintenance y target con mismo host+puerto · maintenance db distinta del target · maintenance db en allowlist explícita (preferiblemente solo `postgres`) · ninguna URL target apunta a `postgres`/`template0`/`template1`/`fluvia`. Tras el guard, re-comprobación de `current_database()` en la conexión de mantenimiento antes del DROP. Config anti-mezcla existente impide defaults dev fuera de local/test (`config.ts:36-93`). | — |
| 14 | Reset destructivo fuera del sandbox | El único OBJETIVO destructivo posible es la base DEDICADA `fluvia_showroom` (o efímera de test) — `fluvia`/`postgres`/`template0`/`template1` en denylist dura como target; `postgres` solo puede actuar como base de MANTENIMIENTO (allowlist), jamás como target del DROP; identificador validado por regex y citado con `escapeIdentifier` (sin interpolación cruda). El comando vive en `@fluvia/seeds` (jamás en la imagen de despliegue del profile `app`) y NUNCA usa `TRUNCATE`/`DELETE` sobre una BD operativa (los triggers append-only lo impiden por diseño) — el reset es DROP/CREATE DATABASE de la base dedicada (ver §6, decisión B2). | Un superusuario local puede destruir su propia BD local — inherente e irrelevante en sandbox. |
| 15 | Dataset no determinista | Patrón existente: `seedUuid` (UUID v5) + claves e idempotency keys FIJAS + tokens Mock deterministas (`mock_<sha256>`); determinismo definido sobre IDs/estados/balances (los timestamps `now()` quedan fuera del contrato, como hoy). Test: dos corridas ⇒ cero filas nuevas (patrón `seed.test.ts:67-89`). | Timestamps no reproducibles (declarado). |
| 16 | Referencias rotas entre entidades | Las FKs compuestas del esquema (intent↔merchant↔tenant, refund↔intent, session↔intent) hacen imposible referenciar entre tenants; el seed compone por servicios que validan bajo RLS. Test de integridad post-seed. | — |
| 17 | Violación de invariantes del ledger | El seed jamás postea SQL al ledger; `scripts/verify-ledger-invariants.sql` [1]–[9] se ejecuta tras el seed en el smoke (C4) y ya corre en CI. | — |
| 18 | Dinero o proveedor real accidental | `MockPaymentProvider` es el único adapter; keys `live` bloqueadas por código (`LiveKeysDisabledError`, `packages/identity/src/api-keys.ts:171-173`); sin SDKs de proveedor (guardrail §13.2 del plan F6.5); sin secretos reales en el repo (gitleaks en CI). | — |
| 19 | Afirmaciones engañosas de producción | Badge «SANDBOX — dinero simulado» global ya renderizado en TODA página (dashboard `layout.tsx:14` + checkout) y presente en las vistas nuevas de signup/onboarding; el guion (C4) declara explícitamente «demo sandbox, dinero simulado, sin proveedor real». | — |

---

## 4. División de F6.5C en PRs (validada, con un ajuste)

La división propuesta (C1→C4) es correcta con UN ajuste de frontera: **la creación de organización NO va unida al signup** (ver decisión #1) — C1 queda estrictamente identidad; C2 concentra el único endpoint backend nuevo. Esto minimiza la superficie por PR y evita contratos intermedios inseguros (cada PR deja el sistema en un estado completo y coherente: tras C1 un usuario sin org es válido y el dashboard lo comunica).

### F6.5C1 — Onboarding mock de identidad (signup UI)

- **Alcance**: página `signup` del dashboard que consume `POST /v1/auth/register` + `POST /v1/auth/verify-email` existentes, encadenados server-side en el BFF (decisión B3). Reglas B3: el token de verificación JAMÁS se envía al navegador ni se escribe en logs/auditoría/errores; la respuesta al browser no lo contiene; la UI muestra «Verificación de email simulada — SANDBOX»; al terminar redirige a `/login` (SIN auto-login); `AuthService.register`/`verifyEmail` sin bypass; guard Origin/CSRF en la mutación BFF; rate limit del API intacto. Cero backend nuevo en el API. Badge SANDBOX (global, ya presente). El dashboard raíz muestra CTA de onboarding cuando `GET /v1/organizations` devuelve vacío.
- **Archivos esperados**: `apps/dashboard/app/signup/page.tsx` + `signup-client.tsx`; `apps/dashboard/app/api/signup/route.ts` (proxy BFF con `assertTrustedMutationRequest`); ajustes en `apps/dashboard/app/page.tsx` (CTA sin org) y `apps/dashboard/app/lib/api.ts`; tests `apps/dashboard/test/signup*.test.tsx` + ruta.
- **No toca**: `packages/auth`, `packages/identity`, `apps/api` (salvo cero o mínimo), migraciones, deps.
- **Tests**: componente+axe (patrón existente), proxy (register→verify→login feliz; email duplicado muestra error del catálogo sin oráculo nuevo; rate limited 429), CSRF del proxy nuevo.

### F6.5C2 — Organization y merchant onboarding

C2 se estructura en **dos pasos transaccionales SEPARADOS** — no existe transacción distribuida entre adminPool y appPool:

**Paso A — plano de PLATAFORMA (adminPool), una única transacción**: servicio `createOrganizationForUser` en `packages/identity/src/platform.ts` — variante de `createOrganizationWithOwner` para un usuario EXISTENTE autenticado. Dentro de la MISMA transacción: organización + membership `owner` + auditoría `organization.created` y `membership.created` (acciones nuevas en `AUDIT_ACTIONS`, actor `user`, con IDs de tenant/org/user suficientes y SIN email/password/token/secretos en summary/metadata — decisión B5; un fallo de auditoría revierte org y membership). SIN merchant ni ledger dentro de esta transacción.

**Paso B — plano TENANT (appPool), re-entrante mediante un helper de onboarding EXPLÍCITO**. Hecho verificado: `IdentityService.createMerchant` (`tenant-service.ts:89-122`) NO es re-entrante por sí solo — hace `INSERT … RETURNING` y ante unique violation (`merchants_tenant_id_name_key`) lanza `MerchantNameTakenError` (`tenant-service.ts:116-118`); nunca devuelve el merchant existente, y atrapar la violation deja la transacción abortada. Por tanto `UNIQUE (tenant_id, name)` + `createMerchant` NO constituye idempotencia natural. C2 define un helper/orquestador específico de onboarding — nombre de trabajo **`ensureMerchantForOnboarding`** (el nombre final puede cambiar; la semántica queda fijada) — SIN alterar el contrato general de `createMerchant`:

1. Dentro de una transacción tenant-scoped: normaliza y valida name/country/defaultCurrency (misma `CreateMerchantSchema`).
2. Intenta crear el merchant SIN carrera insegura y SIN depender de atrapar una unique violation dentro de una transacción ya abortada — estrategia recomendada compatible con PostgreSQL: `INSERT … ON CONFLICT (tenant_id, name) DO NOTHING RETURNING …`, seguido (si no devolvió fila) de `SELECT` del existente y comparación de los campos normalizados; o una estrategia equivalente demostrablemente correcta.
3. Si no existía ⇒ lo crea y emite `merchant.created` UNA sola vez (misma tx).
4. Si ya existe y sus campos normalizados COINCIDEN ⇒ devuelve el existente, sin duplicar auditoría (recuperación natural).
5. Si ya existe pero country/currency u otro campo contractual DIFIERE ⇒ conflicto estable de onboarding (respuesta 409 estable).
6. Concurrencia con payload idéntico ⇒ UN solo merchant (el árbitro es el índice único; el perdedor del ON CONFLICT recupera por SELECT).

**Chart**: `PostingService.ensureChart` sigue siendo un paso POSTERIOR idempotente (`chart-of-accounts.ts:52-54`). **Contrato de recuperación**: si el merchant se crea y `ensureChart` falla, organización y merchant permanecen VÁLIDOS; un reintento recupera el merchant existente con payload coincidente, NO duplica `merchant.created` y vuelve a ejecutar `ensureChart`; el wizard solo termina cuando merchant + chart están completos; no existe transacción distribuida adminPool/appPool. El dashboard muestra onboarding incompleto y permite reintentar (re-entrada por estado real, no por memoria). **C3 reutiliza este helper de onboarding — no llama ciegamente a `createMerchant`.**

**Contrato de idempotencia/retry de `POST /v1/organizations`** (idempotencia NATURAL de la operación; NO usa `@fluvia/idempotency` — su contrato exige `tenantId` y corre por `withTenantTransaction` escribiendo `idempotency_keys` bajo RLS tenant-scoped con efecto y respuesta en esa misma tx, `packages/idempotency/src/index.ts:92,187-205`; antes de crear la org no existe tenant y la creación es una operación de plataforma con adminPool — el patrón F6.5A-bis NO aplica pre-tenant. No se propone modificar `packages/idempotency`, ni una tabla/migración de idempotencia de plataforma, ni exigir `Idempotency-Key` en este endpoint dentro de este milestone):

1. Endpoint autenticado por sesión y SOLO para usuario con email verificado.
2. La operación bloquea la fila del usuario con `SELECT … FOR UPDATE` dentro de la transacción de plataforma — las requests concurrentes del mismo usuario quedan SERIALIZADAS por ese lock.
3. Busca una organización donde el usuario ya tenga membership `owner`.
4. Si ya existe una org owner con el MISMO slug y nombre normalizados ⇒ devuelve la org existente, NO crea otra, NO duplica auditoría (recuperación/replay natural, señalizada en la respuesta).
5. Si ya existe una org owner pero el payload DIFIERE ⇒ 409 `onboarding_already_completed`; NO crea otra organización.
6. Si no existe ⇒ crea org + membership owner + auditoría, todo en UNA transacción de plataforma.
7. La restricción única del slug (`organizations_slug_key`) sigue protegiendo colisiones globales (slug de OTRO usuario ⇒ conflicto seguro).
8. NO se promete replay byte-for-byte de una respuesta persistida — es idempotencia natural de la operación de onboarding (declarado).

- **Contrato API** (`POST /v1/organizations`, sesión): request `{ organizationName, slug }` (reusa la validación de `CreateOrganizationSchema` sin `ownerEmail`); respuesta 201 `{ organization: {id, name, slug}, membership: {role: 'owner'} }` (200 con marca de replay en la recuperación natural — forma exacta a fijar contra el catálogo v1); errores: `validation_error`, conflicto de slug (mapeo a código existente o nuevo — decidir contra el catálogo v1), 409 `onboarding_already_completed`.
- **Tests planificados (contra PG real)**: dos requests concurrentes con el mismo payload ⇒ UNA sola org; retry después del commit ⇒ misma org y CERO auditoría duplicada; segundo payload diferente ⇒ 409 `onboarding_already_completed`; colisión de slug perteneciente a otro usuario ⇒ conflicto seguro (sin filtrar existencia más allá del conflicto); fallo de auditoría ⇒ rollback de org y membership; usuario no verificado ⇒ rechazo; usuario no autenticado ⇒ rechazo. Paso B (`ensureMerchantForOnboarding` + chart): fallo simulado después del merchant y antes del chart ⇒ retry posterior completa el chart, CERO merchant duplicado y CERO auditoría duplicada; dos requests concurrentes con mismo payload ⇒ un solo merchant; payload distinto sobre merchant existente ⇒ conflicto estable; carrera por el unique constraint recuperada correctamente (perdedor del ON CONFLICT recupera por SELECT); chart ya existente ⇒ éxito no-op; la org continúa válida si el Paso B falla.
- **Archivos esperados**: `packages/identity/src/platform.ts` (+tests), helper `ensureMerchantForOnboarding` en `packages/identity/src/` (módulo propio de onboarding o `tenant-service.ts`, sin alterar el contrato de `createMerchant`), `packages/audit/src/index.ts` (catálogo +2 acciones), `apps/api/src/routes/organizations.ts` (+ruta), `apps/api/src/app.ts` (wiring si hace falta), `apps/dashboard/app/onboarding/…` + proxies BFF con CSRF, tests de API y de dashboard.
- **No toca**: migraciones (el esquema ya soporta todo), `packages/{ledger,idempotency}` (solo consume), auth/MFA.

### F6.5C3 — Showroom seed y demo reset

- **Alcance**: (a) `seedShowroom` en `@fluvia/seeds` — dataset rico determinista construido VÍA SERVICIOS sobre la org dedicada `Showroom Fluvia` (ver §5, decisión B4); (b) comando `demo:reset` sobre la base dedicada `fluvia_showroom` con guard de 10 condiciones y conexión de mantenimiento separada (ver §6, decisión B2); (c) mantiene `seedDemo` existente intacto (no se reescribe); (d) reutiliza el helper `ensureMerchantForOnboarding` de C2 — no llama ciegamente a `createMerchant`.
- **Archivos esperados**: `packages/seeds/src/showroom.ts`, `packages/seeds/src/reset.ts`, `packages/seeds/src/run-*.ts` (CLIs), `packages/seeds/package.json` (scripts `showroom`, `demo:reset`), scripts raíz en `package.json`, tests `packages/seeds/test/showroom.test.ts` + `reset.test.ts`.
- **No toca**: migraciones, ledger, servicios de dominio (solo los consume), `.github/`.

### F6.5C4 — Guion y smoke del recorrido

- **Alcance**: (a) `docs/product/sandbox-demo-guide.md` — guion paso a paso de demo desde cero en <10 min (arranque, reset, login, recorrido completo incl. rama disputa/PSE vía helper firmado); (b) smoke e2e LOCAL (patrón `apps/*/e2e/README.md`: el CI no tiene navegador para e2e full; el smoke de API sí es CI-gated); (c) evidencia de invariantes: ejecutar `scripts/verify-ledger-invariants.sql` tras seed/reset y registrar el resultado; (d) helper de webhook firmado para las ramas async (usa `signWebhookPayload`, `packages/inbox/src/signature.ts`) — como utilidad de demo/test, no como capacidad de producto.
- **Archivos esperados**: `docs/product/sandbox-demo-guide.md`, `packages/seeds/src/mock-webhook-helper.ts` (o script en `apps/api/drills/`), smoke test de API, actualización STATE/HANDOFF/BACKLOG de cierre.

Cada PR: suite verde + `format/lint/build` + invariantes [1]–[9] + revisión adversarial interna + evidencia CI en el registro + autorización de merge del propietario (guardrails §13 del plan F6.5).

---

## 5. Dataset showroom (entidades y estados exactos)

**Decisión B4 (resuelta)**: org DEDICADA `Showroom Fluvia`, con IDs UUID v5 propios (`seedUuid`), SEPARADA de `Demo Fluvia`; el seed mínimo existente (`seedDemo`) NO se reescribe. C3 NO añade SQL directo nuevo para users/orgs/memberships/merchants: la identidad del showroom se crea con `createOrganizationForUser` (C2) y los servicios tenant existentes. Merchant COP; TODO el producto vía servicios con idempotency keys fijas `seed:showroom:*`:

- **Customers**: 3 (con/sin email, uno soft-deleted) — `CustomerService`.
- **Payment links**: 2 activos + 1 deshabilitado — `PaymentLinkService.createIn`/`disable`.
- **Checkout sessions**: 1 `open`, 1 `completed`, 1 `expired` — `CheckoutSessionService` (+`confirmByClientSecret` con `tok_approve`; la expirada con TTL mínimo + barrido).
- **Payment intents**: `succeeded` (×3, montos distintos), `failed` (`tok_decline` y `tok_decline_insufficient`), `processing` con attempt `submitted` (`tok_pse`, queda pendiente de webhook — estado async visible), `canceled` (×1) — `PaymentIntentService` + `PaymentConfirmationService`.
- **Refunds**: 1 total `succeeded`, 1 parcial `succeeded`, 1 `canceled` (sin disponible) — `RefundService`.
- **Disputes**: 1 `open`, 1 `under_review` (con evidencia), 1 `won`, 1 `lost` — `DisputeService.openFromProvider`/`submitEvidence`/`resolve` (la vía verificada, misma que el inbox handler).
- **Payouts**: 1 `paid`, 1 `failed` — `PayoutService` (Mock aprueba síncrono).
- **Webhook endpoint**: 1 endpoint local (receptor de pruebas en localhost; el SSRF guard permite http/local SOLO en local por diseño — verificar en implementación contra `packages/webhooks/src/ssrf.ts`) con eventos `delivered` + 1 evento `dead` fabricado (endpoint deshabilitado) para demostrar el resend.
- **Conciliación**: 1 settlement report reconciliado con las 4 clases (`matched`, `amount_mismatch`, `missing_in_ledger`, `missing_at_provider`) → casos operativos, 1 ajuste four-eyes propuesto+aprobado — `ReconciliationService` + `OperationalCaseService` + `CaseAdjustmentService`.
- **API key**: 1 key `test` creada vía `ApiKeyService.create` (secreto impreso UNA vez por el CLI del seed, como hace `run.ts` con los passwords demo).
- **Auditoría**: poblada como efecto natural de los servicios (no se fabrica).
- **Post-condición**: invariantes [1]–[9] verdes; balances finales documentados en el propio seed (patrón `seed.ts:137-146`).

---

## 6. Política de `demo:reset`

- **Decisión B2 (resuelta por el propietario)**: reset = **DROP/CREATE**, pero SOLO sobre una base DEDICADA **`fluvia_showroom`** — nunca la base principal `fluvia`. Razón de fondo intacta: los triggers append-only prohíben DELETE/TRUNCATE por diseño (decisión de núcleo que NO se debilita); un «reset» dentro de una BD operativa exigiría bypass de superusuario fila a fila = burlar los servicios (amenaza #12).
- **Realidad de PostgreSQL — el DROP exige una conexión de MANTENIMIENTO distinta**: PostgreSQL no permite `DROP DATABASE` sobre la base a la que está conectada la propia sesión. Por tanto el reset distingue DOS planos de conexión con tipos/nombres EXPLÍCITOS (ningún valor se deriva de forma ambigua de una única URL):
  - **Base OBJETIVO (target)** — la única que puede destruirse: `fluvia_showroom`, o una efímera de test `fluvia_showroom_test_<id>`. TODAS las URLs runtime del showroom (los 7 roles de `dbUrlsFromEnv()` — admin/app/worker/relay/auth/inbox/webhook, `packages/db/src/config.ts:36-93` — o las que el showroom realmente use) deben apuntar a esa MISMA base objetivo. **Denylist como OBJETIVO destructivo**: `fluvia`, `postgres`, `template0`, `template1` y cualquier nombre que no sea exactamente `fluvia_showroom` o el prefijo de test autorizado.
  - **Conexión de MANTENIMIENTO** — una URL SEPARADA y explícita (variable propia, p. ej. `SHOWROOM_MAINTENANCE_DATABASE_URL`; nombre final en C3) hacia una base que NO es la objetivo, con allowlist explícita de su dbname (preferiblemente SOLO `postgres`). `postgres` está permitido ÚNICAMENTE como base de mantenimiento y JAMÁS puede interpretarse como target del DROP. La maintenance URL solo puede usar host loopback y debe apuntar al MISMO host y puerto/cluster que la base objetivo. **Mecanismo reutilizable ya sancionado en el repo**: `packages/db/test/migration-guard.test.ts:32-38,70` — pool de mantenimiento (`createPool` sobre una URL admin de otra base) que ejecuta `CREATE DATABASE` y `DROP DATABASE … WITH (FORCE)`, con la URL de la base efímera construida por reemplazo del pathname; el reset formaliza ese patrón con URLs explícitas en vez de derivación.
- **Guard fuerte (10 condiciones, fail-closed, ejecutado COMPLETO antes de abrir CUALQUIER conexión)**:
  1. `env ∈ {local,test}` — patrón `SeedEnvironmentError` probado pre-conexión (`seed.test.ts:57-65`);
  2. confirmación literal obligatoria: `--confirm RESET_FLUVIA_SHOWROOM`;
  3. target exacto `fluvia_showroom` o `fluvia_showroom_test_<id>`;
  4. el target NO pertenece a la denylist;
  5. TODAS las URLs target tienen el MISMO dbname;
  6. TODOS los hosts (target y maintenance) son loopback (`localhost`, `127.0.0.1`, `::1`);
  7. maintenance y target comparten host y puerto;
  8. la base de mantenimiento es DISTINTA del target;
  9. la base de mantenimiento pertenece a una allowlist explícita (preferiblemente solo `postgres`);
  10. NINGUNA URL target apunta a `postgres`/`template0`/`template1`/`fluvia`.

  Cualquier fallo ⇒ abort sin abrir conexión alguna.

- **Secuencia posterior al guard**: (1) abrir ÚNICAMENTE la conexión de mantenimiento; (2) re-comprobar `current_database()` y que NO coincide con el target; (3) terminar de forma controlada las conexiones activas al target si hace falta (`WITH (FORCE)` o `pg_terminate_backend` dirigido); (4) `DROP DATABASE` target; (5) `CREATE DATABASE` target; (6) cerrar la conexión de mantenimiento; (7) ejecutar migraciones usando las URLs target; (8) ejecutar el seed por servicios; (9) ejecutar invariantes [1]–[9].
- **Sin interpolación SQL insegura**: el nombre de la base se valida ESTRICTAMENTE como identificador (regex exacta del target autorizado) y se cita con el mecanismo adecuado de PostgreSQL (`escapeIdentifier` de `pg` / semántica `quote_ident`) — nunca interpolación cruda de strings.
- **Tests planificados del reset**: (a) fail-closed, cada condición violada por separado aborta ANTES de conectar (patrón pools rotos de `seed.test.ts:57-65`): maintenance db igual al target ⇒ abort; maintenance con host o puerto distinto ⇒ abort; target `postgres`/`fluvia`/`template0`/`template1` ⇒ abort; target no autorizado ⇒ abort; URLs target con dbnames distintos ⇒ abort; host no loopback ⇒ abort; confirmación ausente o incorrecta ⇒ abort; prueba de que `postgres` SÍ es aceptado como maintenance db pero NUNCA como target; (b) **test de integración del reset REAL en CI contra una base efímera `fluvia_showroom_test_<id>`** (creada y destruida por el propio test): guard → maintenance → comprobación `current_database()` antes del DROP → DROP/CREATE → migrate → seed por servicios → invariantes verdes → segunda corrida idéntica; (c) prueba de que el test NUNCA toca la base principal del job de CI (aserción sobre los dbnames usados). 
- `demo:reset` NUNCA se incluye en la imagen Docker del profile `app`.

---

## 7. Decisiones (respuestas a las 17 preguntas)

1. **¿Signup y creación de org: una operación o dos?** DOS. El signup vive en el plano `fluvia_auth` (`register`); la org en el plano plataforma. Un usuario sin org es un estado válido y visible (CTA de onboarding); una org sin owner es imposible (atomicidad de C2). Unirlas obligaría a cruzar dos planos de privilegio en una tx o duplicar `register` — exactamente el «plano de auth paralelo» que se quiere evitar.
2. **¿Qué servicio crea usuarios?** `AuthService.register` (`packages/auth/src/service.ts:218`) + `verifyEmail` (`:251`). Se reutilizan tal cual desde la UI (C1). No se crea `createUser` nuevo.
3. **¿Qué servicio crea organizaciones y memberships?** `createOrganizationWithOwner` (`packages/identity/src/platform.ts:23`) es el patrón, pero crea un usuario nuevo sin password: C2 añade la variante `createOrganizationForUser(adminPool, {userId, name, slug})` (org + membership owner atómicos + auditoría) en el mismo archivo, reutilizando validación y errores.
4. **¿Endpoint nuevo?** UNO en el API: `POST /v1/organizations` (plano sesión, usuario con email verificado; idempotencia NATURAL — ver §4-C2; SIN `Idempotency-Key` en este milestone). El resto reutiliza: `POST /v1/auth/register`, `POST /v1/auth/verify-email`, `POST /v1/organizations/:orgId/merchants`. Más los proxies BFF del dashboard (signup, onboarding), que no son superficie del API core.
5. **¿Migración?** NO. El esquema ya soporta todo (users/orgs/memberships/merchants; `email_verified_at`; FKs). El catálogo de auditoría es código TS (`AUDIT_ACTIONS`), no DDL. `ensureChart` del merchant se materializa en el Paso B de C2 (plano tenant, pool app bajo el tenant nuevo — como hace el seed en `seed.ts:110`), re-entrante, sin DDL. Tampoco se propone tabla de idempotencia de plataforma. Si algo exigiera DDL ⇒ ADR + autorización previa (guardrail).
6. **¿«Email verificado» sin email real?** El proxy BFF de signup encadena `register` → `verify-email` server-side usando el token que el API ya devuelve SOLO en local/test (`app.ts:231-238`). El sello lo pone el servicio real (`verifyEmail`, token de un solo uso consumido) — mismo mecanismo, canal de entrega mock declarado. Ningún `UPDATE users` directo; ningún flag nuevo de «saltar verificación».
7. **¿Qué impide account enumeration?** En login: `dummyPasswordHash` + timing + lockout (existentes). En signup: el oráculo de `register` (email duplicado) es deuda PREEXISTENTE documentada, acotada por rate limit y por el carácter local del sandbox; C1 no lo amplía ni lo neutraliza (neutralizarlo honestamente requiere canal de email = F5). Se declara en el PR.
8. **¿Cómo se limita signup abuse?** Rate limit existente 5/60 s/IP sobre `register` (`auth.ts:29-34,66`) + lockout + sandbox local sin exposición pública (freeze #24). Sin CAPTCHA (sería capacidad simulada).
9. **¿Cómo se evita usuario-sin-org / org-sin-owner?** Org-sin-owner: imposible por transacción única org+membership (+ test de rollback). Usuario-sin-org: estado VÁLIDO Y comunicado (CTA de onboarding en el dashboard raíz); el wizard es re-entrante por estado real.
10. **¿Cómo se garantiza auditoría?** Acciones nuevas `organization.created` y `membership.created` en `AUDIT_ACTIONS` + `insertAuditEvent` con el client de la MISMA tx de creación (patrón `merchant.created`, `tenant-service.ts:105-112`) + test de rollback (fallo de auditoría revierte la mutación — patrón RA-F65B-003). El signup ya audita (`user.registered`, `user.email_verified`).
11. **¿Cómo se garantiza idempotencia?** `POST /v1/organizations`: idempotencia NATURAL de la operación (lock `FOR UPDATE` de la fila del usuario + lookup de membership owner + slug UNIQUE; mismo payload ⇒ replay natural, payload distinto ⇒ 409 — contrato completo en §4-C2). **NO usa `@fluvia/idempotency`**: su contrato exige `tenantId`, abre `withTenantTransaction`, escribe `idempotency_keys` bajo RLS tenant-scoped y exige efecto+respuesta en esa misma tx (`packages/idempotency/src/index.ts:92,187-205`) — pre-tenant no hay tenant y la creación es una operación de plataforma con adminPool; no se modifica `packages/idempotency` ni se crea infraestructura de idempotencia de plataforma en F6.5C. Seeds: UUID v5 + `ON CONFLICT DO NOTHING` + idempotency keys fijas `seed:showroom:*` en las operaciones de dinero (replay verificado por huella, `service.ts:370`). Merchant: helper `ensureMerchantForOnboarding` (§4-C2 — `createMerchant` solo NO es re-entrante: lanza `MerchantNameTakenError`, `tenant-service.ts:116-118`; el helper usa `INSERT … ON CONFLICT DO NOTHING RETURNING` + SELECT/comparación); chart: `ensureChart` re-entrante.
12. **¿Cómo se bloquea `demo:reset` fuera del sandbox?** Guard de 10 condiciones fail-closed pre-conexión con separación explícita target/maintenance (decisión B2, §6): env local/test · confirmación literal · target exacto autorizado · target fuera de denylist · mismo dbname en todas las URLs target · hosts loopback · maintenance con mismo host+puerto · maintenance ≠ target · maintenance en allowlist (solo `postgres` preferido) · ninguna URL target en {`postgres`,`template0`,`template1`,`fluvia`}; tras el guard, re-comprobación de `current_database()` antes del DROP; identificador validado + `escapeIdentifier`; más la anti-mezcla de config existente. Probado con el patrón de `seed.test.ts:57-65` (el guard salta antes de conectar) + test de integración del reset real contra base efímera `fluvia_showroom_test_<id>` en CI, nunca contra la base principal del job.
13. **¿Determinismo sin SQL directo?** Los datos de PRODUCTO entran por los servicios normativos con inputs deterministas: `seedUuid` para IDs propios, idempotency keys fijas, tokens Mock deterministas (referencias `mock_<sha256(attemptId)>`). El único SQL directo permitido sigue siendo el de IDENTIDAD del seed actual (o los servicios de C2 si ya están mergeados). Contrato de determinismo: IDs/estados/balances idénticos entre corridas; timestamps excluidos (declarado).
14. **¿Entidades y estados exactos del showroom?** §5.
15. **¿Qué tests usan PostgreSQL y Redis reales?** Todos los de integración, como ya es norma (service containers `postgres:16` + `redis:7` en `ci.yml:24-46`): C1 (rutas proxy + register/verify contra API+PG real), C2 (atomicidad/rollback/aislamiento/idempotencia/auditoría contra PG real), C3 (determinismo ×2 corridas, guard de reset, invariantes post-seed vía `psql`), C4 (smoke API end-to-end del recorrido; el e2e de navegador es LOCAL por diseño — el CI no tiene navegador, patrón documentado en `apps/checkout/e2e/README.md`). Redis: solo lo ya cubierto (rate limiter compartido).
16. **¿Qué incrementos necesitan revisión adversarial interna?** Los cuatro (disciplina de la casa), con foco reforzado: C1 (superficie de auth/CSRF/enumeración), C2 (plano plataforma + RBAC + atomicidad — la revisión MÁS importante), C3 (guard destructivo + fidelidad de servicios del seed). C4 ligera (docs+smoke).
17. **¿Puntos que vuelven al propietario antes de programar?** Las cinco preguntas B1–B5 fueron planteadas y **RESUELTAS por el propietario el 2026-07-15** (§10). No queda ningún punto bloqueante para autorizar C1 tras el merge de este plan.

---

## 8. Criterios de salida de F6.5C (conjunto)

1. Un operador nuevo, partiendo de un clon limpio, ejecuta el guion y completa la demo en <10 minutos: signup → org → merchant → payment link → checkout `tok_approve` → webhook entregado → refund → disputa (helper firmado) → payout → conciliación.
2. `demo:reset` reconstruye el showroom determinista sobre `fluvia_showroom`; dos corridas del seed no duplican nada.
3. Invariantes [1]–[9] verdes tras seed y tras reset (evidencia registrada).
4. Suite completa + `format/lint/build` verdes por PR; CI run verde registrado en `audit-closure-register-v1.md` por incremento.
5. Cero cambios en zonas protegidas; badge SANDBOX visible en toda vista nueva; revisión adversarial interna por PR sin P0/P1 abiertos.

## 9. Riesgos y fuera de alcance

**Riesgos**: (a) C2 toca el plano plataforma — el riesgo más alto del milestone; mitigado por atomicidad+auditoría+revisión adversarial dedicada; (b) el oráculo de enumeración de `register` queda expuesto en una UI — residual aceptado y declarado (sandbox local); (c) `demo:reset` destructivo — acotado por decisión B2 a la base dedicada `fluvia_showroom` con guard de 10 condiciones (separación target/maintenance) y denylist de la base principal; (d) flakes conocidos de la suite (`payouts-redriver`, carrera `fluvia_guard_probe`) pueden ensuciar evidencia — re-ejecutar según HANDOFF; (e) el seed showroom alarga la suite — mantenerlo como test propio acotado.

**Fuera de alcance F6.5C**: gestión de miembros/invitaciones (sin servicio hoy; candidato F6.5D o posterior), UI de crear payout, carga de settlement desde dashboard, export CSV y docs de cierre (F6.5D), MFA en la UI del dashboard (gap preexistente declarado), canal de email real (F5), neutralización del oráculo de `register` (F5), CSRF app-wide de los proxies históricos (deuda separada), todo lo listado en §12 del plan F6.5 (proveedor real, sandbox compartido, deploy).

## 10. Decisiones del propietario B1–B5 — RESUELTAS (2026-07-15)

- **B1 — C1 autorizada en principio como próximo incremento**, condicionada a: merge de este PR de plan (PR #44) + CI post-merge verde + rama NUEVA desde ese baseline + PR separado + nueva autorización de merge tras revisión. **C1 NO se inicia en este PR.**
- **B2 — `demo:reset` = DROP/CREATE sobre base DEDICADA `fluvia_showroom`**, con guard endurecido de 10 condiciones fail-closed pre-conexión y separación explícita entre base OBJETIVO y conexión de MANTENIMIENTO (necesaria porque PostgreSQL no permite dropear la base de la propia sesión; `postgres` solo como maintenance, jamás como target; denylist de `fluvia`/`postgres`/`template0`/`template1` como objetivo; confirmación literal `--confirm RESET_FLUVIA_SHOWROOM`) y secuencia maintenance → `current_database()` re-check → DROP/CREATE → migrate → servicios normativos → invariantes. Test de integración del reset REAL contra base efímera `fluvia_showroom_test_<id>` en CI, además de los fail-closed; nunca contra la base principal del job. Detalle en §6.
- **B3 — Verificación mock APROBADA**: register → verify-email encadenado server-side en el BFF. Reglas: token jamás al navegador ni a logs/auditoría/errores; respuesta sin token; UI «Verificación de email simulada — SANDBOX»; al terminar redirige a login SIN auto-login; `AuthService.register`/`verifyEmail` sin bypass; guard Origin/CSRF en la mutación BFF; rate limit del API intacto. Detalle en §4-C1.
- **B4 — Org showroom DEDICADA `Showroom Fluvia`** aprobada: IDs UUID v5 propios, separada de `Demo Fluvia`; el seed mínimo existente no se reescribe; C3 no añade SQL directo nuevo para users/orgs/memberships/merchants (usa los servicios de C2 y servicios tenant existentes). Detalle en §5.
- **B5 — Auditoría AUTORIZADA**: añadir `organization.created` y `membership.created` a `AUDIT_ACTIONS`, con condiciones: misma transacción de plataforma; actor `user`; IDs de tenant/org/user suficientes; sin email/password/token/secretos en summary/metadata; fallo de auditoría revierte organización y membership; la auditoría histórica no se modifica. Detalle en §4-C2 Paso A.

## 11. Checklist de guardrails (se verifica en cada PR de F6.5C)

- [ ] MockProvider único proveedor; sin SDKs de pago; sin credenciales reales.
- [ ] Sin emails reales (canal mock declarado).
- [ ] Sin cambios en `docs/audits/independent-audit-v1/`, `docs/compliance/license-exceptions.json`, `packages/ledger/`, `packages/idempotency/`, `packages/db/migrations/`, `.github/`.
- [ ] Sin migraciones, sin dependencias nuevas (salvo ADR autorizado).
- [ ] Badge «SANDBOX — dinero simulado» en toda UI nueva.
- [ ] No live / no producción / no exposición pública / no deploy / no sandbox compartido; freeze #24; F5.1–F5.4 bloqueadas.
- [ ] `LiveKeysDisabledError` y `licenses:check --strict` intactos.
- [ ] Suite + invariantes [1]–[9] + revisión adversarial interna + evidencia CI + merge solo con autorización.
