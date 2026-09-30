# POS web sandbox (dashboard)

Estado: **incremento sandbox, sin merge** · Alcance: `apps/dashboard` (+ ajustes de UX en `apps/checkout`) · Proveedor: **MockProvider únicamente** · Sin credenciales `live`, sin dinero real, sin datos de tarjeta · Fluvia no es banco, adquirente ni procesador.

Recorrido vertical para que un operador cobre una venta desde el dashboard. Los incrementos iniciales usaban solo contratos existentes; el incremento «una venta, como máximo un cobro» (§3) añade la migración `0046`, la política `single_charge`, la lectura de venta por org y el código `sale_already_charged`. No toca ledger, idempotencia ni `.github/`.

## 1. Recorrido

1. **Entrada**: `Panel → Cobrar (POS)` (`/o/:orgId/pos`). Sesión obligatoria; rol y comercios activos leídos por el plano de sesión.
2. **Venta**: importe en unidades mayores + moneda (por defecto, la del comercio) + concepto opcional. Validación local sin floats (`pos-money.ts`).
3. **Crear la venta** = crear un payment link por sesión con `single_charge: true` (idempotente, auditado, `reconciliation:manage`): una venta del POS admite **como máximo un cobro exitoso** y el backend lo hace cumplir (§3).
4. **Abrir el cobro** = BFF que verifica la propiedad del link por sesión y abre una sesión de checkout con el endpoint público existente (el mismo que usa `/l/:id`).
5. **Presentar**: botón «Abrir checkout» (pestaña nueva, `noopener noreferrer`) + copiar enlace. El `client_secret` viaja solo en el **fragmento** de la URL, no se pinta en pantalla ni se guarda.
6. **Estado**: consulta encadenada cada 2,5 s (backoff ante errores; tope ~10 min) sobre sesión + intent por el plano de sesión. Fases derivadas de la FSM real: esperando · en proceso · aprobado · rechazado · cancelado · expirado · desconocido.
7. **Recuperación**: rechazo/expiración/cancelación ⇒ bloque «Recuperar la venta» con «Abrir checkout nuevo» para la **misma venta** (mismo link, nuevo intent + nueva sesión; nunca otra venta). Solo se ofrece si la **última lectura fue correcta** (estado verificado). Además exige la **venta leída del servidor** (`GET …/pos/sales/:linkId`) y que contenga este checkout: si otro checkout de la venta ya cobró o está cobrando (incluido un desenlace incierto) no se ofrece; en una venta **sin protección** (antigua o multiuso) tampoco si otro checkout sigue abierto o si el historial es parcial. «Checkouts de esta venta» lista **todos** los checkouts vinculados por el servidor, abiertos desde cualquier pestaña o dispositivo (ya no hay registro en `sessionStorage`). Recarga ⇒ `?session=&link=` reanuda el seguimiento (sin URL de pago, porque el secreto no se persiste); si `?link=` no coincide con el vínculo del servidor, manda el servidor.
8. **Incertidumbre**: «en proceso» o estado no reconocido ⇒ ni checkout nuevo ni «Nuevo cobro» (ni se vuelve a presentar el checkout). Lecturas perdidas con el pago aún abierto ⇒ «Resultado sin verificar», sin acciones de cobro, solo «Consultar estado». «Esperando» sin URL (tras recargar o desde otra pestaña) ⇒ **no se ofrece un checkout sustituto**: el anterior sigue pagable hasta su expiración y un segundo checkout pagable permitiría dos cobros (reproducido con PG real, ver §3). El operario ve «El checkout de esta venta sigue abierto» con la hora de expiración y «Consultar estado». En una venta **protegida** (`single_charge`, historial completo, sin cobro en curso, verificada) se ofrece «Abrir checkout sustituto»: es seguro porque el backend solo deja cobrar a uno (el primero que se pague bloquea al otro con `sale_already_charged`). En una venta **sin protección** no hay sustituto: el cliente paga en su pantalla o se espera a la expiración verificada, tras la cual se ofrece recuperar.
9. **Cobros recientes** (panel lateral en ≥1024 px, debajo en móvil/tablet): sesiones de checkout de la organización unidas a su payment intent por `payment_intent_id` (campo real, sin heurísticas). Se **refresca sola** cuando el terminal abre un cobro o ve un cambio de fase, al volver a la pestaña (>30 s) y con «Actualizar» — sin recargar la página. Filtros por **estado** y **comercio** sobre la **ventana** leída (ver §4). Cada fila muestra su **venta** (`payment_link_id` del intent: «Venta ••1234», y cuántos checkouts de esa venta hay en la ventana) o «Sin venta vinculada» para cobros anteriores a `0046`, con un aviso de que esos no se pueden agrupar ni recuperar desde el POS. «Seguir» abre el cobro en el terminal de la misma pantalla con su venta (deshabilitado si hay una venta sin cerrar); «Detalle» lleva a la página de pago. Estados distintos: cargando (sin vaciar la lista), vacío genuino, sin coincidencias con filtros, fallo de lectura (con o sin datos previos, marcados como desactualizados), sesión caducada, sin acceso.

