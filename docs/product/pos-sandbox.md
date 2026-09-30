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
- **CSRF**: los dos POST del recorrido pasan por `assertTrustedMutationRequest` (same-origin estricto). Se añadió a `payment-links` (deuda registrada en HANDOFF, cerrada **solo para esa ruta**; `refunds` quedó cubierta en el incremento de devolución; `operational-cases/*`, `case-adjustments/*`, `disputes/*/evidence` siguen pendientes de su propia autorización).
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

### Incremento «devolución de una venta» (PR apilado sobre `integration/fluvia-pos-candidato`)

**Por qué este recorrido.** Tras #55–#58 el POS cobra de principio a fin, pero una venta cobrada no tenía salida operativa: si el cliente devuelve el producto, el cajero debía salir del POS a la página genérica del pago, cuyo formulario pide **unidades menores** (no lo que el cajero ve), no sigue el desenlace (recarga la página), no distingue un resultado incierto de un fallo y su BFF no tenía guard CSRF. La API ya tenía el contrato completo por sesión (`POST/GET /v1/organizations/:orgId/refunds`), así que no hacía falta ninguna API nueva.

Recorrido: **Cobro aprobado → «Devolver…» → todo o una parte (+ motivo) → confirmar → registrar → desenlace**, desde el terminal y desde «Cobros recientes → Seguir».

| Pantalla | Acción | API (navegador → BFF → API) | Estado / regla | Prueba |
| --- | --- | --- | --- | --- |
| Terminal, cobro `succeeded`/`partially_refunded`/`refunded` | Ver devoluciones y cupo | `GET /api/orgs/:orgId/pos/payments/:id/refunds` → `GET /v1/organizations/:orgId/refunds?payment_intent_id=&limit=100` (+ `amount_captured`/`amount_refunded` del intent ya leído) | Cupo = capturado − devuelto − (created + processing + **indeterminate**); lista todo-o-nada | `pos-refund-bff.test.ts`, `pos-refund.test.tsx` |
| Terminal | «Devolver…» → total/parcial → revisar | — (validación local con `parseMajorAmount`, misma regla de visualización que el cobro) | Parcial > cupo ⇒ error asociado al campo, sin llamada | `pos-refund.test.tsx`, captura 21 |
| Confirmación | «Devolver X» | `POST /api/orgs/:orgId/refunds` (CSRF + `Idempotency-Key`) → `POST /v1/organizations/:orgId/refunds` (`reconciliation:manage`, auditado) | Importe **explícito** también en «todo»; una key por borrador; candado contra doble envío | `pos-refund.test.tsx`, `dashboard-routes.test.ts` (PG real) |
| Resultado | Seguimiento | relectura del listado cada 2 s (tope 20) + relectura del cobro | `succeeded` / `failed` / `canceled` / `indeterminate` (no se repite) / sin desenlace tras el tope ⇒ «Consultar devoluciones» | `pos-refund-states.test.tsx`, capturas 23, 26 |
| Resultado incierto | «Reintentar de forma segura» | mismo POST, **misma key** | Red/5xx ⇒ «No sabemos si se registró»; borrador bloqueado; Escape no lo descarta | tests + navegador (2 POST, misma key), captura 24 |
| Lectura fallida | «Reintentar» | GET anterior | Datos previos marcados como desactualizados; **sin acción** hasta leer bien | captura 25 |
| Sesión caducada | Enlace «Vuelve a iniciar sesión» | 401 del BFF | «La devolución no se registró»; deja de consultar | captura 29 |
| Sin saldo del comercio | — | el API cancela antes de tocar al proveedor (`insufficient_merchant_balance`) | Explicado al cajero; el cupo vuelve | `dashboard-routes.test.ts`, captura 28 |
| Cobros recientes | Marca «Devuelta» / «Devolución parcial» | listados existentes | Se refresca también cuando cambia `amount_refunded` sin cambiar la fase | captura 27 |

**Invariante #58.** Una devolución no libera la venta: el intent reembolsado sigue reteniendo el cobro único (0046). El terminal sigue en «aprobado», no ofrece recuperar ni checkout sustituto y no llama a `/pos/checkout`; en PG real, tras devolverla entera, `POST /v1/payment_links/:id/sessions` sigue respondiendo 409 y la venta `charge: charged, succeeded_count: 1`.

**Límites reales.**

