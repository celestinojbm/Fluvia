import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { DEMO, seedDemo } from './seed.js';

/**
 * CLI: `pnpm seed` (raiz) -> datos de demo deterministas en local/test.
 * Fuera de local/test el guard de seedDemo aborta ANTES de tocar la BD.
 */
const config = loadConfig();
const admin = createPool({ connectionString: config.db.admin, max: 2 });
const app = createPool({ connectionString: config.db.app, max: 4 });

try {
  const report = await seedDemo(config.env, { admin, app });
  // CLI: stdout ES la interfaz (excepcion deliberada y puntual a no-console).
  // eslint-disable-next-line no-console
  console.log(`Seed de demo aplicado (reproducible — re-ejecutar no duplica):
  organizacion  ${DEMO.organizationName} (${report.organizationId})
  merchant      ${DEMO.merchantName} (${report.merchantId})
  usuarios      ${DEMO.users.map((u) => `${u.email} [${u.role}]`).join(', ')}
  ledger demo   ${report.transactionIds.length} transacciones COP — pending=${report.balances.pending} available=${report.balances.available}

Credenciales de DEMO (SOLO local/test; el guard impide sembrarlas fuera):
${DEMO.users.map((u) => `  ${u.email} / ${u.password}`).join('\n')}`);
} finally {
  await Promise.all([admin.end(), app.end()]);
}
