# Fluvia Personal móvil y Tiendas: entrega de la jornada

Sandbox: todo el dinero es simulado, las tiendas son sintéticas y no hay credenciales
externas.

Documentos de esta carpeta:

- Decisiones: [DECISIONES.md](DECISIONES.md).
- Tiendas conectadas y externas: [CONECTADAS.md](CONECTADAS.md).
- Fotos: [../demo-images.md](../demo-images.md).

> **Referencias visuales.** Las capturas IMG_6047–6057 no llegaron adjuntas. Se trabajó con
> la descripción escrita de cada una (importe y teclado, saldo y tarjeta, servicios,
> actividad por estado, perfil, QR, método de pago con total y CTA fijos). Si existen, conviene
> contrastarlas con la galería de abajo.

## Qué cambia

- **Navegación de cinco destinos:** Inicio · Tiendas · Pagar · Actividad · Cuenta.
  - En móvil es una barra inferior con «Pagar» central y área segura.
  - En escritorio es un carril superior.
  - Las pantallas anteriores (Movimientos, Tarjetas, Cuotas, Crédito, Perfil) siguen
    existiendo y se llega a ellas desde los módulos. No se retiró ninguna función.
- **Inicio:**
  - Saldo propio con ocultación por dispositivo.
  - **Garantía bloqueada y crédito disponible en celdas aparte, nunca sumados.**
  - Accesos Ingresar, Enviar, Pagar y Retirar.
  - Tarjeta, próxima cuota y crédito.
  - Compras en curso y destacados de Tiendas.
  - Sin promociones inventadas.
- **Tiendas Fluvia (operativo en sandbox):**
  - Buscador sin acentos, categorías, favoritas, tienda de la semana y destacados
    intercalados por tienda.
  - Página de tienda: identidad, entrega, devoluciones y contacto.
  - Ficha 4:5 con variantes; las agotadas no se pueden elegir.
  - Carrito persistente revalidado, con precio cambiado o agotado **antes** de pagar.
  - Revisión por tienda y moneda, pedido idempotente y pago con la tarjeta Fluvia (saldo),
    en cuotas (con oferta: inicial, calendario, interés y total) u otra tarjeta (checkout
    alojado).
  - Seguimiento con el pago y la entrega separados, anulación (libera la reserva) y
    solicitud de devolución.
- **Comercio, en `/o/:org/tienda`:**
  - Activar la tienda (exige el perfil del directorio publicado).
  - Entrega y políticas.
  - Publicar, destacar y agrupar productos (nada se publica por defecto).
  - Pedidos en línea: la preparación solo avanza si el pedido está cobrado.
- **Pagar:**
  - Importe protagonista con teclado y código QR de un solo uso con caducidad.
  - Escáner que pide la cámara solo tras un clic y confirma el destino.
  - Tap to Pay sigue aparte, en el panel del comercio (simulador).
- **Actividad:**
  - Grupos «Requiere tu atención», «Próximas cuotas» y «Completadas», esta última por mes.
  - Autorizados, inciertos y devoluciones en curso **nunca** aparecen como completados.
- **Cuenta:**
  - Perfil, seguridad, preferencias (ocultar importes) y conexiones con su estado real.
  - Sin menús sin destino.
- **Asistente:** cuatro herramientas de lectura en Tiendas: buscar productos, ver una
  tienda, mi carrito y mis pedidos.
  - **No** añade al carrito, no crea pedidos ni paga.
  - En móvil se abre como diálogo propio y no tapa la barra ni el CTA.
- **Tiendas conectadas:**
  - Adaptadores de lectura de Shopify (Storefront 2026-10) y WooCommerce (REST v3), con
    pruebas de contrato.
  - Estado `not_connected` sin credenciales.
  - Amazon queda solo documentado (Creators API, vía Associates).

## Pantalla → función → API → prueba → estado

