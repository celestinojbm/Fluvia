# Control de acceso

Estado: Versión inicial · Fase: 0 · Implementación en F1 (RBAC) y F4 (admin)

## Modelo

- **RBAC por organización** vía `memberships(user, organization, role)`. Roles iniciales: `owner`, `admin`, `developer`, `finance`, `support`, `analyst`, `read_only`.
- **API keys con scopes** (lectura, pagos, refunds, webhooks) y entorno (`test`/`live`); una key nunca cruza entornos.
- **Separación dura dashboard ↔ administración interna**: apps, dominios de sesión y roles distintos; el staff de Fluvia no usa cuentas de comercio.
- **Step-up authentication** (re-auth MFA) para operaciones sensibles: crear/rotar API keys, modificar webhooks, cambiar datos legales/bancarios, aprobar refunds sobre umbral, desactivar MFA, congelar comercios, ajustes contables.
- **Four-eyes** cuando corresponda (ajustes de conciliación sobre umbral, payouts futuros): el proponente no puede aprobar su propia acción (constraint en el modelo de casos).
- **Mínimo privilegio en BD**: roles `fluvia_app`/`fluvia_worker` sin DELETE; el owner de esquema solo migra.

## Matriz de permisos

Se genera como artefacto en F1-05 (`access-matrix.md`) y es un gate de producción (§51). Las pruebas de autorización (BOLA, escalada horizontal/vertical) acompañan cada endpoint desde su primer PR.
