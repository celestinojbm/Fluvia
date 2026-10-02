import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { RESTAURANT_DEMO, seedRestaurantDemo } from './restaurant-seed.js';

/**
 * CLI: `pnpm --filter @fluvia/seeds run seed:restaurantes` con la API de la
 * instancia en marcha (`SEED_API_URL`). Solo local/test. Sale con código 1 y
 * un motivo concreto si alguna postcondición no se cumple.
 */
const config = loadConfig();
const apiUrl = process.env.SEED_API_URL;
if (!apiUrl) {
  console.error('Falta SEED_API_URL (la API de ESTA instancia, p. ej. http://127.0.0.1:3380)');
  process.exit(2);
}
const admin = createPool({ connectionString: config.db.admin, max: 2 });
try {
  const r = await seedRestaurantDemo(config.env, { admin, apiUrl });
  const D = RESTAURANT_DEMO;
  // CLI: stdout ES la interfaz (excepción deliberada a no-console).
  // eslint-disable-next-line no-console
  console.log(`Seed de restaurantes aplicado (postcondiciones comprobadas):
  restaurante   ${D.restaurant.name} (${r.restaurantId}) · ${r.tables} mesas · ${r.menuItems} platos · cobro ${r.restaurantEnablement} (sandbox)
  independiente ${D.independent.name} (${r.independentId}) · cobro ${r.independentEnablement} (sandbox)
  menú QR M1    ${r.menuUrl}

Credenciales de DEMO (SOLO local/test):
  dueño         ${D.owner.email} / ${D.owner.password}
  mesero        ${D.waiter.email} / ${D.waiter.password}
  cocina        ${D.kitchen.email} / ${D.kitchen.password}
  caja          ${D.cashier.email} / ${D.cashier.password}
  independiente ${D.solo.email} / ${D.solo.password}
  comprador     sin cuenta: menú QR de la mesa (arriba) → seguimiento /p#… → pago /c/…#…`);
} catch (e) {
  console.error(`ERROR del seed de restaurantes: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await admin.end();
}
