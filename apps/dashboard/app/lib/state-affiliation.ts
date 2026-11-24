/**
 * #92 — espejo de STATE_AFFILIATIONS de @fluvia/identity (el dashboard no
 * depende del paquete; el API valida la lista real). Módulo sin dependencias
 * de servidor: lo usan el wizard (cliente), las lecturas y el proxy.
 */
export const STATE_AFFILIATION_OPTIONS = ['none', 'government', 'state_owned'] as const;
export type StateAffiliationOption = (typeof STATE_AFFILIATION_OPTIONS)[number];

export function isStateAffiliation(v: unknown): v is StateAffiliationOption {
  return typeof v === 'string' && (STATE_AFFILIATION_OPTIONS as readonly string[]).includes(v);
}
