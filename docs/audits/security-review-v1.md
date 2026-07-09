# Revisión de seguridad interna v1 (F6)

Fecha: 2026-07-08 · Rama: `claude/security-review-f6` (apilada sobre `claude/ledger-nonneg-invariant`).

## Qué es (y qué NO es)

Este es un **self-review adversarial interno** del sistema endurecido, ejecutado como un
incremento más de la Fase 6. **NO** sustituye a la auditoría externa independiente v1
(`docs/audits/independent-audit-v1/`, inmutable; **0 P1 / 0 P2 abiertos**): es una pasada
FRESCA orientada a encontrar defectos NUEVOS —sobre todo en la superficie recién endurecida
(rotaciones de secretos, integridad del ledger)— **antes** de la re-auditoría externa que el
registro de cierre ya declara solicitable. Honestidad Nivel A: cada hallazgo se sustenta leyendo
el código real, con un escenario concreto `archivo:línea`; los que no se corrigen se documentan
como residuales con su razón.

## Metodología

Revisión multi-lente: **7 lentes adversariales en paralelo** sobre el código real, cada una
dueña de un clúster de superficie de seguridad, con instrucción de reportar solo defectos
sustanciables y de declarar «limpio» explícitamente cuando no los hubiera. Los hallazgos
materiales se **verificaron uno a uno contra el código** (pasada escéptica) antes de remediar.

| # | Lente | Veredicto |
|---|-------|-----------|
| 1 | AuthN / sesión / MFA + rotación MFA-key | 1 HIGH, 2 MEDIUM |
| 2 | API-key + rotación del pepper | limpio (2 notas INFO/LOW; sin explotabilidad) |
| 3 | RLS / roles / `SECURITY DEFINER` | 1 MEDIUM, 1 INFO |
| 4 | Integridad del ledger (invariantes, hash-chain, anchors) | 1 LOW, 2 INFO |
| 5 | Webhooks / SSRF / inbox | 1 HIGH, 1 MEDIUM, 1 LOW |
| 6 | HTTP / config / idempotencia | 2 LOW, 1 INFO |
| 7 | Frontend / exposición de secretos | 5 LOW/INFO (crown-jewels limpios) |

**Núcleo verificado sólido** por las lentes (sin hallazgo): aislamiento multi-tenant por RLS con
`SET LOCAL` (sin fuga cross-conexión), cobertura RLS `USING`+`WITH CHECK` en las 24 tablas
tenant-scoped, ausencia de BYPASSRLS/DELETE en roles de runtime, cifrado AES-GCM en reposo
(webhook/MFA) con IV aleatorio y disambiguación por tag, verificación HMAC de entrada en tiempo
constante sobre bytes crudos con ventana ±5 min y dedup race-safe, `authenticate_api_key` sin
false-accept, el pepper nunca persistido, idempotencia atómica claim+efecto+respuesta, envelope
de error sin fuga de internos, CORS de allowlist, y en el frontend: `client_secret` solo en el
fragmento → header (nunca al servidor/logs), cookie de sesión httpOnly, cero XSS/open-redirect/SSRF.

## Hallazgos y disposición

### Corregidos en este incremento

