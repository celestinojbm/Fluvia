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
7. **Recuperación**: rechazo/expiración/cancelación ⇒ bloque «Recuperar la venta» con «Abrir checkout nuevo» para la **misma venta** (mismo link, nuevo intent + nueva sesión; nunca otra venta). Solo se ofrece si la **última lectura fue correcta** (estado verificado). Tampoco se ofrece si **otro checkout conocido de la misma venta** sigue abierto, en proceso o sin leer (riesgo de doble cobro), ni si otro ya fue aprobado (venta cobrada). «Checkouts de esta venta» lista los intentos abiertos desde **esta pestaña** (`sessionStorage` es por pestaña) con su estado leído de la API. Recarga ⇒ `?session=&link=` reanuda el seguimiento (sin URL de pago, porque el secreto no se persiste).
8. **Incertidumbre**: «en proceso» o estado no reconocido ⇒ ni checkout nuevo ni «Nuevo cobro» (ni se vuelve a presentar el checkout). Lecturas perdidas con el pago aún abierto ⇒ «Resultado sin verificar», sin acciones de cobro, solo «Consultar estado». «Esperando» sin URL (tras recargar o desde otra pestaña) ⇒ **no se ofrece un checkout sustituto**: el anterior sigue pagable hasta su expiración y un segundo checkout pagable permitiría dos cobros (reproducido con PG real, ver §3). El operario ve «El checkout de esta venta sigue abierto» con la hora de expiración, cómo terminar (el cliente paga en su pantalla / esperar a la expiración verificada, tras la cual se ofrece recuperar) y «Consultar estado».
9. **Cobros recientes** (panel lateral en ≥1024 px, debajo en móvil/tablet): sesiones de checkout de la organización unidas a su payment intent por `payment_intent_id` (campo real, sin heurísticas). Se **refresca sola** cuando el terminal abre un cobro o ve un cambio de fase, al volver a la pestaña (>30 s) y con «Actualizar» — sin recargar la página. Filtros por **estado** y **comercio** sobre la **ventana** leída (ver §4). «Seguir» abre el cobro en el terminal de la misma pantalla (deshabilitado si hay una venta sin cerrar); «Detalle» lleva a la página de pago. Estados distintos: cargando (sin vaciar la lista), vacío genuino, sin coincidencias con filtros, fallo de lectura (con o sin datos previos, marcados como desactualizados), sesión caducada, sin acceso.

Checkout alojado (ajustes de UX en el mismo PR): tras un rechazo ya no promete «otro método» en la misma sesión (el intent `failed` es terminal) sino que pide un enlace nuevo al comercio; un confirm sin respuesta válida muestra «no sabemos el resultado, no lo repitas» + «Consultar estado» (el pago pudo procesarse); error de carga con «Reintentar»; id malformado (400) = enlace inválido; pago asíncrono en curso se re-consulta solo (acotado) + botón manual; doble envío bloqueado; la etiqueta del método asíncrono pasa de «PSE de prueba» a «Transferencia de prueba» (neutral de país — el token `tok_pse` del MockProvider no cambia).

## 2. Pantalla/acción → API