| Pantalla                                   | Función                                                         | API                                                                         | Prueba                                                                        | Estado                                                        |
| ------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Inicio `/personal`                         | Saldo propio, garantía y crédito separados; módulos; compras    | `GET /v1/personal/overview`, `/shop/orders`, `/shop/cart`, `/shop/featured` | integral 1 · tiendas 5 · a11y                                                 | Hecho                                                         |
| Tiendas `/personal/tiendas`                | Buscar, categorías, favoritas, destacados                       | `GET /shop/stores`, `/shop/search`, `/shop/featured`                        | shops-routes «descubre…» · tiendas 1 · a11y                                   | Hecho                                                         |
| Tienda `/personal/tiendas/:slug`           | Identidad, entrega, políticas, catálogo por colección, favorito | `GET /shop/stores/:slug`, `POST /shop/favorites`                            | tiendas 2 · shops.test «favoritos…»                                           | Hecho                                                         |
| Producto `…/:slug/:id`                     | Fotos 4:5, variantes, precio, disponibilidad                    | `GET /shop/stores/:slug/products/:id`, `POST /shop/cart/items`              | tiendas 1 · shops.test «variantes»                                            | Hecho                                                         |
| Carrito `/personal/carrito`                | Por tienda y moneda; precio cambiado o agotado antes de pagar   | `GET /shop/cart`                                                            | tiendas 4 · shops.test «carrito revalidado», «quitar del carrito»             | Hecho                                                         |
| Revisión `/personal/carrito/:slug`         | Entrega o retiro, dirección, consentimiento, total del servidor | `POST /shop/orders` (Idempotency-Key, `expected_total`)                     | shops-routes «idempotente; precio cambiado ⇒ 409» · tiendas 3                 | Hecho                                                         |
| Pagar pedido `/personal/pedidos/:id/pagar` | Saldo, cuotas (oferta) u otra tarjeta                           | `POST /shop/orders/:id/pay`, `/checkout`                                    | shops-routes «compra completa…», «rechazado», «otra tarjeta…» · tiendas 3 y 4 | Hecho                                                         |
| Pedido `/personal/pedidos/:id`             | Pago y entrega separados, anular, devolución                    | `GET /shop/orders/:id`, `POST …/cancel`, `…/return`                         | tiendas 3, 5b y 6 · shops.test «anular…»                                      | Hecho                                                         |
| Pagar `/personal/pagar`                    | Código QR con máximo y caducidad; escáner                       | `POST /v1/personal/payment-codes` (existente)                               | tiendas 8 · integral 4 · a11y                                                 | Hecho                                                         |
| Actividad `/personal/actividad`            | Por estado y mes; filtros; detalle                              | lecturas existentes de Personal + `/shop/orders`                            | tiendas 5 · a11y                                                              | Hecho                                                         |
| Cuenta `/personal/cuenta`                  | Perfil, seguridad, preferencias, conexiones                     | `GET /v1/personal/me`                                                       | a11y                                                                          | Hecho; la lista de sesiones no existe en la API y se dice así |
| Comercio `/o/:org/tienda`                  | Ajustes, publicación, pedidos y preparación                     | `GET/PUT /v1/organizations/:org/shop/…`                                     | shops-routes «el comercio publica…» · tiendas 5b · a11y                       | Hecho                                                         |
| Asistente (Personal)                       | Buscar, tienda, carrito, pedidos; se niega a comprar            | `/v1/personal/assistant/*`                                                  | shops-routes «asistente en Tiendas» · contrato de proveedores                 | Hecho (proveedor simulado)                                    |
| Shopify / WooCommerce                      | Lectura del catálogo autorizado                                 | Adaptadores en `@fluvia/commerce`                                           | connected-shops.test (9)                                                      | Adaptador listo; **sin credenciales**                         |
| Amazon                                     | Ruta oficial documentada                                        | —                                                                           | —                                                                             | Solo documento                                                |

Datos de las pruebas:

- **E2E** `apps/dashboard/e2e/real-stack/tiendas-personal.spec.ts`: 9 pasos contra el
  stack real; en CI, en el job de E2E con `seed:tiendas`.
- **HTTP** `apps/api/test/shops-routes.test.ts` (9) y **servicio**
  `packages/commerce/test/shops.test.ts` (14), ambos con PostgreSQL real.
- **a11y** `design-a11y.spec.ts` «Personal · navegación de 5 destinos y Tiendas»:
  - axe WCAG 2.x A/AA sin hallazgos graves;
  - objetivos táctiles ≥ 44 px;
  - foco visible.

## Verificación hecha

- **Anchos 360, 390, 430, 768 y 1440:** sin desplazamiento horizontal. La E2E lo comprueba
  en cada captura.
  - Se encontró y corrigió un desborde a 1054 px: un `.sr-only` absoluto escapaba de un
    carril horizontal.
- **Texto al 200 %** en Inicio, Tiendas, tienda, Carrito, Pagar, Actividad y Cuenta:
  - sin desborde;
  - el final de la página no queda bajo la barra fija.
- **Movimiento reducido:** con `prefers-reduced-motion` no queda ninguna animación ni
  transición activa.
- **Enlaces profundos:** sin sesión, «Entrar» devuelve al destino pedido.
  - Destino validado: solo rutas internas de `/personal`; un `next` externo se ignora.
  - Hay prueba unitaria y paso E2E.
- **Sesión caducada:** pantalla propia, con vuelta al destino.
- **Lectores de pantalla:**
  - pestañas con `aria-selected` y `tabpanel`;
  - conmutadores (favorito, ocultar importes) con nombre fijo y `aria-pressed`;
  - 404 propio que no distingue «no existe» de «es de otra persona».