1. **Saldo del comercio.** La devolución debita `merchant.available`; los fondos de un cobro quedan en `pending` y **ningún camino de producto los libera** (solo el seed y los tests llaman a `releaseSettlement`). En un comercio recién creado toda devolución termina `canceled` (`insufficient_merchant_balance`). El seed de demo tiene disponible solo en COP; una venta en USD no se puede devolver. Además la devolución debita el **bruto** y la liquidación libera el **neto** de comisiones: devolver una venta entera necesita saldo de otras.
2. ~~**`indeterminate` no reserva cupo en el servicio.**~~ **Superado por `7d8a2af` (migración `0048`)**: `RefundService.beginIn` cuenta `created`, `processing` **e `indeterminate`** (`LIVE_REFUND_STATUSES` en `packages/payments-core/src/refunds.ts`) bajo el `FOR UPDATE` del intent, y un trigger de `0048` lo exige también en el motor. Una devolución `indeterminate` retiene su cupo en las dos entradas HTTP. (Corregido en el incremento del justificante: este límite se quedó escrito tras el arreglo.)
3. **El MockProvider aprueba siempre las devoluciones**: `failed`/`indeterminate` desde el proveedor solo se prueban con fetch simulado (jsdom), no en navegador.
4. **Ventana de 100 devoluciones** por cobro, sin cursor: si se llena, el POS no calcula el cupo y remite al detalle del pago.
5. Resultado incierto con la petición aún en vuelo: una relectura puede no verla todavía; por eso la key se conserva por borrador (importe + motivo) hasta un éxito, y rehacer el mismo borrador la reutiliza.
6. La página genérica del pago conserva su formulario en unidades menores (fuera de alcance); ahora pasa por el mismo guard CSRF.
7. Moneda/exponente: se usa la regla de visualización existente (PEND-008 sin decidir); no se tocan país, impuestos ni reglas de COP (PEND-007).

**Verificación en navegador** (local: PG 16, Redis, API/worker `NODE_ENV=local`, checkout y dashboard `next start`, seed de demo, MockProvider). Recorrido a 390/768/1440 px sin scroll horizontal (comprobado `scrollWidth ≤ clientWidth` en cada captura), tramo parcial completo **solo con teclado** a 390 px (foco en la opción, flecha ⇒ importe, Enter ⇒ confirmación enfocada, Tab+Enter ⇒ devolver). Capturas saneadas (ids → `••••` + 4 últimos, URL de checkout y correos eliminados):

| Captura | Estado |
| --- | --- |
| [20 · 1440](pos-evidence/20-cobro-aprobado-devolucion-1440.png) · [768](pos-evidence/20-cobro-aprobado-devolucion-768.png) · [390](pos-evidence/20-cobro-aprobado-devolucion-390.png) | Cobro aprobado con panel de devolución |
| [21 · 390](pos-evidence/21-parcial-importe-excesivo-390.png) | Parcial por encima del cupo (error en el campo) |
| [22 · 390](pos-evidence/22-confirmar-parcial-390.png) · [1440](pos-evidence/22-confirmar-parcial-1440.png) | Confirmación |
| [23 · 390](pos-evidence/23-parcial-devuelta-390.png) · [768](pos-evidence/23-parcial-devuelta-768.png) · [1440](pos-evidence/23-parcial-devuelta-1440.png) | Parcial completada; «Devolución parcial» en recientes |
| [24 · 1440](pos-evidence/24-devolucion-incierta-1440.png) · [390](pos-evidence/24-devolucion-incierta-390.png) | Resultado incierto (red cortada) |
| [25 · 1440](pos-evidence/25-lectura-fallida-desactualizada-1440.png) | Lectura fallida: datos desactualizados, sin acción |
| [26 · 1440](pos-evidence/26-devuelta-por-completo-1440.png) · [390](pos-evidence/26-devuelta-por-completo-390.png) | Devuelta por completo: sin recuperar ni otro checkout |
| [27 · 1440](pos-evidence/27-cobros-recientes-devuelta-1440.png) | Cobros recientes con marca de devolución |
| [28 · 1440](pos-evidence/28-sin-saldo-cancelada-1440.png) · [390](pos-evidence/28-sin-saldo-cancelada-390.png) | Sin saldo disponible: cancelada y explicada |
| [29 · 390](pos-evidence/29-sesion-caducada-390.png) · [1440](pos-evidence/29-sesion-caducada-1440.png) | Sesión caducada al registrar |

### Incremento «justificante de cobro y devolución» (PR apilado sobre `claude/pos-refund-integrity`)

