# Jornada: bolívares, diseño de producto y operación comercial

Estado: **sandbox, draft PR apilado sobre `claude/plataforma-comercio-cuotas` (PR #64 intacto), sin merge ni despliegue.** Datos sintéticos; MockProvider y proveedor de cuotas simulado. Fluvia no es banco, adquirente, procesador ni financiador.

Documentos de esta jornada:

- [`bolivares.md`](bolivares.md): VES verificado en fuente oficial, cobertura y límites.
- [`../design/fluvia-visual-direction.md`](../design/fluvia-visual-direction.md): dirección visual «Corriente», registrada **antes** de implementar.
- [`demo-images.md`](demo-images.md): fotos de producto CC0 con origen, autor, licencia y verificación.
- Evidencias: [`redesign-evidence/`](redesign-evidence/) (`before/`, `after/`, `compare/`).

## 1. Qué cambió

| Área             | Antes                                                        | Ahora                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moneda           | COP, USD y otras; sin VES                                    | **VES** (ISO 4217 928, 2 decimales) en dominio, catálogo, venta, cobro, checkout, devoluciones, justificante, panel, caja y cuotas. Formato exacto (sin coma flotante) con «Bs.» y código ISO cuando el símbolo es ambiguo |
| Identidad visual | Panel genérico: cuadrícula de tarjetas iguales, grises fríos | «Corriente»: verde río + arena + sol; cifra protagonista, franja de métricas, listas ricas, mostrador con fotos, checkout de marca                                                                                         |
| Catálogo         | Nombre, SKU, categoría, precio, disponible                   | + **fotos** (conjunto CC0 cerrado), **variantes** de un nivel, **existencias** con reservas y movimientos                                                                                                                  |
| Venta            | Carrito, cliente, idempotencia                               | + búsqueda por SKU con Enter, opciones por variante, tope por existencias libres, **anulación** de venta sin cobro, búsqueda de ventas por producto/SKU                                                                    |
| Panel            | 6 tarjetas de indicadores, periodo                           | Periodo **y moneda**, cobrado protagonista, **evolución diaria**, **más vendidos**, **saldo del ledger**, alertas (existencias bajas, cobros sin confirmar, devoluciones abiertas)                                         |
| Clientes         | Lista y ficha                                                | + métricas por moneda (sin sumar monedas), acceso al justificante                                                                                                                                                          |

## 2. Existencias: reglas (decisión de producto aplicada)

Definidas en el motor (migración `0051`) y probadas contra PostgreSQL real:

| Evento                                                      | Efecto                                                                                                                                     | Dónde se hace cumplir                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registrar una venta con productos que controlan existencias | **Reserva** (existencia igual, reservado +n). Sin libre suficiente ⇒ 422 `insufficient_stock` y no se crea nada (ni venta ni link)         | Servicio (lock consultivo por producto) + `CHECK reserved ≤ on_hand` del motor                                                                            |
| Cobro llega a `succeeded` (API, webhook o watchdog)         | **Descuento**: existencia −n, reservado −n                                                                                                 | Trigger `AFTER UPDATE` en `payment_intents` (cualquier camino). Nunca bloquea el registro del pago: un fallo imposible se anota en `inventory_exceptions` |
| Cobro **rechazado**                                         | La reserva **se mantiene**: la venta sigue abierta y se puede reintentar                                                                   | —                                                                                                                                                         |
| Resultado **incierto** (processing, timeout)                | La reserva **se mantiene** y la venta **no** se puede anular                                                                               | Guarda de anulación                                                                                                                                       |
| **Anular** la venta                                         | Libera la reserva, desactiva el link; ningún checkout abierto de esa venta puede cobrar (409 `order_cancelled`) ni crear un plan de cuotas | `commerce_order_cancellations` con trigger que toma **el mismo lock del link** que `beginIn`: anular y empezar a cobrar se linealizan (carrera probada)   |
| Devolución                                                  | **No** repone existencias automáticamente (el producto puede no volver). El comercio registra una entrada/ajuste con motivo                | Decisión documentada; prueba `una devolución NO repone existencias`                                                                                       |
| Entrada / ajuste                                            | ± existencia con motivo; nunca por debajo de lo reservado (409 `inventory_conflict`)                                                       | Idempotente por `Idempotency-Key`; auditado                                                                                                               |

Los niveles los escribe **solo el motor** (`REVOKE` explícito frente a los `DEFAULT PRIVILEGES` de la app; prueba de que `UPDATE inventory_levels` como app da `permission denied`). El navegador no descuenta nada: el tope de cantidad del ticket es una ayuda con el último catálogo leído.

## 3. Mapa pantalla → funcionalidad → API → prueba → estado

Estado: **Sandbox** = implementado y verificado contra el stack real · **Incompleto** = funciona con hueco declarado.

| Pantalla          | Funcionalidad                                                                                                                                                                                                                                                                       | API                                                                                                     | Prueba                                                                                                                    | Estado                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Panel (Inicio)    | Periodo (Hoy/7/30 días) y moneda; cobrado protagonista; evolución diaria registrado/cobrado con tabla accesible; saldo del ledger por moneda; franja (registradas, sin confirmar, devoluciones, pendientes/anuladas); más vendidos; actividad; alertas; definiciones en desplegable | `…/commerce/summary`, `…/commerce/insights`, `…/orders`, `…/catalog/products`                           | `inventory.test.ts` (indicadores; serie en varios días), `ves.test.ts` (por moneda), `commerce-ui.test.tsx`, E2E 1, 9, 11 | Sandbox                                                        |
| Catálogo          | Lista rica con foto, variantes agrupadas, SKU, categoría, existencias; filtros (estado, existencias bajas, categoría); búsqueda por nombre/SKU/variante                                                                                                                             | `GET …/catalog/products?low_stock=`                                                                     | `inventory.test.ts`, E2E 3, 13                                                                                            | Sandbox                                                        |
| Ficha de producto | Galería CC0; variante; control de existencias; entrada/ajuste idempotente; movimientos; vista previa                                                                                                                                                                                | `…/catalog/images`, `PATCH …/products/:id`, `POST …/products/:id/stock`, `GET …/products/:id/movements` | `commerce-routes.test.ts` («existencias…»), E2E 11, 13                                                                    | Sandbox                                                        |
| Nueva venta (POS) | Fotos, variantes como opciones, agotado deshabilitado, tope por libre, SKU + Enter, moneda única, cliente opcional, revisión, registro idempotente, 422 sin existencias ⇒ relee                                                                                                     | `POST …/orders`                                                                                         | `sell-workspace.test.tsx` (10), `inventory.test.ts`, E2E 4, 11                                                            | Sandbox                                                        |
| Terminal          | Cobro de la venta (flujo existente), con la identidad nueva                                                                                                                                                                                                                         | existentes                                                                                              | E2E 5–7b, journey 7/7, receipt CI 31/31                                                                                   | Sandbox                                                        |
| Ventas            | Búsqueda por número, cliente, nota, **producto o SKU**; estado incl. «Anulada»; ficha con variante, existencias de la venta, historial, **Anular venta**                                                                                                                            | `…/orders`, `POST …/orders/:id/cancel`                                                                  | `inventory.test.ts` (anulación, carreras), `commerce-routes.test.ts`, E2E 12                                              | Sandbox                                                        |
| Clientes          | Búsqueda, ficha con compras, cobrado neto por moneda, justificante                                                                                                                                                                                                                  | `…/customers`                                                                                           | `commerce-routes.test.ts`, E2E 9                                                                                          | Sandbox (hasta 100 por búsqueda)                               |
| Checkout          | Comercio en cabecera, importe con código, estado con icono, métodos como tarjetas, resumen con variante, comprobante; venta anulada ⇒ sin pago                                                                                                                                      | `/v1/checkout_sessions/:id/{status,confirm,order}`                                                      | `checkout-installments.test.tsx` (30), E2E 5, 11, 12                                                                      | Sandbox                                                        |
| Justificante      | Misma jerarquía y paleta; VES                                                                                                                                                                                                                                                       | existente                                                                                               | receipt CI 31/31, E2E 5                                                                                                   | Sandbox                                                        |
| Caja              | Sin cambios funcionales; estilos nuevos                                                                                                                                                                                                                                             | `…/commerce/cash`                                                                                       | E2E 9                                                                                                                     | Incompleto (como antes: sin arqueo/turnos ni método por cobro) |
| Estados           | Carga (esqueleto), vacío, error de conexión, sin acceso, sesión caducada                                                                                                                                                                                                            | —                                                                                                       | `commerce-ui.test.tsx`, E2E 10, captura 46                                                                                | Sandbox (ver límite de carga en §6)                            |

Pruebas añadidas o ampliadas en la jornada: `packages/money` (VES), `packages/commerce/test/{ves,inventory}.test.ts` (6 + 16), `apps/api/test/commerce-routes.test.ts` (+2), `packages/seeds` (+1), `apps/dashboard/test/{money-format,demo-images,commerce-ui,sell-workspace}.test.*`, `apps/checkout/test/checkout-installments.test.tsx` (+3), E2E del stack real (+3 escenarios: 11, 12, 13).

## 4. Verificación

| Nivel                                                  | Resultado (entorno cloud, PG 16 + Redis reales)                                                                                                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suite completa `pnpm test` (todos los paquetes y apps) | verde (ver CI del HEAD en el PR)                                                                                                                                                                                        |
| E2E stack real: plataforma (14) + recorrido POS (7)    | **21/21** en BD limpia, y de nuevo tras el build final                                                                                                                                                                  |
| E2E de CI (justificante, API sintética)                | **31/31**                                                                                                                                                                                                               |
| Responsive                                             | Sin scroll horizontal ni tablas recortadas a 390/768/1440 en todas las pantallas capturadas (la E2E lo comprueba y detectó dos regresiones durante la jornada, corregidas: tabla de líneas a 390 y tabla de Caja a 768) |
| Teclado                                                | Saltar al contenido, cajón móvil con Enter/Escape, SKU + Enter en el mostrador, foco en el motivo al anular, cantidades con botones accesibles                                                                          |
| Accesibilidad automática                               | axe sin violaciones en mostrador, checkout (incl. venta anulada) y estado de carga                                                                                                                                      |

## 5. Evidencias

- **Antes/después** ([`compare/`](redesign-evidence/compare/)): panel ([1440](redesign-evidence/compare/panel-1440.png), [en bolívares](redesign-evidence/compare/panel-bolivares-1440.png), [390](redesign-evidence/compare/panel-390.png)), catálogo ([1440](redesign-evidence/compare/catalogo-1440.png), [390](redesign-evidence/compare/catalogo-390.png)), POS ([1440](redesign-evidence/compare/pos-1440.png), [en bolívares](redesign-evidence/compare/pos-bolivares-1440.png), [390](redesign-evidence/compare/pos-390.png)), checkout ([390](redesign-evidence/compare/checkout-390.png), [en bolívares](redesign-evidence/compare/checkout-bolivares-390.png)).
- **Después** ([`after/`](redesign-evidence/after/)): capturas saneadas (ids → `••••1234`, URLs fuera) generadas por la E2E del stack real a 390 y 1440 (768 en las pantallas clave). Nuevas: 29–39 (bolívares, existencias, anulación, variantes), 40–47 (evolución, búsqueda por producto, clientes, sin coincidencias, error de conexión, existencias bajas).
- **Datos de las capturas**: sintéticos. Las ventas de días anteriores de 40/41 se crearon por la **API real** (pedido → checkout → MockProvider) y después, **solo en la BD local de evidencias**, se retrofechó su `created_at` como superusuario para tener historia que mostrar. La lógica de la serie está probada aparte (`inventory.test.ts`, «serie de varios días»). Las «Galletas demo …» y las variantes «1 kg XXXXX» son restos de corridas repetidas de la E2E.
- Las PNG están cuantizadas a 256 colores para no inflar el repositorio.

## 6. Límites y decisiones pendientes

- **Imágenes**: conjunto cerrado de 10 fotos CC0; no hay subida (requiere almacenamiento y revisar la CSP). Arroz, harina, aceite, detergente y jabón muestran un marcador diseñado.
- **Variantes**: un nivel; la base es también vendible; sin atributos estructurados (talla/color como ejes).
- **Existencias**: sin almacenes múltiples, lotes, caducidad ni reposición automática por devolución; las existencias solo cuentan para ventas registradas mientras el producto las controla.
- **Anulación**: solo ventas sin cobro en curso/hecho y sin plan de cuotas vivo; no hay «anular cobro» ni nota de crédito.
- **Periodos en UTC** (declarado en pantalla). Un comercio en Caracas (UTC−4) ve «Hoy» desplazado 4 h. Decisión pendiente: zona horaria por comercio.
- **Estado de carga**: el esqueleto aparece cuando la sesión responde y la lectura de la página tarda; si la propia API no responde, el layout (que valida la sesión) espera y luego muestra «No pudimos conectar con Fluvia». Verificado por prueba de componente y captura 46; no hay captura del esqueleto en el stack real.
- **Saldo**: el panel muestra las cuentas del comercio en el ledger del sandbox (pendiente/disponible/reserva). Ningún camino de producto libera fondos: «disponible» solo cambia por operaciones sandbox explícitas.
- **Sin cambios** en: conversiones, tasas, redenominación, impuestos (IVA/IGTF), exponente COP (PEND-008), restaurantes, nómina, financiación real, contabilidad fiscal. PEND-007 (mercado) sigue abierta.
- **Proveedor real**: el MockProvider no restringe moneda; antes de uno real hay que confirmar si opera en VES (ver `bolivares.md`).

## 7. Abrir esta versión en una instancia independiente

Las dos demos actuales del propietario (**3300–3302**, prefijo por defecto, y **3310–3312**, `fluvia-demo2`) **no se tocan**: esta versión va en una tercera instancia con su propio checkout, contenedores, volumen, puertos y estado. Nada de lo siguiente se ha ejecutado en la máquina del propietario.

| Recurso            | Instancia nueva (`DEMO_PREFIX=fluvia-demo3`)                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Checkout           | `~/fluvia-demo3/repo`, rama `claude/jornada-bolivares-diseno`                                                                 |
| Contenedores       | `fluvia-demo3-pg` (postgres:16), `fluvia-demo3-redis` (redis:7), con etiquetas de instancia                                   |
| Volumen            | `fluvia-demo3-pgdata` (BD propia: la migración 0051 y el seed solo se aplican aquí)                                           |
| Puertos            | API **3320** · checkout **3321** · dashboard **3322** · PG **55434** · Redis **56381** (solo 127.0.0.1)                       |
| Estado, PID y logs | `~/fluvia-demo3/repo/.demo-fluvia-demo3/`                                                                                     |
| Recursos estimados | ~1,5 GB de disco (dependencias + builds + imágenes Docker ya descargadas) y ~1–1,5 GB de RAM (PG, Redis y tres procesos Node) |

Configuración resuelta comprobada en el entorno cloud (`DEMO_PRINT_CONFIG=1`): `API 3320 · checkout 3321 · dashboard 3322 · PG 55434 · Redis 56381`.

```bash
# 1. Checkout propio (no toca ~/fluvia-demo/repo ni ~/fluvia-demo2/repo)
mkdir -p ~/fluvia-demo3
git clone https://github.com/celestinojbm/Fluvia ~/fluvia-demo3/repo
cd ~/fluvia-demo3/repo && git switch claude/jornada-bolivares-diseno

# 2. Comprobar la configuración SIN arrancar nada
DEMO_PREFIX=fluvia-demo3 DEMO_PORT_BASE=3320 DEMO_PG_PORT=55434 DEMO_REDIS_PORT=56381 \
  DEMO_PRINT_CONFIG=1 scripts/demo/start-local-demo.sh

# 3. Arrancar (rechaza puertos ocupados o recursos de otra instancia)
DEMO_PREFIX=fluvia-demo3 DEMO_PORT_BASE=3320 DEMO_PG_PORT=55434 DEMO_REDIS_PORT=56381 \
  scripts/demo/start-local-demo.sh
# abrir: http://127.0.0.1:3322/login  (owner@demo.fluvia.test / demo-owner-password)
```

Recorrido sugerido: Inicio → moneda **VES** → Nueva venta → moneda VES → Café molido (250 g / 500 g) → escribir `VE-QUE-1K` y Enter → Revisar → Confirmar → Cobrar ahora → checkout (tarjeta aprobada) → Catálogo (existencias descontadas) → Ventas → otra venta → «Anular venta».

**Parar conservando datos** (PIDs y contenedores verificados como de esta instancia; el volumen se conserva):

```bash
cd ~/fluvia-demo3/repo && DEMO_PREFIX=fluvia-demo3 scripts/demo/stop-local-demo.sh
```

**Rollback**: basta con parar la instancia 3 (comando anterior). Las demos en 3302 y 3312 siguen funcionando con sus checkouts, contenedores, volúmenes y datos; no hay que cambiar nada en ellas. Si además se quiere eliminar la instancia 3:

```bash
cd ~/fluvia-demo3/repo
DEMO_PREFIX=fluvia-demo3 scripts/demo/stop-local-demo.sh
DEMO_PREFIX=fluvia-demo3 scripts/demo/purge-local-demo.sh --yes-delete-data   # borra SOLO contenedores y volumen de demo3
rm -rf ~/fluvia-demo3                                                          # opcional: el checkout
```

Precauciones: no ejecutar el `stop-local-demo.sh` antiguo del checkout de la primera demo (borra su volumen, ver `commerce-platform.md` §8); no usar `DEMO_ROOT` apuntando a otra instancia; todo escucha en 127.0.0.1, sin túneles.