- **Regresiones**, todas en local:

  | Suite                                                                 | Resultado   |
  | --------------------------------------------------------------------- | ----------- |
  | `integral-real-stack` (wallet, crédito, cuotas, tarjeta, operaciones) | 12/12       |
  | `restaurante-cobro` (POS, restaurantes, KDS, presencial)              | 7/7         |
  | `design-a11y`                                                         | 6/6         |
  | `pnpm -r test`                                                        | 25 paquetes |

### Errores que la verificación destapó y se corrigieron

- El BFF de Personal enviaba JSON vacío y Fastify respondía 400 a «Ir al checkout» y
  «Anular pedido». Las pruebas HTTP no lo veían; la E2E sí.
- 0063 concedía DELETE a `fluvia_app` y rompía la invariante de la plataforma («ningún rol
  de runtime borra»). **No se añadió excepción.** La migración 0065 revoca el permiso y
  «quitar» pasa a ser una actualización: favorito `active=false`, línea `quantity=0`.
- La seed de tiendas tenía un literal `'+58…'` que el guard de parametrización SQL tomaba
  por concatenación. Ahora va por parámetro.

### Heredados (no de esta jornada)

- El historial con el problema de gitleaks del #69 queda aplazado por decisión del
  propietario; no se reescribió.
- `apps/worker/test/payouts-redriver.test.ts` puede fallar en una base de pruebas **local**
  reutilizada: el reclamo devuelve como máximo 20 pagos atascados de corridas anteriores. En
  CI la base es nueva y pasa.

## Antes y después

Las capturas son de la demo sintética «María Pérez (demo)». No hay datos personales reales.

| Comparativa                                                            | 390                                                   | 1440                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Inicio                                                                 | [c01-inicio-390](comparativas/c01-inicio-390.jpg)     | [c01-inicio-1440](comparativas/c01-inicio-1440.jpg)     |
| Billetera y tarjeta (misma pantalla `/tarjetas`; cambia la navegación) | [c02-390](comparativas/c02-wallet-tarjeta-390.jpg)    | [c02-1440](comparativas/c02-wallet-tarjeta-1440.jpg)    |
| Actividad (antes «Movimientos»)                                        | [c03-390](comparativas/c03-actividad-390.jpg)         | [c03-1440](comparativas/c03-actividad-1440.jpg)         |
| Navegación y Cuenta (antes «Perfil»)                                   | [c04-390](comparativas/c04-navegacion-cuenta-390.jpg) | [c04-1440](comparativas/c04-navegacion-cuenta-1440.jpg) |

## Galería saneada (`capturas/`)

**Simulado o sintético:** saldos, tarjetas, cuotas, tiendas, productos y pedidos.
**Real:** la interfaz, el flujo y los estados que devuelve la API, capturados de la E2E
contra el stack real.

|                                        | Móvil 390                                                                               | Escritorio 1440                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Tiendas                                | [01](capturas/01-tiendas-390.jpg)                                                       | [01](capturas/01-tiendas-1440.jpg)                 |
| Tienda                                 | [02](capturas/02-tienda-390.jpg)                                                        | [02](capturas/02-tienda-1440.jpg)                  |
| Producto con variantes                 | [03](capturas/03-producto-390.jpg)                                                      | [03](capturas/03-producto-1440.jpg)                |
| Carrito con precio cambiado            | [04](capturas/04-carrito-precio-cambiado-390.jpg)                                       | [04](capturas/04-carrito-precio-cambiado-1440.jpg) |
| Revisión                               | [05](capturas/05-revision-390.jpg)                                                      | [05](capturas/05-revision-1440.jpg)                |
| Método de pago                         | [06](capturas/06-pago-390.jpg)                                                          | [06](capturas/06-pago-1440.jpg)                    |
| Checkout alojado                       | [06b](capturas/06b-checkout-390.jpg)                                                    | [06b](capturas/06b-checkout-1440.jpg)              |
| Pedido pendiente (vuelta del checkout) | [07](capturas/07-pedido-pendiente-390.jpg)                                              | [07](capturas/07-pedido-pendiente-1440.jpg)        |
| Pedido pagado                          | [08](capturas/08-pedido-pagado-390.jpg)                                                 | [08](capturas/08-pedido-pagado-1440.jpg)           |
| Actividad                              | [09](capturas/09-actividad-390.jpg)                                                     | [09](capturas/09-actividad-1440.jpg)               |
| Inicio                                 | [10](capturas/10-inicio-390.jpg)                                                        | [10](capturas/10-inicio-1440.jpg)                  |
| Comercio: tienda en línea              | [11](capturas/11-comercio-tienda-390.jpg)                                               | [11](capturas/11-comercio-tienda-1440.jpg)         |
| Pagar con código                       | [12b](capturas/12b-pagar-codigo-390.jpg)                                                | [12b](capturas/12b-pagar-codigo-1440.jpg)          |
| Asistente sobre un producto            | [12](capturas/12-asistente-producto-390.jpg)                                            | —                                                  |
| Texto al 200 %                         | [13](capturas/13-texto-200-inicio-390.jpg) · [14](capturas/14-texto-200-tienda-390.jpg) | —                                                  |