**Qué es y qué no.** Un **justificante operativo** del sandbox de un cobro confirmado y de sus devoluciones, para enseñarlo o imprimirlo en el mostrador. **No es una factura ni un documento fiscal**: no lleva numeración fiscal, impuestos, datos del comprador ni requisitos legales de ningún país (PEND-007 y PEND-008 siguen abiertas). No se envía por correo, no usa un proveedor real, no libera fondos ni añade reglas de país, moneda o COP.

Recorrido: **Terminal (cobro aprobado) o «Cobros recientes» → «Ver justificante» → `/o/:orgId/pos/receipts/:paymentId` → «Imprimir justificante»**.

**Lecturas canónicas usadas** (todas existentes, plano de sesión; no hay endpoint nuevo en la API). El navegador solo llama al BFF nuevo `GET /api/orgs/:orgId/pos/payments/:paymentId/receipt`, que compone:

| Lectura del BFF | Permiso | Para qué |
| --- | --- | --- |
| `GET /v1/organizations/:orgId/payment_intents/:id` (×2, antes y después de la lista) | `payments:read` | importe, `amount_captured`, `amount_refunded`, moneda, estado, comercio, venta, `created_at` |
| `GET /v1/organizations/:orgId/refunds?payment_intent_id=&limit=100` | `payments:read` | importe, estado y fecha de cada devolución (validación todo-o-nada de `pickRefundList`) |
| `GET /v1/organizations/:orgId/merchants/:merchantId` | `merchants:read` (todo rol) | nombre del comercio |
| `GET /v1/organizations/:orgId/payment_links/:id/sale` (solo si hay venta) | `payments:read` | concepto (`description` del link) y `completed_at` del checkout que cobró **este** intent |
| `GET /v1/organizations` (server component de la página) | sesión | nombre de la organización |

Reglas del BFF: whitelist; **todo o nada** (cualquier lectura fallida o incoherente ⇒ 502, nunca un justificante a medias); 401 ⇒ `invalid_session`; 403/404 del cobro ⇒ `not_found`; intent que la API no da por cobrado (`succeeded`/`partially_refunded`/`refunded`) ⇒ **409 `not_charged`**. **Instantánea coherente**: cobro → devoluciones → cobro; si el cobro cambió entre medias se repite (máx. 3) y si no se estabiliza, 502. Con la lista completa, Σ devoluciones `succeeded` debe ser igual a `amount_refunded` (así lo garantiza `RefundService`, que suma en la misma transacción que pasa la devolución a `succeeded`); si no cuadra, 502. Es una **comprobación**, no un dato mostrado.

**Dato mostrado → fuente → estado → prueba**

| Dato mostrado | Fuente | Estado / regla | Prueba |
| --- | --- | --- | --- |
| Importe cobrado | `payment_intent.amount_captured` | obligatorio; sin él no hay justificante | `pos-receipt.test.tsx` (contrato, vista) |
| Importe de la venta | `payment_intent.amount` | solo si difiere del capturado | `pos-receipt.test.tsx` |
| Estado | `payment_intent.status` | `succeeded` «Cobro confirmado» · `partially_refunded` «… devolución parcial» · `refunded` «… devuelto por completo»; otro ⇒ 409, sin justificante | BFF `it.each`, vista, capturas 30–32, 37 |
| Organización | `GET /v1/organizations` → `name` | se omite si no está | vista |
| Comercio | `merchants/:id` → `name` | debe ser el `merchant_id` del cobro; si no, 502 | BFF «TODO o NADA» |
| Concepto | `sale.payment_link.description` | vacío ⇒ «Sin concepto»; sin venta ⇒ «Cobro sin venta vinculada» | contrato, vista |
| Cobro iniciado | `payment_intent.created_at` | tal cual | vista |
| Checkout completado | `sale.checkouts[intent].checkout_session.completed_at` | solo con venta; `null` ⇒ «No informado por la API». No se presenta como «hora del cobro» (el intent no tiene `succeeded_at`) | contrato |
| Referencia | 8 últimos caracteres del id del cobro | nunca el id completo | `receiptRef`, vista (sin UUID en el DOM) |
| Devuelto (confirmado) | `payment_intent.amount_refunded` | solo liquidadas; no se calculan netos ni pendientes | refunds-test parcial/total/indeterminate |
| Cada devolución: importe, fecha | `refund.amount`, `refund.created_at` | tal cual; `reason` y `failure_code` **no** salen (nota interna del cajero, puede llevar datos personales) | BFF «quita motivo y failure_code» |
| Cada devolución: estado | `refund.status` | `succeeded` «Devuelta» · `created`/`processing` «En curso» (aún no devuelta) · **`indeterminate` «Pendiente de verificación»**, jamás contada como devuelta · `failed`/`canceled` «No devuelta» | `pos-receipt-refunds.test.tsx`, capturas 31, 33, 34 |
| Aviso de pendientes | hay alguna `indeterminate` / `created`/`processing` **en una lista completa** | «NO las cuenta como devueltas» / «aún no cuentan» | refunds-test, capturas 33, 34 |
| Lista de 100 o más | la API devuelve las 100 **más recientes** (`ORDER BY created_at DESC LIMIT 100`) | **sin desglose** (el BFF entrega `refunds: []`, el cliente rechaza desglose + truncado), sin avisos derivados de la lista; aviso impreso: «NO incluye el desglose… no se puede saber si hay devoluciones en curso o pendientes»; solo el total `amount_refunded` | refunds-test, E2E «más de 100», stack real (d), capturas 42, 43, 52, 53 |
| Consultado | hora del navegador al recibir la lectura | metadato de la lectura, no dato de la API | vista |