| Pantalla / acción | Llamada del navegador | API real usada | Plano / permiso |
| --- | --- | --- | --- |
| Cargar POS | (server component) | `GET /v1/organizations`, `GET /v1/organizations/:orgId/merchants` | sesión |
| Crear venta | `POST /api/orgs/:orgId/payment-links` (+ `Idempotency-Key`, `X-Fluvia-CSRF`) | `POST /v1/organizations/:orgId/payment_links` | sesión · `reconciliation:manage` · idempotente · auditado |
| Abrir checkout | `POST /api/orgs/:orgId/pos/checkout` (CSRF) | `GET /v1/organizations` (rol) → `GET /v1/organizations/:orgId/payment_links/:id` (propiedad + `active`) → `POST /v1/payment_links/:id/sessions` | sesión para verificar; público para abrir |
| Pagar (comprador) | checkout `/c/:id#secret` | `GET /v1/checkout_sessions/:id/status`, `POST /v1/checkout_sessions/:id/confirm` | `client_secret` · MockProvider (`tok_approve`/`tok_decline`/`tok_pse`) |
| Estado | `GET /api/orgs/:orgId/pos/sessions/:id` | `GET /v1/organizations/:orgId/checkout_sessions/:id` + `GET /v1/organizations/:orgId/payment_intents/:id` | sesión · `payments:read` |
| Cobros recientes (carga inicial) | (server component) | `GET /v1/organizations/:orgId/checkout_sessions?limit=100` + `GET /v1/organizations/:orgId/payment_intents?limit=100` | sesión · `payments:read` |
| Cobros recientes (refresco) | `GET /api/orgs/:orgId/pos/recent` | las mismas dos lecturas, org de la RUTA; whitelist; 401 `invalid_session`, 403/404 ⇒ `not_found`, resto 502 | sesión · `payments:read` |
| Recuperar venta | `POST /api/orgs/:orgId/pos/checkout` con el **mismo** `payment_link_id` | igual que «Abrir checkout» | sesión · `reconciliation:manage` |
| Intentos de la venta | `GET /api/orgs/:orgId/pos/sessions/:id` (uno por intento anterior, máx. 5) | igual que «Estado» | sesión · `payments:read` |
| Ver detalle | enlace | página existente `/o/:orgId/payments/:id` | sesión |

## 3. Garantías frente a doble envío e incertidumbre

- **Crear venta**: candado síncrono + controles deshabilitados; una `Idempotency-Key` por borrador. Resultado incierto (red/5xx) ⇒ «No sabemos si la venta se creó» + **reintento seguro con la misma key**; el borrador queda bloqueado (editarlo cambiaría la key).
- **Dos checkouts de la misma venta (hallazgo)**: `createSessionFromLink` crea intent + sesión nuevos en cada apertura y `confirmByClientSecret` solo bloquea su propia sesión. Con PostgreSQL real + MockProvider, dos sesiones del mismo link confirmadas en paralelo terminan **ambas `succeeded`** (`packages/payments-core/test/pos-sale-single-charge.test.ts`). Ninguna capa (servicio, API, BFF) lo impedía; la UI anterior lo permitía tras una advertencia. Contención en la UI: ver §1.8 y la recuperación de §1.7.
- **Abrir checkout**: el endpoint público **no es idempotente**. Resultado incierto ⇒ se dice explícitamente y **no se reintenta solo**; el operador decide abrir otro. Un checkout abierto y no pagado no cobra nada y expira (watchdog de checkout).
- **Estado**: un fallo de lectura nunca se muestra como estado del pago (404 «no encontrado», 401 «inicia sesión», 5xx «no pudimos actualizar»). Solo `succeeded` (y sus refunds) cuenta como cobrado; `processing` advierte «no cobres de nuevo».
- **CSRF**: los dos POST del recorrido pasan por `assertTrustedMutationRequest` (same-origin estricto). Se añadió a `payment-links` (deuda registrada en HANDOFF, cerrada **solo para esa ruta**; `refunds`, `operational-cases/*`, `case-adjustments/*`, `disputes/*/evidence` siguen pendientes de su propia autorización).
- **Aislamiento**: el BFF de apertura jamás usa el endpoint público con un link que no haya leído antes por el plano de sesión de esa org; toda lectura pasa por RLS + membresía (otra org ⇒ 404).

## 4. Contratos que faltan (no simulados)