## Procedimiento para Hermes (local, en la MSI)

La instancia es **independiente** (`fluvia-tiendas`): tiene sus propios contenedores, su
volumen y su estado. Necesita **otro checkout** (worktree) si ya hay otra instancia
sirviendo desde el mismo. Desde Cloud no se arrancó ni se tocó nada en la MSI.

1. Prepara un checkout propio de la rama:

   ```bash
   git fetch origin claude/personal-movil-tiendas
   git worktree add ../fluvia-tiendas origin/claude/personal-movil-tiendas
   cd ../fluvia-tiendas
   ```

2. Comprueba la configuración. Los puertos por defecto son API 3400, checkout 3401, panel
   3402, métricas 3403, PostgreSQL 55441 y Redis 56388:

   ```bash
   scripts/instancia-tiendas.sh config
   ```

   Si alguno está ocupado, cámbialos con `FLUVIA_TS_BASE`, `FLUVIA_TS_PG` y
   `FLUVIA_TS_REDIS`. El arranque aborta **antes de crear nada** si un puerto está ocupado.

3. Arranca con `scripts/instancia-tiendas.sh up`. Migra, siembra la demo y las tiendas
   (postcondiciones comprobadas), construye y arranca.
4. Abre las pantallas en el navegador de la MSI:
   - **Personal:** `http://127.0.0.1:3402/personal/entrar`, con
     `cliente@demo.fluvia.test` / `demo-cliente-password`.
     - Inicio `/personal`.
     - Tiendas `/personal/tiendas`.
     - Tienda `/personal/tiendas/casa-avila`.
     - Producto con talla agotada: en `/personal/tiendas/taller-caribe`, abre «Camisa de
       lino crudo».
     - Carrito `/personal/carrito`.
     - Pagar `/personal/pagar`.
     - Actividad `/personal/actividad`.
     - Cuenta `/personal/cuenta`.
   - **Comercio:** `http://127.0.0.1:3402/login`, con `tiendas@demo.fluvia.test` /
     `demo-tiendas-password`. Elige la organización y entra en «Tienda en línea».
   - **Operaciones y demo base:** `owner@demo.fluvia.test` / `demo-owner-password`.
5. Opcional, el recorrido automático (necesita Chromium de Playwright):

   ```bash
   DEMO_APP_URL=http://127.0.0.1:3402 \
   ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55441/fluvia \
   pnpm --filter @fluvia/dashboard exec playwright test \
     -c e2e/real-stack/playwright.config.ts tiendas-personal
   ```

6. Para y conserva los datos con `scripts/instancia-tiendas.sh down`. Para borrarlos, con
   la instancia parada: `scripts/instancia-tiendas.sh purge --yes-delete-data`.

Este procedimiento se verificó **en el contenedor de Cloud**, no en la MSI:

- `up`: código 0.
- E2E contra 3402: 9/9 en el contenedor.
- `down`: paró solo lo suyo; otra instancia en 3342 siguió respondiendo 200 y el volumen
  quedó conservado.

## Credenciales y acuerdos externos que faltan

Detalle en [CONECTADAS.md](CONECTADAS.md#credenciales-y-acuerdos-que-faltan).

| Para                      | Qué falta                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Shopify                   | Autorización de cada comerciante (app con OAuth o token privado de Storefront) y revisión de términos |
| WooCommerce               | URL HTTPS y claves REST de solo lectura de cada comerciante                                           |
| Amazon                    | Cuenta de Associates, acceso a la Creators API y aceptación del Operating Agreement                   |
| Credenciales por comercio | Cifrado por tenant y clave en el gestor de secretos (hoy solo variables de despliegue)                |
| Asistente con modelo real | Credenciales del proveedor; por defecto es simulado, como en jornadas anteriores                      |
| Tap to Pay real           | Proveedor certificado y dispositivo compatible; sigue el simulador                                    |

## Límites honestos

- Las monedas USD de Taller Caribe y Punto Digital solo se pagan con «Otra tarjeta»
  (checkout alojado), porque la tarjeta Fluvia de la demo es en VES. No se convierte moneda.
- Sesiones y dispositivos: la API no las lista y Cuenta lo dice así; no se inventó la
  pantalla.
- Las tiendas conectadas no tienen autorización por comercio. Hoy el panel solo explica
  qué hace falta.
