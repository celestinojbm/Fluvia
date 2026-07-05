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
