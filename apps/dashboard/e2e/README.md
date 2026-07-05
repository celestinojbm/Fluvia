# Verificación E2E de navegador (local)

El CI **no tiene navegador** (no ejecuta `playwright install`), así que el E2E de
navegador de este app corre **localmente**. La cobertura CI-gated son los tests
de lógica pura del cliente de la API (`test/api.test.ts`) y de componente +
accesibilidad (`test/dashboard-view.test.tsx`, jsdom + axe).

El flujo full-stack (navegador real → route handlers/server components → API de
Fluvia → PG) se verifica a mano contra el stack real:

1. **PostgreSQL 16** con migraciones aplicadas (`pnpm migrate`).
2. **API de Fluvia** en `:3000`:
   ```
   cd apps/api && PORT=3000 NODE_ENV=local pnpm exec tsx src/server.ts
   ```
3. **Sembrar** una organización, un usuario verificado con membresía (rol
   cualquiera — todos tienen `payments:read`) y algunos recursos (payment intent,
   payment link) por el plano de API key.
4. **App de dashboard** en `:3200`, apuntando a la API:
   ```
   FLUVIA_API_URL=http://127.0.0.1:3000 pnpm --filter @fluvia/dashboard exec next dev -p 3200
   ```
5. Navegar a `http://127.0.0.1:3200/login` con el Chromium preinstalado
   (`/opt/pw-browsers`), iniciar sesión, elegir la organización y verificar que el
   panel lista los recursos (intents/refunds/checkout sessions/payment links y la
   cola de webhooks) con montos formateados.

El token de sesión vive SOLO en una cookie httpOnly (`fluvia_session`); el
navegador nunca lo sostiene en JS ni conoce la URL de la API — toda llamada a la
API es server-side (route handlers y server components). El panel es de solo
lectura; la acción de reenvío de webhooks `dead` (F3-09a) llegará en un
incremento posterior por el plano de API key.
