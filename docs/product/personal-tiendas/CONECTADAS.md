# Tiendas conectadas y externas

Estado verificado el 2026-10-03. Ninguna conexión está activa. No hay acuerdos con
Shopify, WooCommerce ni Amazon. Todas las tiendas de la demo son sintéticas.

## A. Tiendas Fluvia (operativo en sandbox)

El comercio publica productos de su propio catálogo desde `/o/:org/tienda`. Las reglas:

- nada se publica por defecto;
- la tienda solo se activa si el perfil del directorio está publicado;
- el cliente compra y paga dentro de Fluvia.

Las decisiones están en [DECISIONES.md](DECISIONES.md).

## B. Shopify y WooCommerce (adaptadores listos, sin credenciales)

El código está en `packages/commerce/src/connected-shops.ts`. Los contratos se prueban en
`packages/commerce/test/connected-shops.test.ts` (9 pruebas, contra servidores HTTP locales
que reproducen la forma documentada de cada API).

|                                | Shopify                                                                                                                           | WooCommerce                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| API                            | Storefront API GraphQL, versión fijada `2026-10`                                                                                  | REST API v3 (`/wp-json/wc/v3`)                                                                        |
| Endpoint                       | `POST https://{tienda}.myshopify.com/api/2026-10/graphql.json`                                                                    | `GET /products?status=publish&per_page&page`, `/products/{id}/variations`, `/data/currencies/current` |
| Autenticación                  | Token **privado** de servidor en `Shopify-Storefront-Private-Token`. Nunca se usa el público `X-Shopify-Storefront-Access-Token`. | Basic auth con consumer key y secret, **solo sobre HTTPS**; las claves nunca van en la URL.           |
| Cómo lo obtiene el comerciante | Canal Headless en su admin de Shopify, o una app personalizada                                                                    | Claves REST de **solo lectura** creadas en WooCommerce → Ajustes → Avanzado → REST API                |
| Paginación                     | Cursor (`pageInfo.endCursor`)                                                                                                     | Cabecera `X-WP-TotalPages`                                                                            |
| Moneda                         | `price.currencyCode` de cada variante                                                                                             | La de la tienda (`/data/currencies/current`)                                                          |

Las reglas implementadas:

- **Solo lectura.** La compra ocurre en el checkout de la tienda conectada. Fluvia no cobra
  en su nombre y nunca marca un pedido externo como pagado.
- **Sin credenciales, `not_connected`.** Con credenciales, el estado lo decide una sonda
  real: `connected` si responde con un catálogo válido, `error` si no. Tener las variables
  definidas no basta para declarar una conexión.
- **Precios en unidades menores, con la moneda de la tienda.** Un producto en una moneda que
  Fluvia no soporta se omite y se cuenta en `skipped`; nunca se convierte ni se redondea.
- **Precio «desde».** Es el de la variante disponible más barata. La variante implícita
  «Default Title» de Shopify no se muestra como opción.
- **Credenciales exclusivamente de servidor**, leídas del entorno del API:
  - `SHOPIFY_STORE_DOMAIN` y `SHOPIFY_STOREFRONT_PRIVATE_TOKEN`;
  - `WOOCOMMERCE_BASE_URL`, `WOOCOMMERCE_CONSUMER_KEY` y `WOOCOMMERCE_CONSUMER_SECRET`.
- **Sonda manual.** Con `pnpm --filter @fluvia/api run probe:connected-shops` se ve el
  estado y el número de productos de la primera página. No imprime secretos.

### Lo que falta para abrirlo a comercios reales (no hecho, a propósito)

1. **Autorización por comercio.** Hoy las variables son de despliegue, no por organización,
   y por eso el panel muestra «No conectadas» sin ofrecer conexión. Hace falta:
   - en Shopify, una app con instalación OAuth;
   - en WooCommerce, un alta de claves por comercio;
   - en ambos casos, almacenamiento **cifrado** por tenant (el mismo patrón que los
     secretos de webhooks).
2. **Sincronización.** Hace falta:
   - importar a una tabla de catálogo externo con fecha de lectura;
   - mostrar «precio leído a las HH:MM» y volver a leer antes de enviar al checkout;
   - nunca prometer existencias que no se hayan leído.
3. **Imágenes.** Se mostrarían con la URL de la CDN del comerciante y su permiso. No se
   copiarían.
4. **Revisión de términos de cada plataforma** antes del primer comercio real.

## C. Amazon y otros catálogos externos (solo documentación)

La ruta oficial es el **programa de afiliados (Amazon Associates)** con su API de catálogo:

- **PA-API 5.0 está retirada.** Amazon recomienda migrar a la **Creators API**. Las llamadas
  a PA-API 5 responden 403 `AccessDeniedException`. Fuente:
  [aviso oficial en Associates Central](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation).
- Fuentes de terceros informan del calendario y de un umbral de acceso: deprecación el
  30-04-2026, apagado el 15-05-2026, y unas 10 ventas cualificadas en 30 días. **Hay que
  verificarlo** en Associates Central antes de solicitar acceso.
- Requiere:
  - una cuenta de Associates aprobada para el país de la tienda;
  - aceptar su Operating Agreement (atribución de enlaces, reglas de visualización de
    precios y de caché);
  - credenciales de la Creators API, que también serían exclusivas de servidor.
- **Fuera de alcance, por norma:** scraping, WebView arbitrario dentro de la app, copiar
  precios, imágenes o disponibilidad, e insinuar una alianza con Amazon.
- En Personal, «Otras tiendas» lo dice tal cual: no hay ninguna conexión activa.

## Credenciales y acuerdos que faltan

| Para                               | Qué hace falta                                                                                              | Quién                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| Shopify (por comercio)             | App de Shopify con OAuth, o token privado de Storefront del comerciante; revisión de los términos de la API | El comerciante y Fluvia |
| WooCommerce (por comercio)         | URL HTTPS y claves REST de solo lectura                                                                     | El comerciante          |
| Amazon                             | Cuenta de Associates aprobada, acceso a la Creators API y aceptación del Operating Agreement                | Fluvia                  |
| Cifrado de credenciales por tenant | Clave de cifrado en el gestor de secretos del despliegue                                                    | Operación de Fluvia     |
