import { parseArgs } from 'node:util';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { MerchantRiskAdmin, type DenylistEntryDto, type MerchantRiskDto } from './merchant-risk.js';

/**
 * CLI de riesgo de comercios (issue #92). Runbook: `docs/ops/runbooks/merchant-risk.md`.
 * Plano de PLATAFORMA: pool ADMIN; toda escritura exige razón y queda auditada
 * (`platform.operation`, riesgo alto).
 *
 *   pnpm --filter @fluvia/identity run merchant-risk -- screen [--include-undeclared]
 *   pnpm --filter @fluvia/identity run merchant-risk -- show --merchant <uuid>
 *   pnpm --filter @fluvia/identity run merchant-risk -- freeze \
 *     --merchant <uuid> --actor <uuid-operador> --reason "Filial de PDVSA (#92)"
 *   pnpm --filter @fluvia/identity run merchant-risk -- unfreeze \
 *     --merchant <uuid> --actor <uuid-operador> --reason "Falso positivo revisado por Legal"
 *   pnpm --filter @fluvia/identity run merchant-risk -- denylist-list [--include-retired]
 *   pnpm --filter @fluvia/identity run merchant-risk -- denylist-add \
 *     --pattern "Corporación Venezolana de Guayana" --actor <uuid> --reason "Legal 2026-12-01"
 *   pnpm --filter @fluvia/identity run merchant-risk -- denylist-retire \
 *     --id <uuid> --actor <uuid> --reason "Falso positivo"
 */

const COMMANDS = [
  'screen',
  'show',
  'freeze',
  'unfreeze',
  'denylist-list',
  'denylist-add',
  'denylist-retire',
] as const;

const USAGE = `uso: merchant-risk <${COMMANDS.join('|')}> [opciones]
  screen           [--include-undeclared]
  show             --merchant <uuid>
  freeze|unfreeze  --merchant <uuid> --actor <uuid del operador> --reason <por qué>
  denylist-list    [--include-retired]
  denylist-add     --pattern <texto> --actor <uuid del operador> --reason <por qué>
  denylist-retire  --id <uuid> --actor <uuid del operador> --reason <por qué>`;

// `pnpm run merchant-risk -- freeze …` reenvía el `--` literal.
const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift();

const { positionals, values } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    merchant: { type: 'string' },
    pattern: { type: 'string' },
    id: { type: 'string' },
    actor: { type: 'string' },
    reason: { type: 'string' },
    'include-undeclared': { type: 'boolean' },
    'include-retired': { type: 'boolean' },
  },
});

const command = positionals[0] as (typeof COMMANDS)[number] | undefined;
if (!command || !COMMANDS.includes(command)) {
  console.error(USAGE);
  process.exit(2);
}

const showMerchant = (m: MerchantRiskDto): string =>
  [
    m.id,
    `tenant ${m.tenantId}`,
    JSON.stringify(m.name),
    m.country,
    m.status.toUpperCase(),
    `affiliation=${m.stateAffiliation ?? 'UNDECLARED'}`,
    `declaration=${m.affiliationDeclarationStatus}`,
  ].join(' | ');

const showEntry = (e: DenylistEntryDto): string =>
  [
    e.id,
    JSON.stringify(e.pattern),
    `added ${e.addedAt} by ${e.addedBy ?? 'migration'}`,
    e.retiredAt ? `retired ${e.retiredAt} by ${e.retiredBy ?? '?'}` : 'ACTIVE',
    `reason: ${e.reason}`,
  ].join(' | ');

const config = loadConfig();
const pool = createPool({ connectionString: config.db.admin });
const admin = new MerchantRiskAdmin(pool);
const write = {
  actorId: values.actor ?? '',
  reason: values.reason ?? '',
};

try {
  switch (command) {
    case 'screen': {
      const found = await admin.screen({ includeUndeclared: values['include-undeclared'] });
      if (found.length === 0) console.log('No active merchants need review.');
      for (const f of found) console.log(`${f.findings.join(',')} | ${showMerchant(f.merchant)}`);
      break;
    }
    case 'show':
      console.log(showMerchant(await admin.getMerchant(values.merchant ?? '')));
      break;
    case 'freeze':
    case 'unfreeze': {
      const input = { merchantId: values.merchant ?? '', ...write };
      const res = command === 'freeze' ? await admin.freeze(input) : await admin.unfreeze(input);
      const label = command === 'freeze' ? 'FROZEN' : 'UNFROZEN';
      console.log(`${res.changed ? label : 'UNCHANGED'}: ${showMerchant(res.merchant)}`);
      break;
    }
    case 'denylist-list':
      for (const e of await admin.listDenylist({ includeRetired: values['include-retired'] })) {
        console.log(showEntry(e));
      }
      break;
    case 'denylist-add': {
      const res = await admin.addPattern({ pattern: values.pattern ?? '', ...write });
      console.log(`${res.created ? 'ADDED' : 'ALREADY ACTIVE'}: ${showEntry(res.entry)}`);
      break;
    }
    case 'denylist-retire':
      console.log(
        `RETIRED: ${showEntry(await admin.retirePattern({ id: values.id ?? '', ...write }))}`
      );
      break;
  }
} catch (err) {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