| Necesidad | Estado en la API | Efecto en el POS |
| --- | --- | --- |
| Relación link → intents/sesiones (gap **G3**) | `payment_intents`/`checkout_sessions` no guardan `payment_link_id` (`createSessionFromLink` no persiste el link) | **Bloqueado**: no hay dato fiable para un contrato de lectura acotado por org. El POS guarda en `sessionStorage` (por **pestaña**: se pierde al cerrarla y no lo ven otras pestañas ni dispositivos) los ids de sesión que ÉL abrió por venta y lo presenta como «abiertos desde esta pestaña»; «Seguir» desde la lista recupera la venta solo si esta pestaña la registró, si no lo explica y ofrece «Nuevo cobro» |
| Filtros / paginación en listados | `checkout_sessions` y `payment_intents` solo aceptan `limit ≤ 100`, sin filtros ni cursor | Filtros **locales** sobre las últimas 100 sesiones; la UI declara la ventana y, si está llena, remite a Pagos para cobros más antiguos. Un intent fuera de su ventana de 100 se muestra como «Pago fuera de la ventana leída» |
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

### Incremento «seguimiento real y recuperación» (PR apilado sobre #55)

- Tests CI: `pos-recent.test.tsx` (unión/whitelist, ventana, estados, BFF y aislamiento por org), `pos-workspace.test.tsx` (el terminal refresca la lista; «Seguir» en la misma pantalla), `pos-terminal.test.tsx` (rechazo → recuperación con 1 venta y 2 sesiones, expiración, en proceso, estado desconocido, lecturas perdidas, confirmación de doble cobro), `pos-attempts.test.ts` (registro local acotado y tolerante a fallos).
- Navegador: PostgreSQL 16 + Redis locales, API/worker con `NODE_ENV=local`, dashboard `next start` con `FLUVIA_DASHBOARD_ORIGIN=http://localhost:3200`, checkout `:3100`, seed de demo + una **Org B** creada por el usuario `dev@` (del que `owner@` no es miembro) para probar aislamiento en vivo. La expiración se provocó adelantando `expires_at` de una sesión en la BD local y dejando que el watchdog del worker la expirara.
- Capturas saneadas (UUID → `••••` + 4 últimos, URL de checkout truncada; sin secretos ni datos personales) en [`pos-evidence/`](pos-evidence/):

| Captura | Estado |
| --- | --- |
| [00](pos-evidence/00-checkout-comprador-rechazado.png) | Comprador: tarjeta de prueba rechazada |
| [01 · 1440](pos-evidence/01-rechazo-antes-de-recuperar-1440.png) · [768](pos-evidence/01-rechazo-antes-de-recuperar-768.png) · [390](pos-evidence/01-rechazo-antes-de-recuperar-390.png) | «Pago rechazado» **antes de recuperar** (lista ya refrescada) |
| [02 · 1440](pos-evidence/02-checkout-nuevo-misma-venta-1440.png) · [768](pos-evidence/02-checkout-nuevo-misma-venta-768.png) · [390](pos-evidence/02-checkout-nuevo-misma-venta-390.png) | Checkout nuevo de la misma venta + intentos |
| [03](pos-evidence/03-aprobado-tras-recuperar-1440.png) | Aprobado tras recuperar, reflejado en la lista |
| [04](pos-evidence/04-filtro-rechazados-1440.png) | Filtro por estado dentro de la ventana |
| [05](pos-evidence/05-en-proceso-sin-repetir-1440.png) | En proceso: sin repetir el cobro |
| [06](pos-evidence/06-expirado-recuperable-1440.png) | Expirado: recuperable |
| [07](pos-evidence/07-fallo-de-lectura-1440.png) | Fallo de lectura con datos previos |
| [08](pos-evidence/08-sesion-caducada-1440.png) | Sesión caducada en la lista |
| [09](pos-evidence/09-resultado-sin-verificar-390.png) | Resultado sin verificar (API caída durante el seguimiento) |

Límites conocidos: el terminal no detecta la caducidad de la sesión mientras muestra una fase terminal (deja de consultar); si el operador pulsa «Abrir checkout nuevo» recibe `invalid_session` y el enlace a iniciar sesión. El registro de intentos vive en `sessionStorage` (por pestaña: se pierde al cerrarla y no ve otras pestañas ni dispositivos).
