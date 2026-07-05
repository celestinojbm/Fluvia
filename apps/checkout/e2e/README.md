# Verificación E2E de navegador (local)

El CI **no tiene navegador** (no ejecuta `playwright install`), así que la
prueba E2E de navegador de este app corre **localmente**, no en CI. La cobertura
CI-gated son los tests de componente + accesibilidad (`test/`, jsdom + axe), que
verifican render, i18n, la interacción de pago y la accesibilidad estructural.

El flujo E2E full-stack (navegador real → route handlers → API de Fluvia → PG)
se verifica a mano contra el stack real:

1. **PostgreSQL 16** corriendo (ver `docker-compose.yml`) con las migraciones
   aplicadas (`pnpm migrate`).
2. **API de Fluvia** en `:3000`:
   ```
   PORT=3000 NODE_ENV=local pnpm --filter @fluvia/api exec tsx src/server.ts
   ```
3. **Sembrar una sesión** (org + merchant + payment_intent + checkout_session)
   y obtener `{ id, clientSecret }` — vía `PaymentIntentService` +
   `CheckoutSessionService` contra el pool `app`.
4. **App de checkout** en `:3100`, apuntando a la API:
   ```
   FLUVIA_API_URL=http://127.0.0.1:3000 pnpm --filter @fluvia/checkout exec next dev -p 3100
   ```
5. Navegar a `http://127.0.0.1:3100/c/{id}#{clientSecret}` con el Chromium
   preinstalado (`/opt/pw-browsers`, `PLAYWRIGHT_BROWSERS_PATH`) y ejercitar:
   render del monto → clic **Pagar** → estado **completado**.

Resultado verificado (F3-05c-iv): el monto se renderiza (`$ 50.000`), el estado
inicial es «Pago pendiente», y tras confirmar con `tok_approve` la página muestra
«¡Pago completado!» — el `POST /confirm` por `client_secret` completó la sesión
extremo a extremo por la vía real (sin API key en el navegador).

## Payment link `/l/{id}` (F3-06-b)

La ruta `/l/{id}` es la `url` pública del payment link (F3-06). Es un server
component: al abrirla hace el `POST /v1/payment_links/{id}/sessions` server-side
(genera un `payment_intent` + `checkout_session` frescos) y **redirige** el
navegador a `/c/{sessionId}#{clientSecret}` — el mismo flujo alojado de arriba.
El `client_secret` viaja en el fragmento del `Location`, así que no llega a los
logs del servidor en la navegación posterior a `/c/{id}`.

Para ejercitarlo, con la API y el app arriba (pasos 1-4):

1. Crear un payment link vía la API (`POST /v1/payment_links` con API key) y
   tomar su `id`.
2. Navegar a `http://127.0.0.1:3100/l/{id}` con el Chromium preinstalado y
   confirmar que la URL final es `/c/{sessionId}#{clientSecret}` y la página de
   checkout carga con el monto del link.
3. Un link deshabilitado (`POST /v1/payment_links/{id}/disable`) o inexistente
   muestra «Enlace de pago inválido o expirado.» (mismo mensaje — anti-enumeración).

La lógica de resolución (construcción del destino con el fragmento, 404 →
indisponible) y la vista de indisponibilidad están cubiertas por
`test/payment-link-page.test.tsx` (jsdom + axe, CI-gated); solo la redirección
real con fragmento a través del navegador se verifica aquí.
