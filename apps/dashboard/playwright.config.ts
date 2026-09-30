import { defineConfig } from '@playwright/test';

/**
 * E2E de navegador del justificante del POS (corre en CI): dashboard REAL
 * (`next start`, requiere `next build` previo) contra la API SINTÉTICA
 * versionada `e2e/synthetic-api.mjs`. La verificación contra el stack real
 * (PG, Redis, API, MockProvider) es local: `e2e/real-stack/`.
 */
const API_PORT = 3999;
const APP_PORT = 3210;

export default defineConfig({
  testDir: 'e2e',
  testMatch: /receipt\.spec\.ts/,
  timeout: 60_000,
  // La API sintética tiene un modo global (/__mode): un solo worker, en serie.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: [
    {
      command: 'node e2e/synthetic-api.mjs',
      url: `http://127.0.0.1:${API_PORT}/health`,
      env: { SYNTHETIC_API_PORT: String(API_PORT) },
      reuseExistingServer: false,
    },
    {
      command: `next start -p ${APP_PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${APP_PORT}/login`,
      env: {
        FLUVIA_API_URL: `http://127.0.0.1:${API_PORT}`,
        FLUVIA_DASHBOARD_ORIGIN: `http://127.0.0.1:${APP_PORT}`,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
