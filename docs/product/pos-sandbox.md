# POS web sandbox (dashboard)

Estado: **incremento sandbox, sin merge** · Alcance: `apps/dashboard` (+ ajustes de UX en `apps/checkout`) · Proveedor: **MockProvider únicamente** · Sin credenciales `live`, sin dinero real, sin datos de tarjeta · Fluvia no es banco, adquirente ni procesador.

Recorrido vertical para que un operador cobre una venta desde el dashboard usando **solo contratos existentes de la API**. No añade endpoints a la API, no toca ledger, migraciones, idempotencia ni `.github/`.

## 1. Recorrido

1. **Entrada**: `Panel → Cobrar (POS)` (`/o/:orgId/pos`). Sesión obligatoria; rol y comercios activos leídos por el plano de sesión.
2. **Venta**: importe en unidades mayores + moneda (por defecto, la del comercio) + concepto opcional. Validación local sin floats (`pos-money.ts`).
3. **Crear la venta** = crear un payment link por sesión (idempotente, auditado, `reconciliation:manage`).
4. **Abrir el cobro** = BFF que verifica la propiedad del link por sesión y abre una sesión de checkout con el endpoint público existente (el mismo que usa `/l/:id`).
5. **Presentar**: botón «Abrir checkout» (pestaña nueva, `noopener noreferrer`) + copiar enlace. El `client_secret` viaja solo en el **fragmento** de la URL, no se pinta en pantalla ni se guarda.
6. **Estado**: consulta encadenada cada 2,5 s (backoff ante errores; tope ~10 min) sobre sesión + intent por el plano de sesión. Fases derivadas de la FSM real: esperando · en proceso · aprobado · rechazado · cancelado · expirado · desconocido.
7. **Recuperación**: rechazo/expiración/cancelación ⇒ «Abrir checkout nuevo» para la **misma venta** (mismo link, nuevo intent). Recarga ⇒ `?session=&link=` reanuda el seguimiento (sin URL de pago, porque el secreto no se persiste).
8. **Cobros recientes** (panel lateral en ≥1024 px, debajo en móvil/tablet): las 10 sesiones de checkout más recientes de la organización unidas a su payment intent por `payment_intent_id` (campo real, sin heurísticas). «Seguir» reabre el terminal en esa sesión; «Detalle» lleva a la página de pago existente (línea de tiempo, refunds). Un fallo de lectura se muestra como error, nunca como historial vacío.

Checkout alojado (ajustes de UX en el mismo PR): tras un rechazo ya no promete «otro método» en la misma sesión (el intent `failed` es terminal) sino que pide un enlace nuevo al comercio; un confirm sin respuesta válida muestra «no sabemos el resultado, no lo repitas» + «Consultar estado» (el pago pudo procesarse); error de carga con «Reintentar»; id malformado (400) = enlace inválido; pago asíncrono en curso se re-consulta solo (acotado) + botón manual; doble envío bloqueado; la etiqueta del método asíncrono pasa de «PSE de prueba» a «Transferencia de prueba» (neutral de país — el token `tok_pse` del MockProvider no cambia).

## 2. Pantalla/acción → API

| Pantalla / acción | Llamada del navegador | API real usada | Plano / permiso |
| --- | --- | --- | --- |
| Cargar POS | (server component) | `GET /v1/organizations`, `GET /v1/organizations/:orgId/merchants` | sesión |
| Crear venta | `POST /api/orgs/:orgId/payment-links` (+ `Idempotency-Key`, `X-Fluvia-CSRF`) | `POST /v1/organizations/:orgId/payment_links` | sesión · `reconciliation:manage` · idempotente · auditado |
| Abrir checkout | `POST /api/orgs/:orgId/pos/checkout` (CSRF) | `GET /v1/organizations` (rol) → `GET /v1/organizations/:orgId/payment_links/:id` (propiedad + `active`) → `POST /v1/payment_links/:id/sessions` | sesión para verificar; público para abrir |
| Pagar (comprador) | checkout `/c/:id#secret` | `GET /v1/checkout_sessions/:id/status`, `POST /v1/checkout_sessions/:id/confirm` | `client_secret` · MockProvider (`tok_approve`/`tok_decline`/`tok_pse`) |
| Estado | `GET /api/orgs/:orgId/pos/sessions/:id` | `GET /v1/organizations/:orgId/checkout_sessions/:id` + `GET /v1/organizations/:orgId/payment_intents/:id` | sesión · `payments:read` |
| Cobros recientes | (server component) | `GET /v1/organizations/:orgId/checkout_sessions?limit=25` + `GET /v1/organizations/:orgId/payment_intents?limit=100` | sesión · `payments:read` |
| Ver detalle | enlace | página existente `/o/:orgId/payments/:id` | sesión |