| ID | Sev | Área | Hallazgo | Fix | Test |
|----|-----|------|----------|-----|------|
| SR-01 | **HIGH** | auth | Una sesión secuestrada de un usuario SIN MFA podía auto-enrolar un factor MFA propio (`/mfa/setup`+`/activate` solo exigían sesión; `activateMfa` sella `mfa_verified_at`) y así satisfacer el step-up para acuñar API keys — **reabría el hueco que TM-02 declara cerrado**. | Enrolar/activar/deshabilitar MFA exige step-up FRESCO (`assertFreshStepUp`): password fresco para usuarios sin MFA, TOTP fresco para los que ya lo tienen. El atacante no puede producir esa prueba. | `mfa-routes.test.ts` (teeth: setup/activate/keys → 403; tras `/step-up/password` → 200) |
| SR-02 | **HIGH** | webhooks | La denylist SSRF comparaba IPv6 por STRING (`=== '::1'`, `startsWith('fe80')`), así que literales no canónicos (`[0:0:0:0:0:0:0:1]`, `::ffff:7f00:1`, el resto de `fe80::/10`) se trataban como públicos → el deliverer conectaba a loopback/interno (acotado a :443). | `isPrivateIp` normaliza IPv6 a 16 bytes (incl. `::` e IPv4 embebido) y evalúa los rangos NUMÉRICAMENTE (loopback/unspecified/ULA `fc00::/7`/link-local `fe80::/10`/multicast/v4-mapped). | `contract.test.ts` (teeth: 9 formas no canónicas denegadas + IPv6 público permitido) |
| SR-03 | **MEDIUM** | db | Los 21 `SECURITY DEFINER` declaran `search_path = public` pero **no** excluyen `pg_temp` (que PG busca primero para relaciones); con SQL arbitrario como `fluvia_app` se podían shadowear `api_keys`/`organizations` con TEMP TABLEs y falsear `authenticate_api_key`. (Hoy no escala más allá del límite de confianza de `fluvia_app` —que ya fija `app.tenant_id`—, pero es una brecha sistémica sobre el ancla de auth.) | Migración `0045`: `REVOKE TEMPORARY … FROM PUBLIC` — quita de raíz la primitiva de creación de objetos temporales a los roles de runtime; el vector se cierra con independencia del `search_path`. | `tenant-escape.test.ts` (teeth: ningún `fluvia_%` tiene TEMP) |
| SR-04 | **MEDIUM** | auth | El éxito del PRIMER factor (password) reseteaba el contador de lockout compartido ANTES de la rama MFA, así que un atacante con el password re-logueaba para limpiarlo entre intentos de TOTP → el lockout MFA nunca disparaba (~60× más intentos). | El reset ocurre solo al COMPLETAR el login: rama sin-MFA o `verifyMfaChallenge`. Las re-autenticaciones de primer factor ya no lo resetean. | `mfa.test.ts` (teeth: re-login no resetea; 3 MFA equivocados bloquean pese a los re-logins) |
| SR-05 | **MEDIUM** | webhooks | El `Fluvia-Event-Id` de cara al comercio salía del PK de la fila (`whe_<uuid>`), no del `event_id` ESTABLE del sobre; un reintento del relay at-least-once tras crash duplicaba la fila → el comercio (que deduplica por event_id, como dicta el contrato) procesaba el evento dos veces. | El deliverer emite el `event_id` del sobre (idéntico entre filas duplicadas del mismo evento de negocio). | `delivery.test.ts` (teeth: `Fluvia-Event-Id` == `payload.event_id`) |
| SR-06 | LOW | ledger | `reverseTransaction` reusaba `postTransaction` SIN el guard de no-negatividad (a diferencia de `twoLegged`); revertir una captura con `merchant.pending` ya drenado dejaba una cuenta protegida en negativo. (Path dormido: sin callers de producción; [9] lo detecta post-hoc.) | Deriva `nonNegativeAccounts` del espejo con la regla de `twoLegged`, guardando solo cuentas PROTEGIDAS del chart (transitorias exentas, como [9]). | `reversal.test.ts` (teeth: reversión sobre pending drenado → `InsufficientBalanceError`) |
| SR-07 | LOW | api | Los params de ruta `merchantId`/`apiKeyId` se casteaban sin Zod → un id malformado producía un `22P02` → **500** en vez de 400/404 (y un oráculo débil 500-vs-404). | Validación `z.string().uuid()` de los tres params antes del DB call. | `org-routes.test.ts` (teeth: id malformado → 400 validation_error) |
| SR-08 | LOW | api | `amount` aceptaba enteros fuera del rango seguro (`9e21` pasa `Number.isInteger`) en payouts/refunds/settlements/dashboard/payment-links; `BigInt(double impreciso)` daba un valor exacto-pero-equivocado (divergía de `Money.of`). | `.refine(Number.isSafeInteger)` en las 5 rutas (misma cota que `Money.of`). | `payout-routes.test.ts` (teeth: `9e21` → 400 validation_error) |
| SR-09 | LOW | webhooks | El verificador de firma de referencia/SDK lanzaba `RangeError` (en vez de `false`) ante una firma de igual longitud pero no-hex (`Buffer.from` trunca → `timingSafeEqual` con longitudes distintas). | Valida `^[0-9a-f]+$` antes de decodificar. | `contract.test.ts` (teeth: firma mal formada → `false`, no throw) |
| SR-10 | LOW | frontend | Checkout y dashboard no enviaban `Content-Security-Policy`; el checkout guarda el `client_secret` en el fragmento (JS-legible) sin `connect-src` que acote una exfiltración si hubiera XSS. | CSP en ambos apps; `connect-src 'self'` es el control clave (bloquea exfiltración a hosts ajenos). `'unsafe-inline'` por Next (hydration/RSC); una CSP con nonce queda como follow-up. | typecheck (los tests jsdom no cargan `next.config`) |
| SR-11 | INFO | db | `fluvia_app` conservaba INSERT/UPDATE sobre `users` (asimetría vs 0004, aunque la RLS ya lo bloqueaba). | Migración `0045`: `REVOKE INSERT, UPDATE ON users`. | `tenant-escape.test.ts` (teeth: sin write grant sobre users) |
| SR-12 | INFO | ledger | `verifyProjection` hacía dos lecturas sin lock → señal de drift ESPURIA si un posting commitea entremedio. | Toma `FOR UPDATE` de la cuenta antes de las dos lecturas (como `rebuildProjection`). | cobertura existente de `verifyProjection` |

