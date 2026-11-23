import { parseArgs } from 'node:util';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { KillSwitchAdmin, type KillSwitchDto, type KillSwitchScope } from './kill-switch.js';

/**
 * CLI del kill switch (issue #91). Runbook: `docs/ops/runbooks/kill-switch.md`.
 * Plano de PLATAFORMA: corre con el pool ADMIN; cada activación/liberación
 * exige razón y queda auditada (`platform.operation`, riesgo alto).
 *
 *   pnpm --filter @fluvia/payments-core run kill-switch -- list
 *   pnpm --filter @fluvia/payments-core run kill-switch -- history --limit 20
 *   pnpm --filter @fluvia/payments-core run kill-switch -- engage \
 *     --scope country --target VE --actor <uuid-operador> --reason "GL 57 revocada (OFAC, 2026-11-23)"
 *   pnpm --filter @fluvia/payments-core run kill-switch -- release \
 *     --id <uuid> --actor <uuid-operador> --reason "Dictamen legal 2026-12-01 autoriza reanudar"
 */

const USAGE = `uso: kill-switch <list|history|engage|release> [opciones]
  engage   --scope country|merchant|provider --target <valor> --actor <uuid del operador> --reason <por qué>
  release  --id <uuid> --actor <uuid del operador> --reason <por qué>
  history  [--limit N]`;

// `pnpm run kill-switch -- engage …` reenvía el `--` literal; parseArgs lo
// trataría como fin de opciones y todo quedaría como posicional.
const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift();

const { positionals, values } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    scope: { type: 'string' },
    target: { type: 'string' },
    id: { type: 'string' },
    actor: { type: 'string' },
    reason: { type: 'string' },
    limit: { type: 'string' },
  },
});

const command = positionals[0];
if (!command || !['list', 'history', 'engage', 'release'].includes(command)) {
  console.error(USAGE);
  process.exit(2);
}

const show = (k: KillSwitchDto): string =>
  [
    k.id,
    `${k.scope}=${k.target}`,
    `engaged ${k.engagedAt} by ${k.engagedBy}`,
    k.releasedAt ? `released ${k.releasedAt} by ${k.releasedBy ?? '?'}` : 'ACTIVE',
    `reason: ${k.reason}`,
  ].join(' | ');

const config = loadConfig();
const pool = createPool({ connectionString: config.db.admin });
const admin = new KillSwitchAdmin(pool);

try {
  if (command === 'list') {
    const active = await admin.listActive();
    if (active.length === 0) console.log('No active kill switches.');
    for (const k of active) console.log(show(k));
  } else if (command === 'history') {
    for (const k of await admin.history(values.limit ? Number(values.limit) : 50)) {
      console.log(show(k));
    }
  } else if (command === 'engage') {
    const res = await admin.engage({
      scope: (values.scope ?? '') as KillSwitchScope,
      target: values.target ?? '',
      actorId: values.actor ?? '',
      reason: values.reason ?? '',
    });
    console.log(`${res.created ? 'ENGAGED' : 'ALREADY ACTIVE'}: ${show(res.killSwitch)}`);
  } else {
    const k = await admin.release({
      id: values.id ?? '',
      actorId: values.actor ?? '',
      reason: values.reason ?? '',
    });
    console.log(`RELEASED: ${show(k)}`);
  }
} catch (err) {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