## 3. Garantías frente a doble envío e incertidumbre

- **Crear venta**: candado síncrono + controles deshabilitados; una `Idempotency-Key` por borrador. Resultado incierto (red/5xx) ⇒ «No sabemos si la venta se creó» + **reintento seguro con la misma key**; el borrador queda bloqueado (editarlo cambiaría la key).
- **Abrir checkout**: el endpoint público **no es idempotente**. Resultado incierto ⇒ se dice explícitamente y **no se reintenta solo**; el operador decide abrir otro. Un checkout abierto y no pagado no cobra nada y expira (watchdog de checkout).
- **Estado**: un fallo de lectura nunca se muestra como estado del pago (404 «no encontrado», 401 «inicia sesión», 5xx «no pudimos actualizar»). Solo `succeeded` (y sus refunds) cuenta como cobrado; `processing` advierte «no cobres de nuevo».
- **CSRF**: los dos POST del recorrido pasan por `assertTrustedMutationRequest` (same-origin estricto). Se añadió a `payment-links` (deuda registrada en HANDOFF, cerrada **solo para esa ruta**; `refunds`, `operational-cases/*`, `case-adjustments/*`, `disputes/*/evidence` siguen pendientes de su propia autorización).
- **Aislamiento**: el BFF de apertura jamás usa el endpoint público con un link que no haya leído antes por el plano de sesión de esa org; toda lectura pasa por RLS + membresía (otra org ⇒ 404).

## 4. Contratos que faltan (no simulados)

| Necesidad | Estado en la API | Efecto en el POS |
| --- | --- | --- |
| Relación link → intents/sesiones (gap **G3**) | `payment_intents`/`checkout_sessions` no guardan `payment_link_id` | El historial no puede agrupar «cobros de esta venta»; el POS sigue la sesión concreta que abrió |
| Deshabilitar un link por sesión | Solo `POST /v1/payment_links/:id/disable` (API key) | Tras cobrar, el link de la venta sigue `active`; el POS no expone su URL `/l/:id` al comprador |
| Cancelar un intent / expirar una sesión por sesión | Solo `POST /v1/payment_intents/:id/cancel` (API key); no hay expire manual | No hay botón «cancelar cobro»: se informa que el checkout expira solo |
| Crear intent/sesión directamente por sesión (sin link) | Solo plano de API key | El POS usa link + sesión pública como vía soportada |
| Links de un solo uso | No existe | Un link reutilizado genera cobros nuevos (por eso no se comparte `/l/:id`) |

Contrato mínimo propuesto (para decidir, no implementado): `POST /v1/organizations/:orgId/payment_links/:id/disable` (sesión, `reconciliation:manage`, auditado) y `payment_link_id` en el serializer de `checkout_session` para sesiones abiertas desde un link.

## 5. Decisiones pendientes (humanas)

- **PEND-007 — mercado inicial**: el repo registra Colombia (decisión #15); el propietario evalúa Venezuela. El POS es neutral: moneda por defecto = la del comercio; lista de monedas = registro de `@fluvia/money` (VES **no** está en ese registro). En el checkout la etiqueta «PSE» (medio colombiano) se sustituyó por «Transferencia de prueba». Siguen con supuesto Colombia, sin tocar: el locale `es-CO` de formato, el país del onboarding y la matriz jurisdiccional. No se cambió país, moneda, impuestos ni reglas regulatorias.
- **PEND-008 — exponente de COP**: `@fluvia/money` define COP con exponente 2; `formatAmount` (dashboard y checkout) y el showroom del PR #47 lo tratan como exponente 0. El POS convierte con la regla de **visualización** (`displayExponent`) para que cajero y comprador vean el mismo importe; un test fija la discrepancia para que se resuelva en un solo cambio.

## 6. Verificación

- Tests CI (jsdom/axe, sin red): `apps/dashboard/test/pos-logic.test.ts`, `pos-bff.test.ts`, `pos-terminal.test.tsx`.
- Navegador (local, Chromium de `/opt/pw-browsers`): API `:3000` (`NODE_ENV=local CHECKOUT_BASE_URL=http://localhost:3100`), checkout `:3100`, dashboard `:3200`, seed de demo (`pnpm seed`). Recorridos aprobado, rechazado→recuperado, asíncrono, rol sin permiso, recarga; viewports 390/768/1440 sin scroll horizontal.
