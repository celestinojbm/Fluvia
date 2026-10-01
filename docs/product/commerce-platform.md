# Plataforma del comercio — catálogo → venta → cobro, gestión y «Pagar en cuotas» (sandbox)

Estado: **incremento sandbox, sin merge** (PR draft apilado sobre `claude/pos-experiencia-demo`) · Proveedores: **MockProvider** (cobros) y **proveedor de cuotas simulado** · Datos: **sintéticos** · Fluvia no es banco, adquirente, procesador ni financiador. Nada de esto autoriza producción, exposición pública, sandbox compartido ni proveedores reales.

Referencia de alcance: plataformas como Clover, Toast u Owner (no se copian marcas ni interfaces). La identidad visual es propia: «río» (verde azulado profundo) + «arena», sobre neutros fríos.

## 1. Qué hay ahora (resumen)

| Superficie | Antes | Ahora |
| --- | --- | --- |
| **A. Administración del comercio** | Panel técnico (listas de pagos, webhooks…) con barra horizontal | Estructura común con **navegación lateral** (cajón en móvil), Inicio con indicadores honestos, **Catálogo**, **Ventas**, **Clientes**, **Caja**, **Cuotas**, **Equipo**, **Configuración**. El panel técnico sigue en «Operación avanzada» |
| **B. Operación del cajero** | Terminal con importe libre | **Nueva venta**: catálogo → carrito → cliente opcional → revisión → venta registrada → **terminal** que cobra ESA venta (el flujo de cobro existente, con sus garantías) |
| **C. Comprador** | Checkout con importe | Checkout con **resumen de compra** (líneas), **comprobante** tras pagar, opción **«Pagar en cuotas» (simulación)** con confirmación explícita y **consulta del plan** |

Recorrido principal comprobado en navegador contra el stack real (PostgreSQL + API + MockProvider + checkout + dashboard): **10/10** escenarios de la plataforma y **7/7** del recorrido POS previo.

## 2. Mapa de rutas y reutilización

```
/o/:org                         Inicio (indicadores + actividad)          NUEVO
/o/:org/sell                    Nueva venta (catálogo + carrito)          NUEVO
/o/:org/pos?link=&order=        Terminal: cobra la venta del pedido       REUTILIZA PosTerminal (+ estado «lista para cobrar»)
/o/:org/orders[/:id]            Ventas: lista, búsqueda, detalle          NUEVO
/o/:org/catalog[/new|/:id]      Catálogo: lista, alta, edición            NUEVO
/o/:org/customers[/new|/:id]    Clientes: ficha + compras                 NUEVO (tabla `customers` existente)
/o/:org/cash                    Caja: resumen operativo diario            NUEVO
/o/:org/installments[/:id]      Cuotas (simulación): planes y eventos     NUEVO
/o/:org/team                    Equipo: miembros + matriz de permisos     NUEVO (API /members existente)
/o/:org/settings                Configuración: comercio + métodos         NUEVO (API /merchants existente)
/o/:org/payments, /refunds      Pagos y devoluciones                      EXISTENTE (dentro del nuevo layout)
/o/:org/pos/receipts/:id        Justificante                              EXISTENTE
/o/:org/activity                Operación avanzada (panel técnico previo) MOVIDO desde /o/:org
checkout /c/:id                 Pago + resumen + cuotas                   EXTENDIDO
checkout /c/:id/cuotas#secret   Consulta del plan por el comprador        NUEVO
```

Reutilización deliberada: el **cobro** es el de siempre (payment link `single_charge` de 0046 + checkout alojado + seguimiento + recuperación + devolución + justificante). El pedido solo **crea** esa venta con el total calculado en servidor; no hay un segundo camino de cobro.

## 3. Modelo y contratos (migraciones aditivas)

### 0049 — catálogo y pedidos