### Residuales documentados (no code-fix)

- **SR-R1 (MEDIUM · auth) — Enumeración de cuentas por divergencia de lockout.** Un email inexistente
  jamás se bloquea; uno registrado, tras N intentos, devuelve `AccountLockedError` (distinto de
  `InvalidCredentialsError`), y `EmailNotVerifiedError` es un oráculo de estado ante password correcto.
  **Decisión: aceptado como tradeoff.** Revelar el lockout es una elección de UX deliberada (el operador
  legítimo necesita saber que su cuenta está bloqueada); la enumeración resultante está ACOTADA por el
  rate-limit por email (5/min) + IP y queda AUDITADA (`auth.account_locked`, riesgo alto). La afirmación
  «login uniforme» del servicio cubre específicamente *email inexistente vs password incorrecto* (ambos
  `InvalidCredentialsError` con costo igual), lo cual se mantiene.
- **SR-R2 (INFO · api-key) — Comparación de hash no constante en `authenticate_api_key`.** Es SQL
  ordinario, no `timingSafeEqual`. **No explotable:** el valor comparado es la salida de un verificador
  HMAC (una fuga total del `key_hash` no permite forjar un secreto; HMAC es one-way), el match es por
  igualdad estricta (sin `LIKE`/prefijo → sin false-accept) y no hay oráculo por-byte remoto.
- **SR-R3 (INFO · http) — Email en el log del bucket de rate-limit.** El `bucket` logueado a nivel warn
  incluye el email en claro. Es PII, no secreto, y ya aparece en otros logs de auth por diseño; se deja
  como nota (consistente con la política de auditoría existente).
- **SR-R4 (INFO · ledger) — `normal_side` snapshot vs chart.** Una cuenta creada bajo un `normal_side`
  viejo desincronizaría el guard (que lo lee del chart) frente a la proyección (que lo lee de la fila).
  Sin impacto vivo (todas las cuentas de producción nacen de `ensureChart` con el side del chart). Su
  hogar natural es una aserción de arranque contra la BD de PRODUCCIÓN, no la BD de test compartida (que
  acumula artefactos con sides arbitrarios); se recomienda como chequeo de startup en el despliegue (F5).
- **SR-R5 (LOW/INFO · frontend) — CSRF por `SameSite=Lax`, logout-GET, `Secure` atado a `NODE_ENV`.**
  `SameSite=Lax` es la defensa CSRF PRIMARIA y bloquea el caso cross-site ordinario de los POST mutantes
  (four-eyes, resend, disputas); el residual es el borde SAME-SITE de subdominio, cuyo cierre robusto (un
  chequeo de `Origin`) depende de la topología de fronting/`trustProxy` —el MISMO caveat que el rate
  limiter, registrado como bloqueante de PEND-006—. El logout por GET es un DoS-de-sesión (molestia, no
  exposición) y convertirlo a POST toca el header compartido en ~10 páginas. Se documentan como follow-ups
  atados a PEND-006/F5 en vez de introducir cambios acoplados al despliegue que no se pueden validar en el
  CI (sin navegador). El nonce-based strict CSP (SR-10) va en el mismo lote.

## Límite honesto (Nivel A)

Esto es una revisión INTERNA (self-review adversarial), no una auditoría externa: no la sustituye. Los
residuales atados a infra/despliegue (Origin-check, `Secure` por entorno, aserción de `normal_side` en
startup, CSP con nonce) se registran para F5/PEND-006 en vez de simularse en el sandbox. El shadowing de
`pg_temp` (SR-03) hoy no es explotable por encima del límite de confianza de `fluvia_app` (el suite SQLi
+ el candado de parametrización mantienen fuera el SQL arbitrario); el fix lo cierra igualmente como
defensa en profundidad sobre el ancla de auth.

## Validación

- **Build**: `turbo build` 21/21.
- **Suite**: verde en todos los paquetes vs PG16 real (`@fluvia/api` 211, `@fluvia/db` 88, `@fluvia/auth`
  59, `@fluvia/ledger` 68, `@fluvia/webhooks` 40, …). `payouts-redriver.test.ts` es el flake conocido
  (pasa aislado; confirmado 46/46 al re-ejecutar el worker solo).
- **Invariantes**: `verify-ledger-invariants.sql → FLUVIA_INVARIANTS_OK` (checks [1]–[9]) sobre la BD
  poblada por la suite.
- **Migración `0045`**: aplicada sobre BD fresca + 2ª corrida idempotente (`nothing applied`).
- **Drills**: `worker-down` PASS (5/5) y `restore` PASS (7/7) — el restore verifica los invariantes sobre
  la COPIA restaurada (0045 + los cambios del ledger sobreviven `pg_dump`/restore; RLS preservado).
- **Evidencia CI**: se registra el run verde en `audit-closure-register-v1.md` §Evidencia CI.