**Estados de la vista**: cargando (`aria-busy`, captura 39); error sin datos con «Reintentar»; relectura fallida ⇒ datos previos marcados como **desactualizados**, **«Imprimir» y Ctrl/Cmd+P bloqueados** hasta leer bien (foco en el aviso, captura 35) y, si se imprime desde el menú del navegador, en papel **solo** sale «JUSTIFICANTE NO VÁLIDO» (captura 44); sesión caducada ⇒ **se retiran los datos** y se ofrece iniciar sesión (captura 36); sin acceso / no encontrado; no confirmado (captura 37). «Actualizar» relee sin recargar y anuncia «Justificante actualizado» (`role=status`). Teclado: Tab recorre Imprimir → Actualizar → Volver; Enter actualiza; un fallo tras una acción del usuario recibe el foco. Móvil: la lista clave/valor pasa a una columna y los botones ocupan el ancho. Impresión (`@media print`): oculta navegación, avisos de pantalla y botones; blanco y negro; cada devolución sin cortes de página.

#### Impresión: qué controla la aplicación y qué no

La URL del justificante lleva el id **completo** de la organización y del cobro. Chromium la imprime en el pie de página si la casilla «Encabezados y pies de página» está activa. Resultado **medido** en Chromium 1194 (PDF real generado con la plantilla de pie `url` y leído con `e2e/pdf-text.ts`; tests «pie de página impreso» de `e2e/receipt.spec.ts`, que corren en CI):

| Vía de impresión | ¿Controla la app la URL del pie? | Pie impreso (medido) |
| --- | --- | --- |
| Botón «Imprimir justificante» | **Sí**: `history.replaceState` a `/` **antes** de `window.print()`, restaurada después | `http://…/` — sin ids |
| Atajo Ctrl/Cmd+P | **Sí**: la app intercepta el atajo y usa el mismo camino que el botón (y lo bloquea si los datos no son imprimibles) | sin ids (misma vía que el botón; test E2E de teclado) |
| Menú del navegador («Imprimir…») | **No**: no se puede interceptar. Chromium toma la URL **al iniciar** la impresión, **antes** de `beforeprint`; el listener `beforeprint` de la app cambia la URL pero **no** llega al pie | **con ids** (el test lo fija: si Chromium cambiara, fallaría y habría que revisar esto) |
| Casilla «Encabezados y pies de página» | **No**: es del diálogo del navegador | — |
| Título del encabezado | Sí (`document.title` = «Fluvia · Operación», sin ids) | sin ids |

Por eso sigue el **aviso en pantalla** junto al botón (no se imprime): la URL se sustituye al imprimir, pero conviene desactivar «Encabezados y pies de página» porque esa casilla la controla el navegador. Firefox y Safari no se han verificado (no hay navegador en este entorno). El `replaceState` es same-origin, no navega ni crea rutas; si `afterprint` no llegara, la URL queda en `/` (inicio, con sesión obligatoria).

#### Verificación contra el stack REAL del sandbox

Local (no CI): PostgreSQL 16, Redis, API real (`apps/api/e2e/refund-timeout-server.ts`), MockProvider, checkout y dashboard con `next start`, seed de demo. Arranque: `apps/dashboard/e2e/real-stack/start.sh`; prueba: `npx playwright test -c e2e/real-stack/playwright.config.ts` desde `apps/dashboard`.