- `catalog_categories`, `catalog_products` (precio BIGINT en unidades menores, moneda, `available`, `version` para concurrencia optimista, baja lógica `archived_at`). SKU y nombre de categoría únicos por organización.
- `commerce_orders` + `commerce_order_lines`: **append-only** (sin UPDATE/DELETE). Cada línea copia nombre, SKU y precio unitario: el **precio histórico** se conserva aunque el producto cambie o se archive.
- Numeración legible por organización (`commerce_order_counters`), no fiscal.
- **Invariantes en el motor** (constraint triggers diferidos, al COMMIT): Σ líneas = total; nº de líneas coherente; el link del pedido es de cobro único, del mismo comercio, por el mismo importe y moneda. Una línea añadida después en otra transacción se rechaza.
- RLS **forzado** por tenant + FKs compuestas `(id, tenant_id)`: nada cruza organización.
- El **estado de pago no se guarda**: se deriva de `payment_intents` del link (misma regla que `getSale`): `awaiting_payment` · `payment_in_progress` (incluye incierto) · `paid` · `partially_refunded` · `refunded`.

### 0050 — cuotas SANDBOX

- `sandbox_installment_plans`, `sandbox_installments`, `sandbox_installment_events` (append-only). Prefijo `sandbox_`, **sin relación con ledger, attempts ni saldos**.
- Máquinas de estado en el motor: plan `pending → approved|declined`; cuota `scheduled → paid_simulated|overdue_simulated`, `overdue_simulated → paid_simulated`; importes y fechas **inmutables**; Σ cuotas = total (constraint diferido); como máximo **un plan vivo** por pedido.
- **Guarda de doble cobro**: trigger en `payment_intents` (`→ processing`) que rechaza el cobro si el link tiene un plan `pending`/`approved` (`409 installment_plan_active`). Simétricamente, el servicio solo crea un plan bajo el lock del link si ningún intent retiene la venta. Probado con carreras tarjeta ↔ cuotas: como mucho gana uno. No altera importes, ledger ni reglas monetarias: solo impide **empezar** un segundo cobro.

### API (plano de sesión; RBAC existente, sin roles nuevos)

| Endpoint | Permiso | Notas |
| --- | --- | --- |
| `GET …/catalog/categories` · `GET …/catalog/products[?q&category_id&sellable&include_archived]` · `GET …/catalog/products/:id` | `payments:read` | Búsqueda por nombre/SKU con comodines escapados |
| `POST …/catalog/categories` · `POST …/catalog/products` · `PATCH …/catalog/products/:id` (`expected_version`) | `merchants:write` | Auditado; 409 `catalog_version_conflict` / `catalog_duplicate` |
| `GET …/orders[?q&state&customer_id&before_number&limit]` · `GET …/orders/:id` · `GET …/payment_links/:id/order` | `payments:read` | Filtros y paginación por cursor **en servidor** |
| `POST …/orders` (`Idempotency-Key`, `expected_total`) | `reconciliation:manage` | Total en servidor; 409 `order_total_changed`; 422 `product_unavailable` / `order_currency_mismatch`; auditado en la misma tx |
| `GET/POST …/customers` · `GET/PATCH …/customers/:id` | lectura `payments:read`, escritura `reconciliation:manage` | Reutiliza la tabla `customers`; la ficha trae sus compras |
| `GET …/commerce/summary?from&to` · `GET …/commerce/cash?from&to` | `payments:read` | Por moneda, periodo UTC declarado |
| `GET …/installment_plans[/:id]` | `payments:read` | `simulated: true` en cada respuesta |
| `POST …/installment_plans/:id/simulate_decision` · `POST …/installment_plans/:id/installments/:seq/simulate` | `reconciliation:manage` | Eventos SIMULADOS, auditados |
| `GET /v1/checkout_sessions/:id/order` · `POST …/installments/quote` · `POST …/installments` (`accept_terms: true`) | `client_secret` del comprador | Reenvío idéntico ⇒ el mismo plan (200) |

Errores nuevos (aditivos, golden actualizado): `catalog_version_conflict`, `catalog_duplicate`, `order_total_changed`, `product_unavailable`, `order_currency_mismatch`, `installment_plan_not_allowed`, `installment_plan_active`.

## 4. Pantalla → funcionalidad → API → prueba → estado

Estado: **Sandbox** = implementado y verificado · **Incompleto** = funciona con hueco declarado · **Roadmap** = no construido.