Checkout alojado: si la venta de cobro único ya tiene otro pago aprobado o en curso, la vista trae `sale_closed` y la página lo explica sin formulario; un confirm rechazado con `409 sale_already_charged` es un rechazo **cierto** (nada llegó al proveedor) y relee la vista en vez de mostrar «resultado incierto». Ajustes previos: tras un rechazo ya no promete «otro método» en la misma sesión (el intent `failed` es terminal) sino que pide un enlace nuevo al comercio; un confirm sin respuesta válida muestra «no sabemos el resultado, no lo repitas» + «Consultar estado» (el pago pudo procesarse); error de carga con «Reintentar»; id malformado (400) = enlace inválido; pago asíncrono en curso se re-consulta solo (acotado) + botón manual; doble envío bloqueado; la etiqueta del método asíncrono pasa de «PSE de prueba» a «Transferencia de prueba» (neutral de país — el token `tok_pse` del MockProvider no cambia).

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
| Recuperar venta / checkout sustituto | `POST /api/orgs/:orgId/pos/checkout` con el **mismo** `payment_link_id` | igual que «Abrir checkout»; `409 sale_already_charged` si la venta ya cobra o cobró | sesión · `reconciliation:manage` |
| Venta (checkouts + estado del cobro) | `GET /api/orgs/:orgId/pos/sales/:linkId` | `GET /v1/organizations/:orgId/payment_links/:id/sale` (nuevo); whitelist; 401 `invalid_session`, 403/404 ⇒ `not_found`, resto 502 | sesión · `payments:read` |
| Ver detalle | enlace | página existente `/o/:orgId/payments/:id` | sesión |

## 3. Garantías frente a doble envío e incertidumbre

- **Crear venta**: candado síncrono + controles deshabilitados; una `Idempotency-Key` por borrador. Resultado incierto (red/5xx) ⇒ «No sabemos si la venta se creó» + **reintento seguro con la misma key**; el borrador queda bloqueado (editarlo cambiaría la key).
- **Dos checkouts de la misma venta (hallazgo)**: `createSessionFromLink` crea intent + sesión nuevos en cada apertura y `confirmByClientSecret` solo bloquea su propia sesión. Con PostgreSQL real + MockProvider, dos sesiones del mismo link confirmadas en paralelo terminaban **ambas `succeeded`**. Ninguna capa (servicio, API, BFF, motor) lo impedía; la UI anterior lo permitía tras una advertencia. Sigue siendo el comportamiento de los **links multiuso** (payment links públicos), que se conserva a propósito.
- **Invariante «una venta POS, como máximo un cobro exitoso»** (`0046`):
  - *Motor*: índice único parcial `payment_intents_single_charge_uq` sobre `single_charge_link_id` (derivado por trigger desde la política del link, no falsificable) para todo estado salvo `created`/`requires_*`/`failed`/`canceled`. Dos intents de la misma venta no pueden estar a la vez cobrando o cobrados, venga de donde venga la escritura (confirm alojado, confirm por API key, SQL directo con el rol de la app).
  - *Servicio*: `beginIn` toma el lock de fila del **link** y, si otro intent de la venta retiene el cobro, lanza `SaleAlreadyChargedError` **antes** de crear el attempt o llamar al proveedor (409 `sale_already_charged`). El 23505 del índice se traduce al mismo error.
  - *Desenlace incierto*: un timeout del proveedor deja el attempt `indeterminate` y el intent `processing` ⇒ la venta queda **retenida** hasta una resolución verificada (webhook/consulta); solo `failed`/`canceled` la liberan. Un intent reembolsado sigue reteniéndola (la venta ya se cobró una vez).
  - *Idempotencia*: el doble envío del mismo checkout sigue siendo un único attempt (se corrigió además que el segundo envío concurrente fallara con `processing -> processing`: ahora relee el intent tras el lock). Una sesión con TTL vencido y aún no barrida ya no cobra.
  - *Pruebas (PG real)*: `packages/payments-core/test/pos-sale-single-charge.test.ts` — paralelo 2 y carrera de 8 checkouts ⇒ 1 cobro y 1 attempt; incierto (timeout) y asíncrono (`tok_pse`) resueltos en ambos sentidos; rechazo que libera; índice del motor sin pasar por el servicio; inmutabilidad; aislamiento entre orgs; historial parcial de links antiguos. HTTP: `apps/api/test/dashboard-routes.test.ts` (409, `sale_closed`, lectura por org, idempotencia de la creación).