- **Cómo se llega a `indeterminate` por la vía real.** `MockPaymentProvider.refundPayment` aprueba siempre. El lanzador arranca la API real (`src/server.ts`) y cambia **solo** una cosa: si existe un fichero-bandera, la **siguiente** devolución enviada al mock lanza `ProviderTimeoutError`, y el `RefundService` real recorre su rama de desenlace desconocido (reserva retenida). Solo `local`/`test`. No toca código de producto.
- **Recorrido como cajero, desde el POS**: (a) venta COP 50.000 → checkout alojado → el comprador paga (`tok_approve`) → aprobado; (b) devolución parcial 12.000 **confirmada**; (c) devolución parcial 8.000 con timeout ⇒ **`indeterminate`**; (d) 100 devoluciones más de 1 por la API (sesión real) ⇒ 102 en total.
- **Comparación**: tras cada paso, el texto del justificante (importe cobrado, devuelto, estado, importe y estado de **cada** devolución) se compara con `payment_intents/:id` y `refunds?payment_intent_id=` leídos con la misma sesión. Coincidieron en los cuatro pasos ([`real-stack-comparison.json`](pos-evidence/real-stack-comparison.json)). Fila final en PostgreSQL: `partially_refunded | 50000 | 12100 | 102 devoluciones | succeeded:12000, indeterminate:8000`. En (d) la ventana de la API **no** contiene la `indeterminate` (es la más antigua) y el justificante no muestra desglose.
- COP se muestra con exponente 0 («$ 50.000»): es la regla de visualización existente (PEND-008, sin cambios).

#### E2E de navegador versionado (CI)

`apps/dashboard/e2e/receipt.spec.ts` (Playwright) contra el dashboard real (`next build` + `next start`) y la API **sintética versionada** `e2e/synthetic-api.mjs`, con la misma forma que los serializers reales, `ORDER BY created_at DESC LIMIT` incluido. Job de CI `E2E navegador (justificante del POS)`: instala Chromium con `playwright install --with-deps`, compila y ejecuta `pnpm --filter @fluvia/dashboard e2e`. Cubre a **390, 768 y 1440 px**: confirmado, parcial, pendiente de verificación, 100 o más devoluciones (pantalla y papel), teclado (Tab → Actualizar → Enter con fallo ⇒ foco en el aviso; Ctrl+P bloqueado; Reintentar; Ctrl+P ⇒ URL sin ids), botón Imprimir y vista de impresión. A 390 y 1440: sesión caducada, no confirmado, total, en curso y cargando. Además: acceso desde el terminal (con teclado) y «Cobros recientes», y el pie impreso leído del PDF. Siempre sin scroll horizontal y sin UUID ni URL en el texto visible. Comprobado que **muerde**: con la vista antigua (desglose con lista truncada) fallan los 3 tests de «más de 100»; con `window.print()` sin sustituir la URL fallan «teclado» y «botón Imprimir». Las capturas 30–44 las genera este spec (`RECEIPT_EVIDENCE_DIR`); las 50–53, el del stack real.

