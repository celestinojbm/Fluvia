# Personal móvil y Tiendas — inventario y decisiones

Rama `claude/personal-movil-tiendas`, apilada sobre `claude/restaurantes-cobro-presencial` (#69, HEAD `1f7c7f8`).
Evolución, no reconstrucción: se reutilizan dominio, autenticación, API, ledger y pruebas.

## Inventario (lo que ya existía y se reutiliza)

| Pieza | Dónde | Uso en esta jornada |
|---|---|---|
| Sesión del cliente (cookie `fluvia_personal`, BFF con lista cerrada y CSRF) | `apps/dashboard/app/api/personal`, `personal/lib/server.ts` | Mismo plano para Tiendas, carrito y pedidos |
| Wallet, garantía, crédito, tarjetas, cuotas, compras | `/v1/personal/*`, `@fluvia/personal` | Sin cambios de reglas; se reorganiza la navegación |
| Código de pago `fcp_` + red Fluvia simulada (`FluviaRoutingProvider`) | `payment-codes`, `apps/api/src/app.ts` | Pago dentro de la app: código de un solo uso + checkout existente |
| Pedido con precio en servidor, reserva de existencias y enlace de cobro único | `OrderService.createIn` (0049–0051) | Pedido de tienda = pedido del comercio, sin lógica nueva de cobro |
| Checkout alojado (`createSessionFromLink`, `confirmByClientSecret`) | `@fluvia/payments-core` | Pago integrado y pago con otra tarjeta (checkout alojado) |
| Estado de pago DERIVADO de los intents | `deriveOrderPayment` | Seguimiento: nada se marca pagado por volver del checkout |
| Directorio público (perfil publicado explícitamente, funciones SECURITY DEFINER) | 0054 | Identidad pública de la tienda |
| Imágenes CC0 verificadas en origen | `demo-images.ts`, `presentation-images.ts` | Misma vía (Openverse → página de Flickr) para fotos nuevas |
| Asistente (superficie `personal`, herramientas tipadas) | `@fluvia/assistant`, `@fluvia/assistant-ui` | Se añaden herramientas de Tiendas; sin infraestructura nueva |
| Instancias aisladas (`scripts/demo/*`) | #69 | Instancia propia para Hermes |

## Decisiones

1. **Un pedido por comercio y moneda.** El catálogo tiene moneda por producto y un pedido exige una sola: el
   carrito se agrupa por tienda y moneda. No hay cobro multicomercio (sin soporte contable ni contractual).
2. **El pedido vive en el comercio.** Se crea con `OrderService.createIn` en el tenant del comercio, en la misma
   transacción que un registro de solicitud con clave de idempotencia (reintento = mismo pedido). El cliente solo
   ve sus pedidos por ese registro.
3. **Visibilidad explícita.** El comercio activa su tienda y elige producto a producto qué se publica. La lectura
   pública cruza tenants solo por funciones SECURITY DEFINER que devuelven columnas públicas: sin costos, sin
   cantidades de inventario (solo «disponible/agotado»), sin clientes ni ids de tenant.
4. **Pago.** «Pagar con Fluvia» genera un código de un solo uso por el total y confirma un checkout del enlace de
   la venta en el servidor; «Otra tarjeta» abre el checkout alojado. En ambos casos el estado se lee de la fuente
   canónica (intents del enlace): aprobado, rechazado, en confirmación (incierto) o pendiente.
5. **Reservas.** Se liberan al anular (cliente o comercio) con `OrderService.cancel`, nunca por el navegador. Un
   cobro incierto deja la reserva intacta (regla existente).
6. **Tiendas conectadas y externas.** Adaptadores con pruebas de contrato y estado «no conectado» mientras falten
   credenciales del comercio. Externas (Amazon): solo vía oficial documentada; nada de scraping ni WebView.

## Identidad visual (decisiones breves)

- Menta `#B2FCE4` = identidad (lienzo, cabeceras); lima `#DFFE1C` = énfasis escaso (acción destacada,
  selección), siempre con texto negro; negro = contraste y acción principal del dinero; blanco = superficies de
  lectura y compra. Sin modo oscuro impuesto; franja sandbox negra arriba.
- Manrope (integración existente). Cuerpo 16 px; cifras tabulares; importe protagonista con moneda explícita.
- Escala de espaciado 4/8/12/16/24/32/48; márgenes móviles 16–20 px; controles ≥ 44 px; radios 14/20/28.
- Navegación móvil de cinco destinos: Inicio · Tiendas · Pagar · Actividad · Cuenta.
- Referencias IMG_6047–6057: **no estaban adjuntas** en el mensaje recibido; se aplicaron las especificaciones
  escritas por imagen, sin afirmar haberlas visto.