- **Liberar una venta exige un hecho verificado del proveedor** (`0047`, hallado en revisión del diff): en `0046`, `canceled` liberaba la venta, y `POST /v1/payment_intents/:id/cancel` hace `authorized → canceled` de forma **puramente local** (sin anular la retención en el proveedor; el MockProvider no expone anulación). Con una autorización viva, otro checkout podía cobrar: reproducido con PG real (el checkout B terminaba `succeeded`). Ahora, solo para ventas de cobro único, el trigger `fluvia_single_charge_release_guard` rechaza `→ canceled` desde un estado que retiene la venta y admite `→ failed` solo con un rechazo resuelto del proveedor; el servicio responde `409 sale_release_unverified`. Vale para la ruta, cualquier transición permitida por la FSM y un `UPDATE` directo con `fluvia_app`. Los links multiuso cancelan como siempre. Límite: el motor no puede consultar al proveedor; exige coherencia con los attempts que escribe la resolución verificada. `authorized` no es alcanzable hoy por ningún camino del código.
- **La derivación del vínculo falla cerrado** (`0047`): si quien inserta un intent no ve el link que declara, antes quedaba `single_charge_link_id = NULL` y el intent escapaba del índice (reproducido con un invocador cuya RLS oculta el link: la venta llegaba a DOS intents `succeeded`); ahora es `FLUVIA_LINK_NOT_VISIBLE`.
- **Checkouts antiguos**: los intents creados antes de `0046` no tienen `payment_link_id` ni `single_charge_link_id`: el índice no los cubre y no se infiere su venta (no hay backfill). Los links antiguos quedan multiuso (`single_charge = false`) y con historial **parcial** (`checkout_tracking_since` = instante de la migración): el POS no ofrece sustituto ni recuperación para ellos y lo explica; «Cobros recientes» los marca «Sin venta vinculada».
- **Abrir checkout**: el endpoint público **no es idempotente**. Resultado incierto ⇒ se dice explícitamente y **no se reintenta solo**; el operador decide abrir otro. Un checkout abierto y no pagado no cobra nada y expira (watchdog de checkout).
- **Estado**: un fallo de lectura nunca se muestra como estado del pago (404 «no encontrado», 401 «inicia sesión», 5xx «no pudimos actualizar»). Solo `succeeded` (y sus refunds) cuenta como cobrado; `processing` advierte «no cobres de nuevo».
- **CSRF**: los dos POST del recorrido pasan por `assertTrustedMutationRequest` (same-origin estricto). Se añadió a `payment-links` (deuda registrada en HANDOFF, cerrada **solo para esa ruta**; `refunds`, `operational-cases/*`, `case-adjustments/*`, `disputes/*/evidence` siguen pendientes de su propia autorización).
- **Aislamiento**: el BFF de apertura jamás usa el endpoint público con un link que no haya leído antes por el plano de sesión de esa org; toda lectura pasa por RLS + membresía (otra org ⇒ 404).

## 4. Contratos que faltan (no simulados)