| Pantalla | Funcionalidad | API | Prueba | Estado |
| --- | --- | --- | --- | --- |
| Layout (todas) | Navegación lateral / cajón móvil, saltar al contenido, rol y usuario, sesión caducada y sin acceso propios | `/v1/auth/session`, `…/members` | E2E 1, 2, 10 · receipt E2E (CI) | Sandbox |
| Inicio | 6 indicadores con significado, fuente y periodo; actividad reciente | `…/commerce/summary`, `…/orders` | `commerce.test.ts` (resumen), E2E 1, 9 | Sandbox |
| Catálogo | Búsqueda, categoría, estado; alta con validación; edición con versión; archivar | `…/catalog/*` | `commerce.test.ts`, `commerce-routes.test.ts`, E2E 3 | Sandbox |
| Nueva venta | Carrito (cantidades, quitar, total), cliente nuevo o existente, nota, revisión, registro idempotente, resultado incierto bloqueado, precio cambiado ⇒ refresco | `POST …/orders`, `…/customers` | `sell-workspace.test.tsx`, `commerce-routes.test.ts`, E2E 4 | Sandbox |
| Terminal (pedido) | «Lista para cobrar» → checkout → seguimiento → aprobado/rechazado/incierto → recuperación → devolución → justificante | existentes del POS + `…/payment_links/:id/order` | E2E 5–7, journey 7/7 | Sandbox |
| Ventas | Lista con búsqueda (#número, cliente, nota), estado, paginación; detalle con líneas históricas y acciones según estado | `…/orders` | `commerce.test.ts`, E2E 5–8 | Sandbox |
| Clientes | Ficha mínima, búsqueda, compras vinculadas y cobrado neto por moneda | `…/customers` | `commerce-routes.test.ts`, E2E 9 | Sandbox |
| Caja | Cobros confirmados por canal, devoluciones por estado, neto operativo, cuotas aparte | `…/commerce/cash` | `commerce.test.ts`, E2E 9 | **Incompleto**: sin método de pago por cobro (la API no lo registra), sin arqueo/turnos |
| Cuotas (comercio) | Lista, calendario, historial, eventos simulados (aprobar/rechazar pendiente, cuota pagada/vencida) | `…/installment_plans*` | `commerce.test.ts`, `commerce-routes.test.ts`, E2E 8 | Sandbox (simulación) |
| Equipo | Miembros y matriz de permisos (espejo verificado del RBAC) | `…/members` | `sell-workspace.test.tsx` (paridad), E2E 9 | **Incompleto**: sin invitaciones ni cambio de rol (no hay contrato) |
| Configuración | Datos de la organización, comercios, estado real de métodos | `…/organizations/:id`, `…/merchants` | E2E 9 | Sandbox (lectura) |
| Checkout del comprador | Resumen de compra, comprobante, cuotas con aceptación explícita, plan vivo bloquea otros métodos | `/v1/checkout_sessions/:id/{status,confirm,order,installments*}` | `checkout-installments.test.tsx`, E2E 5, 8 | Sandbox |
| Consulta del plan | Calendario, estados, historial | `GET …/order` (client_secret) | `checkout-installments.test.tsx`, E2E 8 | Sandbox |

## 5. Garantías conservadas y añadidas

- **Doble cobro**: la venta de un pedido es de cobro único (0046/0047 intactas). Cuotas ↔ tarjeta: guarda del motor en ambos sentidos.
- **Reenvíos**: `POST …/orders` idempotente (misma key ⇒ mismo pedido; misma key con otro carrito ⇒ `idempotency_key_reuse`). El carrito usa una key por contenido revisado; tras un resultado incierto se bloquea y «Reintentar de forma segura» reusa la key. El plan de cuotas es idempotente por (pedido, nº de cuotas, escenario).
- **Incertidumbre**: un cobro asíncrono o indeterminado deja el pedido en «Cobro en curso · sin confirmar» y **no** se ofrece cobrar otra vez. Un fallo de lectura nunca se muestra como «vacío»: estados propios de error, sin acceso y sesión caducada.
- **Importes en servidor**: el total lo calcula la API desde el catálogo; el total que vio el cajero viaja como `expected_total` y, si no coincide, no se crea nada.
- **Aislamiento**: RLS forzado + FKs compuestas; pruebas de que otra organización no ve ni opera productos, pedidos, clientes ni planes, y no puede vender productos ajenos.
- **CSRF**: todo BFF mutante nuevo pasa por `assertTrustedMutationRequest` (same-origin estricto) y valida los ids como UUID.
- **Lo vendido no es saldo**: Inicio y Caja separan cobrado bruto (no disponible), sin confirmar (no ingreso) y cuotas simuladas (no cobro).

## 6. «Pagar en cuotas» — motor sandbox

**Qué es.** Una simulación completa de la experiencia: el comprador elige 3, 4 o 6 cuotas quincenales, ve importe inicial, calendario, total y condiciones, elige un **escenario de prueba** (aprobado / rechazado / pendiente) y **confirma explícitamente**. El comercio ve el plan, su historial y puede disparar eventos simulados (decidir un pendiente, marcar una cuota pagada o vencida). El comprador consulta su plan con el secreto de su checkout.

**Qué no es.** No hay financiador, crédito, scoring, intereses, mora, cobros externos ni integración con Afterpay u otro BNPL. Un plan aprobado **no** marca la venta como cobrada ni toca ledger o saldos (probado: el número de asientos del ledger no cambia).

**Cálculo.** Unidades menores (bigint). Reparto `⌊total/n⌋` y el resto, una unidad a cada una de las primeras cuotas: ninguna difiere en más de una unidad y Σ cuotas = total (también exigido por el motor). Prueba de propiedad sobre cientos de combinaciones (total × nº de cuotas) y un entero de 53 bits. Fechas UTC informativas: **nada cambia por el paso del tiempo** (no hay tareas programadas); «vencida» es un evento simulado explícito.

**Parámetros de DEMOSTRACIÓN** (`INSTALLMENT_DEMO_TERMS`, versión `demo-2026-10` grabada en cada plan): 3/4/6 cuotas, cada 15 días, 0 % de interés, sin comisiones. No son una política comercial aprobada.

### Decisiones para una financiación real (no tomadas)

| Tema | Pregunta abierta |
| --- | --- |
| Financiador | ¿Quién asume el crédito: un financiador regulado asociado, el propio comercio (crédito de la casa) o un tercero BNPL? Fluvia no puede ser el financiador sin licencia |
| Riesgo de impago | ¿Quién absorbe la mora? ¿Con recurso al comercio? Determina precios, límites por comprador y reservas |
| Desembolso al comercio | ¿Total anticipado (menos descuento) al aprobar, o a medida que se cobran las cuotas? Afecta la liquidación y el ledger (cuentas nuevas, no las actuales) |
| Cobro de cuotas | Medio (domiciliación, pago móvil, efectivo en tienda), reintentos, notificaciones, conciliación |
| Devoluciones | ¿Se anula el plan, se reembolsan cuotas pagadas, se reduce el saldo pendiente? Orden de imputación |
| Identidad y scoring | KYC del comprador, consulta a burós, límites, protección de datos |
| Requisitos de mercado | Licencias de crédito/consumo, tasas máximas, transparencia de costos, protección al consumidor, facturación e impuestos (PEND-007) |

### Venezuela como dirección de producto (sin cambios silenciosos)

El propietario apunta a **Venezuela**. Implicaciones a decidir explícitamente, no aplicadas en este PR: moneda de operación (VES — no está en `@fluvia/money` — y/o USD, muy usado en comercio minorista), exponentes y redondeos (PEND-008 abierta para COP), impuestos (IVA, IGTF sobre pagos en divisas) y facturación fiscal, medios locales (pago móvil, transferencias, efectivo en divisas), la práctica local de compras en cuotas en tiendas (la periodicidad quincenal con importe inicial de la demo es una hipótesis de experiencia que conviene validar con comercios y compradores, no un dato verificado) y el marco regulatorio de crédito al consumo. Hoy el país del onboarding, el formato `es-CO`, el registro de monedas y la matriz jurisdiccional siguen sin tocar.

## 7. Verificación

| Nivel | Qué | Resultado |
| --- | --- | --- |
| Dominio (PG real) | `packages/commerce/test/*.test.ts`: catálogo, versión, duplicados, aislamiento, total en servidor, precio histórico, inmutabilidad, invariantes del motor, numeración concurrente, estado derivado (aprobado/rechazado/asíncrono), cuotas (aceptación, Σ = total, no toca ledger, idempotencia, carrera tarjeta ↔ cuotas, pendiente/rechazado, eventos en orden, aislamiento), resumen | 27/27 (8 corridas seguidas estables) |
| HTTP (PG real) | `apps/api/test/commerce-routes.test.ts`: permisos por rol, 401/404 indistinguible, idempotencia y `idempotency_key_reuse`, auditoría, clientes, comprador por client_secret, 409 `installment_plan_active`, indicadores | 8/8 · suite completa de la API verde |
| Componentes (jsdom + axe) | `sell-workspace.test.tsx` (total, key reutilizada tras incierto, precio cambiado ⇒ otra key, doble clic, axe, paridad RBAC), `checkout-installments.test.tsx` | dashboard 515/515 · checkout 27/27 |
| Navegador, stack real | `e2e/real-stack/commerce-real-stack.spec.ts` (10 escenarios) + `journey-real-stack.spec.ts` (7) | 10/10 · 7/7, también contra la demo aislada de §8 |
| Navegador, CI | `e2e/receipt.spec.ts` contra API sintética (ampliada con `/v1/auth/session`) | 31/31 |
| Responsive | Sin scroll horizontal ni tablas recortadas a 390/768/1440 (E2E) y 900/1024/1280 (barrido manual de 12 pantallas) | OK |

Teclado y foco: «Saltar al contenido» es el primer foco; el cajón móvil se abre con Enter y se cierra con Escape devolviendo el foco al botón; formularios con etiquetas, errores asociados (`aria-describedby`) y foco en alertas; tablas apiladas en móvil con etiqueta por celda; regiones desplazables enfocables.

### Capturas saneadas

En [`commerce-evidence/`](commerce-evidence/) (ids → `••••1234`, URLs fuera, sin secretos; datos sintéticos). 390 y 1440 px en todas; 768 px en las pantallas clave.

| # | Pantalla | | # | Pantalla |
| --- | --- | --- | --- | --- |
| 01 | [Inicio 1440](commerce-evidence/01-inicio-1440.png) · [768](commerce-evidence/01-inicio-768.png) · [390](commerce-evidence/01-inicio-390.png) | | 15 | [Venta rechazada](commerce-evidence/15-venta-rechazada-1440.png) |
| 02 | [Menú móvil](commerce-evidence/02-menu-movil-390.png) | | 16 | [Cobro en curso (incierto)](commerce-evidence/16-venta-cobro-en-curso-1440.png) |
| 03–05 | [Catálogo](commerce-evidence/03-catalogo-1440.png) · [validación](commerce-evidence/04-producto-validacion-390.png) · [editado (v2)](commerce-evidence/05-producto-editado-1440.png) | | 17–18 | [Cuotas: elección](commerce-evidence/17-cuotas-eleccion-390.png) · [aprobado (comprador)](commerce-evidence/18-cuotas-aprobado-comprador-390.png) |
| 06–09 | [Venta vacía](commerce-evidence/06-venta-vacia-390.png) · [carrito](commerce-evidence/07-venta-carrito-1440.png) ([768](commerce-evidence/07-venta-carrito-768.png), [390](commerce-evidence/07-venta-carrito-390.png)) · [revisar](commerce-evidence/08-venta-revisar-1440.png) · [registrada](commerce-evidence/09-venta-registrada-1440.png) | | 19–21 | [Plan (comercio)](commerce-evidence/19-cuotas-plan-comercio-1440.png) · [cuota vencida](commerce-evidence/20-cuotas-cuota-vencida-1440.png) · [consulta comprador](commerce-evidence/21-cuotas-consulta-comprador-390.png) |
| 10 | [Terminal lista para cobrar](commerce-evidence/10-terminal-lista-1440.png) · [390](commerce-evidence/10-terminal-lista-390.png) | | 22 | [Caja](commerce-evidence/22-caja-1440.png) · [768](commerce-evidence/22-caja-768.png) |
| 11–12 | [Checkout con resumen](commerce-evidence/11-checkout-resumen-390.png) · [comprobante](commerce-evidence/12-checkout-comprobante-390.png) | | 23–25 | [Cliente](commerce-evidence/23-cliente-ficha-1440.png) · [Equipo](commerce-evidence/24-equipo-1440.png) · [Configuración](commerce-evidence/25-configuracion-1440.png) |
| 13 | [Terminal aprobado](commerce-evidence/13-terminal-aprobado-1440.png) | | 26 | [Inicio con actividad](commerce-evidence/26-inicio-con-actividad-1440.png) |
| 14 | [Venta cobrada](commerce-evidence/14-venta-detalle-cobrada-1440.png) · [768](commerce-evidence/14-venta-detalle-cobrada-768.png) | | 27–28 | [Rol sin permiso](commerce-evidence/27-rol-sin-permiso-1440.png) · [Sesión caducada](commerce-evidence/28-sesion-caducada-390.png) |

## 8. Ejecutar esta versión sin tocar la demo en marcha

### Instancias de demo

Los scripts de `scripts/demo/` trabajan por **instancia**. Una instancia es un prefijo (`DEMO_PREFIX`) más el checkout desde el que se ejecutan (o `DEMO_ROOT`). Todo deriva del prefijo:

| Recurso | Por defecto (= la demo actual) | Segunda instancia (`DEMO_PREFIX=fluvia-demo2`) |
| --- | --- | --- |
| Contenedores | `fluvia-demo-pg`, `fluvia-demo-redis` | `fluvia-demo2-pg`, `fluvia-demo2-redis` (con etiquetas `fluvia.demo.prefix` y `fluvia.demo.root`) |
| Volumen | `fluvia-demo-pgdata` | `fluvia-demo2-pgdata` (con etiquetas) |
| Puertos API · checkout · dashboard | 3300 · 3301 · 3302 | `DEMO_PORT_BASE=3310` → 3310 · 3311 · 3312 |
| Puertos PG · Redis | 55432 · 56379 | `DEMO_PG_PORT=55433` · `DEMO_REDIS_PORT=56380` |
| Orígenes (`FLUVIA_DASHBOARD_ORIGIN`, `CHECKOUT_BASE_URL`) | `http://127.0.0.1:3302` · `:3301` | se derivan de los puertos; también `DEMO_DASHBOARD_ORIGIN` / `DEMO_CHECKOUT_ORIGIN` |
| PID y logs | `<checkout>/.demo/{api,checkout,dashboard}.{pid,log}` | `<checkout>/.demo-fluvia-demo2/…` y el marcador `instance` |

Los valores por defecto son exactamente los de la demo actual, así que el script nuevo no rompe la demo que ya está en marcha. `DEMO_PRINT_CONFIG=1 scripts/demo/start-local-demo.sh` muestra la configuración resuelta sin arrancar nada.

**Arranque.** No arranca nada si se da cualquiera de estos casos:

- la instancia ya está en marcha;
- un puerto está ocupado;
- un contenedor o volumen con su nombre pertenece a otra instancia;
- una instancia que no es la de por defecto pide los puertos de la demo por defecto;
- un contenedor reutilizado publica otro puerto distinto del pedido.

**Parada (`stop-local-demo.sh`).** Antes de actuar comprueba todo lo siguiente:

- el marcador de estado es de ese prefijo y de ese checkout;
- cada PID leído del directorio de estado de **esa** instancia corre en `<checkout>/apps/<servicio>`;
- los contenedores y el volumen llevan su prefijo y sus etiquetas.

Los recursos sin etiquetas, creados por la versión anterior del script, solo se aceptan con el prefijo por defecto **y** si ese checkout tiene su propio `.demo/`. Si algo no coincide, sale con código 3 **sin tocar nada**. Para los procesos y hace `docker stop`. **Conserva contenedores y volumen.**

**Borrado de datos (`purge-local-demo.sh --yes-delete-data`).** Es un paso aparte y explícito. Exige que la instancia esté parada y que se cumplan las mismas comprobaciones de pertenencia. Elimina los contenedores y el volumen; conserva el checkout, el marcador y los logs.

> ⚠️ El `stop-local-demo.sh` de la versión anterior, el del checkout actual `~/fluvia-demo/repo` (commit `2475f42`), **borra el volumen** (`docker volume rm fluvia-demo-pgdata`). No lo uses si quieres conservar los datos de la demo actual: para pararla, usa el comando de «Cambio» de abajo.

### Comandos

**1. Segunda instancia**, en un directorio nuevo y sin tocar `~/fluvia-demo/repo`:

```bash
mkdir -p ~/fluvia-demo2
git clone https://github.com/celestinojbm/Fluvia ~/fluvia-demo2/repo
cd ~/fluvia-demo2/repo && git switch claude/plataforma-comercio-cuotas
# (opcional) comprobar la configuración sin arrancar nada:
DEMO_PREFIX=fluvia-demo2 DEMO_PORT_BASE=3310 DEMO_PG_PORT=55433 DEMO_REDIS_PORT=56380 \
  DEMO_PRINT_CONFIG=1 scripts/demo/start-local-demo.sh
# arrancar:
DEMO_PREFIX=fluvia-demo2 DEMO_PORT_BASE=3310 DEMO_PG_PORT=55433 DEMO_REDIS_PORT=56380 \
  scripts/demo/start-local-demo.sh
# abrir en ESA máquina: http://127.0.0.1:3312/login  (owner@demo.fluvia.test / demo-owner-password)
```

La demo actual sigue en 3300–3302, con su checkout, contenedores, volumen y procesos intactos.

**2. Cambio de aplicación.** La versión nueva queda como la demo activa en 3312. La anterior se para **conservando sus datos** y sin modificar su checkout; solo se borran sus archivos PID en `.demo/`:

```bash
cd ~/fluvia-demo2/repo
DEMO_ROOT=~/fluvia-demo/repo scripts/demo/stop-local-demo.sh
```

**3. Rollback.** Volver a la demo anterior con sus datos:

```bash
cd ~/fluvia-demo2/repo && DEMO_PREFIX=fluvia-demo2 scripts/demo/stop-local-demo.sh   # conserva los datos de la nueva
cd ~/fluvia-demo/repo && scripts/demo/start-local-demo.sh                            # su script ORIGINAL; reutiliza fluvia-demo-pg y su volumen
```

El script original reinstala, migra, siembra (idempotente) y compila: tarda lo mismo que el primer arranque. Además, su `next build` modifica `next-env.d.ts` y `tsconfig.json` en ese checkout, como ya ocurría antes.

**4. Borrar los datos de la segunda instancia.** Es opcional y va siempre aparte:

```bash
cd ~/fluvia-demo2/repo
DEMO_PREFIX=fluvia-demo2 scripts/demo/stop-local-demo.sh
DEMO_PREFIX=fluvia-demo2 scripts/demo/purge-local-demo.sh --yes-delete-data
```

### Prueba de la parametrización (entorno cloud, Docker real)

La simulación reprodujo la disposición de la máquina del propietario:

- **A** = `…/fluvia-demo/repo` en el commit base `2475f42`, arrancada con su **script antiguo**, con una fila marcadora `MARCADOR-A` en su BD.
- **B** = `…/fluvia-demo2/repo` con esta versión y `DEMO_PREFIX=fluvia-demo2`.

| Prueba | Resultado |
| --- | --- |
| B con el prefijo nuevo y puertos por defecto | Rechazado (exit 1) |
| Prefijo por defecto desde B: arrancar · parar · borrar con el flag | Rechazados (contenedor ajeno · exit 3 · exit 3); A intacta |
| Parar una instancia inexistente · borrar sin `--yes-delete-data` | Rechazados |
| A y B a la vez (3300–3302 y 3310–3312) | Ambas responden 200; E2E de la plataforma contra B 10/10 |
| Arrancar B otra vez estando en marcha | Rechazado |
| PID falsificado (el estado de B apunta al API de A) · marcador de otro checkout | Exit 3, nada tocado; A y B siguen en marcha |
| Parar B | Procesos parados sin huérfanos; contenedores `Exited`; volumen conservado; A intacta |
| Parar y volver a arrancar B | `MARCADOR-B` conservado |
| Borrar B en marcha · B parada con el flag | Rechazado · contenedores y volumen de B eliminados; A intacta |
| Borrar y volver a arrancar B | Arranca con datos nuevos |
| **Cambio**: parar A desde B con `DEMO_ROOT` | A parada; volumen, contenedores y checkout conservados (mismos archivos modificados antes y después) |
| **Rollback**: parar B y arrancar A con su script original | A en 3300–3302 con `MARCADOR-A` intacto |

**Dos fallos encontrados y corregidos durante esta prueba**, antes de publicar el cambio:

- `purge` con el prefijo por defecto, ejecutado desde un checkout sin estado propio, aceptaba los contenedores sin etiquetas y borró el volumen de A en la simulación. Ahora, para tratar un recurso sin etiquetas como propio, exige el estado `.demo/` del propio checkout.
- `purge` borraba el marcador y el siguiente arranque se rechazaba.

No se verificó en la MSI (sin acceso). En Linux/WSL el directorio de trabajo de cada PID se lee de `/proc`; en macOS, con `lsof`. Todo escucha solo en 127.0.0.1, sin túneles ni Funnel ni coste. La segunda instancia **no se ha arrancado** en la máquina del propietario.

Recorrido sugerido: Inicio → Nueva venta → elegir productos y cantidades → Cliente nuevo → Revisar → Confirmar → **Cobrar ahora** → Abrir checkout del cliente → en la pestaña del comprador: pagar con la tarjeta aprobada, o abrir «Pagar en cuotas», elegir cuotas y escenario, aceptar y confirmar → volver a Ventas / Cuotas / Caja.

Pruebas:

```bash
pnpm install && NODE_ENV=test pnpm migrate               # PG 16 local (ver README)
NODE_ENV=test pnpm --filter @fluvia/commerce test          # dominio contra PG real
NODE_ENV=test pnpm --filter @fluvia/api test               # HTTP (incluye commerce-routes; Redis local)
pnpm --filter @fluvia/dashboard test && pnpm --filter @fluvia/checkout test
# Stack real (local): demo arrancada y luego
cd apps/dashboard && DEMO_APP_URL=http://127.0.0.1:3312 \
  npx playwright test -c e2e/real-stack/playwright.config.ts commerce journey
```

## 9. Terminado, incompleto y decisiones pendientes

**Terminado (sandbox):** estructura común y sistema visual; Inicio con indicadores honestos; catálogo con versión; nueva venta con total en servidor e idempotencia; integración con el terminal y el checkout existentes; ventas con búsqueda/estado/paginación; clientes; caja operativa; equipo (lectura); configuración; «Pagar en cuotas» de punta a punta con proveedor simulado; demo local parametrizable por instancia (`DEMO_PREFIX`, parada que conserva datos y borrado explícito aparte).

**Incompleto (declarado en pantalla):**

1. **Existencias**: solo disponibilidad declarada; no hay inventario (reservar/descontar/liberar). Se decidió no simular stock en el navegador.
2. **Método de pago por cobro**: la API no lo registra; Caja agrupa por canal.
3. **Cancelar una venta** pendiente: no se ofrece. Un checkout abierto sigue siendo pagable hasta expirar y no existe «cancelar cobro» por sesión; cancelar el pedido sin cerrar sus checkouts sería engañoso.
4. **Equipo**: sin invitaciones ni cambio de rol (no hay contrato de API).
5. **Arqueo / cierre de caja / turnos / efectivo**: no existen; Caja es un resumen, no un cierre contable.
6. **Impuestos y numeración fiscal**: no hay (PEND-007). El comprobante del comprador y el justificante dicen que no son factura.
7. **Idioma**: las pantallas nuevas están en español; `?lang=en` aplica a las pantallas previas y al checkout.
8. **Periodo de indicadores** por fecha de creación del cobro (UTC), no por fecha de confirmación.
9. **Listas**: clientes hasta 100 por búsqueda; planes de cuotas, los últimos 50.

**Decisiones del propietario (sin tocar):** PEND-002 (pricing), PEND-006 (sandbox compartido), **PEND-007** (mercado: Colombia ↔ Venezuela; moneda, impuestos, medios locales), **PEND-008** (exponente de COP), y las de financiación real de §6.

**Roadmap (fuera de alcance por decisión):** mesas, cocina, delivery y demás funciones de restaurante; inventario; programas de fidelidad; múltiples sucursales/cajas; facturación fiscal; financiación real.
