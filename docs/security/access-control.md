# Control de acceso

Estado: Versión inicial · Fase: 0 · Implementación en F1 (RBAC) y F4 (admin)

## Modelo

- **RBAC por organización** vía `memberships(user, organization, role)`. Roles iniciales: `owner`, `admin`, `developer`, `finance`, `support`, `analyst`, `read_only`.
- **API keys con scopes** (lectura, pagos, refunds, webhooks) y entorno (`test`/`live`); una key nunca cruza entornos.
- **Separación dura dashboard ↔ administración interna**: apps, dominios de sesión y roles distintos; el staff de Fluvia no usa cuentas de comercio.
- **Step-up authentication** (re-auth MFA) para operaciones sensibles: crear/rotar API keys, modificar webhooks, cambiar datos legales/bancarios, aprobar refunds sobre umbral, desactivar MFA, congelar comercios, ajustes contables.
- **Four-eyes** cuando corresponda (ajustes de conciliación sobre umbral, payouts futuros): el proponente no puede aprobar su propia acción (constraint en el modelo de casos).
- **Mínimo privilegio en BD**: roles `fluvia_app`/`fluvia_worker` sin DELETE; el owner de esquema solo migra; `fluvia_auth` (F1-04a) es el único rol con acceso a credenciales/sesiones y solo a esas tres tablas.

## Estado de implementación (F1-04a, 2026-07-04)

Implementado: registro con verificación de email (token un solo uso, hash en BD), login con scrypt (formato versionado), error uniforme anti-enumeración con igualación de costo temporal, lockout configurable por intentos fallidos, sesiones opacas revocables (individual y global), separación dura del plano de auth (rol `fluvia_auth`). Completado además (F1-04c): API keys con scopes y RBAC por endpoint. Completado (F1-05): audit log append-only — toda acción sensible (API keys, merchants, login/lockout/logout) escribe su evento EN LA MISMA transacción, con actor/razón/request-id y resúmenes redactados; consulta paginada vía `audit:read`. Pendiente (F1-04b): MFA TOTP, step-up, recuperación de contraseña, canal real de email.

## Matriz de permisos (v1 — F1-04c, fuente de verdad: `packages/identity/src/rbac.ts`)

| Permiso \ Rol   | owner | admin | developer | finance | support | analyst | read_only |
| --------------- | :---: | :---: | :-------: | :-----: | :-----: | :-----: | :-------: |
| org:read        |  ✅   |  ✅   |    ✅     |   ✅    |   ✅    |   ✅    |    ✅     |
| members:read    |  ✅   |  ✅   |    ✅     |   ✅    |   ✅    |   ✅    |    ✅     |
| merchants:read  |  ✅   |  ✅   |    ✅     |   ✅    |   ✅    |   ✅    |    ✅     |
| merchants:write |  ✅   |  ✅   |    ❌     |   ❌    |   ❌    |   ❌    |    ❌     |
| keys:read       |  ✅   |  ✅   |    ✅     |   ✅    |   ❌    |   ❌    |    ❌     |
| keys:manage     |  ✅   |  ✅   |    ✅     |   ❌    |   ❌    |   ❌    |    ❌     |
| audit:read      |  ✅   |  ✅   |    ❌     |   ✅    |   ❌    |   ✅    |    ❌     |
| payments:read   |  ✅   |  ✅   |    ✅     |   ✅    |   ✅    |   ✅    |    ✅     |
| webhooks:manage |  ✅   |  ✅   |    ✅     |   ❌    |   ❌    |   ❌    |    ❌     |
| reconciliation:manage | ✅ | ✅ |    ❌     |   ✅    |   ❌    |   ❌    |    ❌     |

El test `packages/identity/test/rbac.test.ts` verifica la matriz completa celda a celda; un cambio en código sin actualizar la matriz esperada rompe CI. La matriz crecerá con cada dominio nuevo (pagos, refunds, webhooks) en el mismo PR que exponga los endpoints.

**`payments:read` (F3-09b)**: lectura del plano de OPERACIÓN (dashboard del comercio) — payment intents, refunds, checkout sessions, payment links y la cola de webhooks, bajo `/v1/organizations/:orgId/*` (sesión + membresía, RLS por tenant). Es dato de tenant de solo lectura, así que lo tiene TODO rol (todos ya tienen `org:read`).

**`webhooks:manage` (F3-09b-iii)**: acción de OPERACIÓN sobre webhooks (reenvío de eventos `dead`) por SESIÓN, bajo `POST /v1/organizations/:orgId/webhook_events/:id/resend`. Espeja el scope de API key homónimo (son enums distintos — permiso RBAC vs scope de API key — que representan la misma capacidad en planos de auth distintos). Solo lo tienen los roles que gestionan la integración (owner/admin/developer); el resto del plano de operador es de solo lectura.

**`reconciliation:manage` (F4-03c)**: operación de conciliación por SESIÓN — trabajar casos (`operational_cases`: acknowledge/resolve) y **AUTORIZAR ajustes monetarios** con **four-eyes** (`case_adjustments`: proponer/aprobar/rechazar), bajo `/v1/organizations/:orgId/operational_cases/*` y `/case_adjustments/*`. Solo roles que gobiernan el dinero/conciliación (owner/admin/finance). **El four-eyes (aprobador ≠ proponente sobre umbral) NO se modela como permiso** — se exige por IDENTIDAD de usuario en el servicio y por CHECK en la BD (0030): dos personas distintas *con este permiso* deben intervenir. Autorizar dinero exige actor humano (una API key jamás alcanza este plano).

**Scopes de API keys (integración)**: `read`, `payments:write`, `customers:write`, `webhooks:manage`. Deliberadamente **no existe** scope de gestión de API keys: una key robada no puede crear más keys ni escalar — la gestión es exclusiva del plano de sesión con rol (`keys:manage`).

Las pruebas de autorización (BOLA, escalada horizontal/vertical, planes no intercambiables) acompañan cada endpoint desde su primer PR (ver `apps/api/test/org-routes.test.ts`).

## Hardening de transporte del API (F3-11a, AUD-P2-016)

**CORS**: allowlist explícita vía `CORS_ALLOWED_ORIGINS` (lista por comas). Default **vacío = ningún cross-origin** — el default seguro, porque los apps `checkout`/`dashboard` llaman al API server-side (route handlers / server components), no desde el navegador. Un origen permitido recibe `Access-Control-Allow-Origin: <origin>` + `Vary: Origin`; el preflight OPTIONS se responde con `Access-Control-Allow-Methods/Headers/Max-Age` SOLO para orígenes permitidos. Un origen ajeno no recibe ACAO y el navegador bloquea la respuesta.

**Cabeceras de seguridad** en TODA respuesta: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (el API devuelve JSON, se bloquea al máximo), `Cross-Origin-Resource-Policy: same-origin`, y `Strict-Transport-Security` (HSTS) SOLO fuera de local/test. Cubierto por `apps/api/test/security-headers.test.ts`.