| Necesidad | Estado en la API | Efecto en el POS |
| --- | --- | --- |
| Relación link → intents/sesiones (gap **G3**) | **Resuelto para lo nuevo** (`0046`): `payment_intents.payment_link_id` + `GET /v1/organizations/:orgId/payment_links/:id/sale` | El POS lee la venta del servidor (cualquier pestaña o dispositivo) y ya no usa `sessionStorage`. Límite: los cobros anteriores a `0046` siguen sin vínculo (historial parcial, sin backfill) |
| Filtros / paginación en listados | `checkout_sessions` y `payment_intents` solo aceptan `limit ≤ 100`, sin filtros ni cursor | Filtros **locales** sobre las últimas 100 sesiones; la UI declara la ventana y, si está llena, remite a Pagos para cobros más antiguos. Un intent fuera de su ventana de 100 se muestra como «Pago fuera de la ventana leída» |
| Deshabilitar un link por sesión | Solo `POST /v1/payment_links/:id/disable` (API key) | Tras cobrar, el link de la venta sigue `active`; el POS no expone su URL `/l/:id` al comprador |
| Cancelar un intent / expirar una sesión por sesión | Solo `POST /v1/payment_intents/:id/cancel` (API key); no hay expire manual | No hay botón «cancelar cobro»: se informa que el checkout expira solo |
| Crear intent/sesión directamente por sesión (sin link) | Solo plano de API key | El POS usa link + sesión pública como vía soportada |
| Links de un solo cobro | **Existe para ventas del POS** (`single_charge`, solo plano de sesión; el plano de API key no lo acepta) | Una venta del POS no puede cobrarse dos veces. Los links multiuso siguen generando cobros independientes (por eso no se comparte `/l/:id`) |
| Cancelar los checkouts sobrantes de una venta cobrada | No existe | Quedan `open` hasta su TTL pero **no pueden cobrar** (`sale_closed`, 409); el historial los muestra como «Esperando al cliente» dentro de una venta cobrada |

Contrato mínimo propuesto (para decidir, no implementado): `POST /v1/organizations/:orgId/payment_links/:id/disable` (sesión, `reconciliation:manage`, auditado).

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

Límites conocidos: el terminal no detecta la caducidad de la sesión mientras muestra una fase terminal (deja de consultar); si el operador pulsa «Abrir checkout nuevo» recibe `invalid_session` y el enlace a iniciar sesión. El registro de intentos por pestaña (`sessionStorage`) de ese incremento quedó sustituido por la lectura de venta del servidor (§3).

### Incremento «una venta, como máximo un cobro» (PR apilado sobre `claude/pos-charge-tracking-recovery`)

- Tests CI: `packages/payments-core/test/pos-sale-single-charge.test.ts` (PG real: carreras, incierto, motor, aislamiento, legado), `apps/api/test/dashboard-routes.test.ts` (HTTP), `apps/dashboard/test/pos-terminal.test.tsx` · `pos-bff.test.ts` · `pos-recent.test.tsx`, `apps/checkout/test/checkout-client.test.tsx`.
- Navegador (local): PostgreSQL 16, API `NODE_ENV=local`, dashboard y checkout `next start`, seed de demo. Recorrido: venta protegida → recarga (URL perdida) → checkout sustituto → el comprador paga el checkout ANTERIOR → el sustituto queda bloqueado (página y `POST /confirm` directo ⇒ `409 sale_already_charged`) → el terminal lo refleja. Venta antigua (link insertado con `single_charge = false` e historial parcial) ⇒ sin sustituto. Sin scroll horizontal en 390 y 1440.

| Captura | Estado |
| --- | --- |
| [10 · 1440](pos-evidence/10-protegida-sin-url-sustituto-1440.png) · [390](pos-evidence/10-protegida-sin-url-sustituto-390.png) | Venta protegida sin URL: salida guiada + checkout sustituto |
| [11 · 390](pos-evidence/11-comprador-sustituto-bloqueado-390.png) | Comprador en el sustituto tras pagar el anterior: bloqueado, sin formulario |
| [12 · 1440](pos-evidence/12-terminal-venta-cobrada-por-otro-1440.png) · [390](pos-evidence/12-terminal-venta-cobrada-por-otro-390.png) | Terminal: la venta se cobró con otro checkout; checkouts de la venta según el servidor |
| [13 · 1440](pos-evidence/13-venta-antigua-sin-sustituto-1440.png) · [390](pos-evidence/13-venta-antigua-sin-sustituto-390.png) | Venta antigua: historial parcial, sin sustituto |
| [14 · 1440](pos-evidence/14-cobros-recientes-venta-1440.png) | Cobros recientes con su venta vinculada |