| Captura | Estado |
| --- | --- |
| [30 · 390](pos-evidence/30-justificante-cobro-390.png) · [768](pos-evidence/30-justificante-cobro-768.png) · [1440](pos-evidence/30-justificante-cobro-1440.png) | Cobro confirmado, con venta y concepto |
| [31 · 390](pos-evidence/31-justificante-parcial-390.png) · [768](pos-evidence/31-justificante-parcial-768.png) · [1440](pos-evidence/31-justificante-parcial-1440.png) | Devolución parcial + una cancelada |
| [32 · 390](pos-evidence/32-justificante-devuelto-total-390.png) · [1440](pos-evidence/32-justificante-devuelto-total-1440.png) | Devuelto por completo |
| [33 · 390](pos-evidence/33-justificante-pendiente-verificacion-390.png) · [768](pos-evidence/33-justificante-pendiente-verificacion-768.png) · [1440](pos-evidence/33-justificante-pendiente-verificacion-1440.png) | Devolución `indeterminate`: pendiente de verificación |
| [34 · 390](pos-evidence/34-justificante-devolucion-en-curso-390.png) · [1440](pos-evidence/34-justificante-devolucion-en-curso-1440.png) | Devolución en curso |
| [35 · 390](pos-evidence/35-lectura-fallida-desactualizado-390.png) · [768](pos-evidence/35-lectura-fallida-desactualizado-768.png) · [1440](pos-evidence/35-lectura-fallida-desactualizado-1440.png) | Relectura fallida (solo teclado): desactualizado, sin imprimir |
| [36 · 390](pos-evidence/36-sesion-caducada-390.png) · [1440](pos-evidence/36-sesion-caducada-1440.png) | Sesión caducada: datos retirados |
| [37 · 390](pos-evidence/37-sin-justificante-no-confirmado-390.png) · [1440](pos-evidence/37-sin-justificante-no-confirmado-1440.png) | Cobro rechazado: sin justificante |
| [38 · 390](pos-evidence/38-impresion-390.png) · [768](pos-evidence/38-impresion-768.png) · [1440](pos-evidence/38-impresion-1440.png) | Vista de impresión (medio `print`) |
| [39 · 390](pos-evidence/39-cargando-390.png) · [1440](pos-evidence/39-cargando-1440.png) | Cargando |
| [40 · 390](pos-evidence/40-terminal-ver-justificante-390.png) · [1440](pos-evidence/40-terminal-ver-justificante-1440.png) | Terminal: «Ver justificante» |
| [41 · 1440](pos-evidence/41-cobros-recientes-justificante-1440.png) | «Cobros recientes»: justificante solo en cobros confirmados |
| [42 · 390](pos-evidence/42-justificante-mas-de-100-390.png) · [768](pos-evidence/42-justificante-mas-de-100-768.png) · [1440](pos-evidence/42-justificante-mas-de-100-1440.png) | 100 o más devoluciones: sin desglose |
| [43 · 390](pos-evidence/43-impresion-mas-de-100-390.png) · [768](pos-evidence/43-impresion-mas-de-100-768.png) · [1440](pos-evidence/43-impresion-mas-de-100-1440.png) | Ídem, en papel |
| [44 · 390](pos-evidence/44-impresion-desactualizado-390.png) · [768](pos-evidence/44-impresion-desactualizado-768.png) · [1440](pos-evidence/44-impresion-desactualizado-1440.png) | Desactualizado en papel: solo «NO VÁLIDO» |
| [50 · 390](pos-evidence/50-real-parcial-confirmada-390.png) · [768](pos-evidence/50-real-parcial-confirmada-768.png) · [1440](pos-evidence/50-real-parcial-confirmada-1440.png) | **Stack real**: parcial confirmada |
| [51 · 390](pos-evidence/51-real-indeterminate-390.png) · [768](pos-evidence/51-real-indeterminate-768.png) · [1440](pos-evidence/51-real-indeterminate-1440.png) | **Stack real**: `indeterminate` |
| [52 · 390](pos-evidence/52-real-mas-de-100-390.png) · [1440](pos-evidence/52-real-mas-de-100-1440.png) · [53 papel · 1440](pos-evidence/53-real-impresion-mas-de-100-1440.png) | **Stack real**: 102 devoluciones, sin desglose |

**Límites reales (comprobados).**

1. **No es fiscal**: sin numeración, impuestos, datos del comprador ni validez legal.
2. **Menú «Imprimir…» del navegador**: el pie puede llevar la URL con ids (medido en Chromium). La app no lo controla. Queda el aviso en pantalla. Firefox y Safari no se han verificado.
3. **No hay hora de cobro**: el intent no expone `succeeded_at`. Se muestran `created_at` del intent y `completed_at` del checkout.
4. **Instantánea, no seguimiento**: una devolución `indeterminate` o en curso se refleja al pulsar «Actualizar». Se puede imprimir con pendientes: el papel dice «pendiente de verificación».
5. **100 o más devoluciones**: no hay desglose (ni en pantalla ni en papel) ni se puede afirmar si hay pendientes. La API no tiene cursor. Con exactamente 100 también se trata como truncada (la API no permite distinguirlo).
6. **Fallo total ante una lectura secundaria**: si el comercio o la venta no se pueden leer, no hay justificante (502). Es deliberado.
7. **Stack real solo en local**: el recorrido contra PG/Redis/API/MockProvider no corre en CI; en CI corre el E2E contra la API sintética. `indeterminate` se provoca con el lanzador de verificación, porque el MockProvider nunca la produce.
8. `indeterminate` **sí** reserva cupo en el servicio desde `7d8a2af`/`0048` (ver límite 2 del incremento de devolución, corregido). El texto anterior de este límite afirmaba lo contrario y era erróneo.
