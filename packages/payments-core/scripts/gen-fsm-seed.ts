import { ATTEMPT_TRANSITIONS, INTENT_TRANSITIONS, transitionPairs } from '../src/fsm.js';

/**
 * Genera el seed SQL de las tablas *_transitions para la migración 0017.
 * El resultado se PEGA versionado en la migración (patrón golden): cambiar la
 * FSM = cambiar el mapa TS + regenerar + migración NUEVA. El meta-test
 * fsm-meta.test.ts verifica que la base y el mapa jamás diverjan.
 *
 * Uso: pnpm --filter @fluvia/payments-core run gen:fsm-seed
 */
function seed(table: string, map: Record<string, readonly string[]>): string {
  const values = transitionPairs(map)
    .map(([from, to]) => `  ('${from}', '${to}')`)
    .join(',\n');
  return `INSERT INTO ${table} (from_status, to_status) VALUES\n${values};`;
}

// eslint-disable-next-line no-console
console.log(seed('payment_intent_transitions', INTENT_TRANSITIONS));
// eslint-disable-next-line no-console
console.log();
// eslint-disable-next-line no-console
console.log(seed('payment_attempt_transitions', ATTEMPT_TRANSITIONS));
