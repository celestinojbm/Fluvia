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

Implementado: registro con verificación de email (token un solo uso, hash en BD), login con scrypt (formato versionado), error uniforme anti-enumeración con igualación de costo temporal, lockout configurable por intentos fallidos, sesiones opacas revocables (individual y global), separación dura del plano de auth (rol `fluvia_auth`). Pendiente (F1-04b/c): MFA TOTP, step-up, API keys con scopes, RBAC aplicado por endpoint, recuperación de contraseña, canal real de email (el token de verificación solo se expone por API en local/test).

## Matriz de permisos

Se genera como artefacto en F1-05 (`access-matrix.md`) y es un gate de producción (§51). Las pruebas de autorización (BOLA, escalada horizontal/vertical) acompañan cada endpoint desde su primer PR.
