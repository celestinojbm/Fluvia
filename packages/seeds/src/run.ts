import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { DEMO, seedDemo } from './seed.js';
import { PROGRAM_DEMO, seedProgramDemo } from './program-seed.js';

/**
 * CLI: `pnpm seed` (raiz) -> datos de demo deterministas en local/test.
 * Fuera de local/test el guard de seedDemo aborta ANTES de tocar la BD.
 */
const config = loadConfig();
const admin = createPool({ connectionString: config.db.admin, max: 2 });
const app = createPool({ connectionString: config.db.app, max: 4 });
const auth = createPool({ connectionString: config.db.auth, max: 2 });

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
  const program = await seedProgramDemo(config.env, { admin, app, auth });
  // eslint-disable-next-line no-console
  console.log(`
Fluvia Personal (programa de DEMO, sintético):
  programa      ${PROGRAM_DEMO.organizationName} (${program.programId})
  operadores    owner@demo.fluvia.test [owner] · ${PROGRAM_DEMO.operator.email} / ${PROGRAM_DEMO.operator.password} [finance]
  cliente       ${PROGRAM_DEMO.consumer.email} / ${PROGRAM_DEMO.consumer.password} — tarjeta virtual •••• ${program.cardLast4 ?? '····'}
  configura     FLUVIA_PROGRAM_TENANT_ID=${program.programId}`);
} finally {
  await Promise.all([admin.end(), app.end(), auth.end()]);
}
