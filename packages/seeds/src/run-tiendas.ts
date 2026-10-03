import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { SHOPS_DEMO, seedShopsDemo } from './shops-seed.js';

/**
 * CLI: `pnpm --filter @fluvia/seeds run seed:tiendas` (tras `pnpm seed`).
 * Solo local/test. Sale con código 1 y un motivo concreto si alguna
 * postcondición no se cumple.
 */
const config = loadConfig();
const admin = createPool({ connectionString: config.db.admin, max: 2 });
try {
  const r = await seedShopsDemo(config.env, { admin });
  // CLI: stdout ES la interfaz (excepción deliberada a no-console).
  // eslint-disable-next-line no-console
  console.log(`Seed de tiendas aplicado (postcondiciones comprobadas):
${r.shops.map((s) => `  tienda        ${s.slug} · ${s.products} productos publicados`).join('\n')}
  bodega-demo   ${r.bodegaListed} productos publicados

Credenciales de DEMO (SOLO local/test):
  comercio de las tiendas  ${SHOPS_DEMO.owner.email} / ${SHOPS_DEMO.owner.password}
  cliente (Personal)       cliente@demo.fluvia.test / demo-cliente-password`);
} catch (e) {
  console.error(`ERROR del seed de tiendas: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await admin.end();
}
