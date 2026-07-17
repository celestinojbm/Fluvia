import type { Org } from '../lib/api';
import type { OnboardingMerchant } from '../lib/onboarding-reads';

/**
 * F6.5C2 — resolucion SERVER-SIDE del estado de onboarding (recuperacion
 * durable): el paso inicial del wizard lo gobierna el estado REAL del backend
 * (organizaciones y merchants leidos con la cookie de sesion), nunca el
 * estado previo del componente, la pestana ni localStorage. Funciones puras y
 * testeables; el API y RBAC/RLS siguen siendo la fuente de verdad.
 */

export interface InitialOrganization {
  id: string;
  name: string;
  slug: string;
}

export interface InitialMerchant {
  name: string;
  country: string;
  defaultCurrency: string;
}

/**
 * RA-F65C2-EXT-002 — resultado DISCRIMINADO de la seleccion de organizacion.
 * NO existe fallback silencioso: un `orgId` que no pertenece a las
 * organizaciones OWNER de la propia sesion es `invalid_selection` (jamas se
 * muta contra otra organizacion elegida implicitamente), y con 2+
 * organizaciones owner sin `orgId` se exige seleccion explicita
 * (`selection_required`) en vez de elegir `owned[0]`.
 */
export type OnboardingOrgResolution =
  | { kind: 'new_onboarding' }
  | { kind: 'selected'; organization: InitialOrganization }
  | { kind: 'selection_required'; options: InitialOrganization[] }
  | { kind: 'invalid_selection'; options: InitialOrganization[] };

export function resolveOnboardingOrganization(
  orgs: Org[],
  requestedOrgId?: string
): OnboardingOrgResolution {
  const owned: InitialOrganization[] = orgs
    .filter((o) => o.role === 'owner')
    .map((o) => ({ id: o.organization_id, name: o.name, slug: o.slug }));

  if (requestedOrgId !== undefined) {
    const match = owned.find((o) => o.id === requestedOrgId);
    if (match) return { kind: 'selected', organization: match };
    // Inexistente, ajeno o membership no-owner: indistinguibles entre si (el
    // mensaje no revela si el ID existe); las opciones ofrecidas son SOLO las
    // organizaciones owner de la propia sesion.
    return { kind: 'invalid_selection', options: owned };
  }
  if (owned.length === 0) return { kind: 'new_onboarding' };
  if (owned.length === 1) return { kind: 'selected', organization: owned[0]! };
  return { kind: 'selection_required', options: owned };
}

/**
 * Estado del Paso 2 a partir de los merchants (deleted_at IS NULL) de la
 * organizacion seleccionada:
 *  - 0 => Paso 2 vacio;
 *  - 1 => Paso 2 PRELLENADO (el submit llama al endpoint idempotente: el
 *    backend recupera el merchant por replay y ejecuta/reintenta ensureChart);
 *  - 2+ => el onboarding inicial ya no aplica (JAMAS se selecciona uno
 *    arbitrariamente; se ofrece el enlace al dashboard).
 */
export function resolveMerchantState(merchants: OnboardingMerchant[]): {
  initialMerchant: InitialMerchant | null;
  notApplicable: boolean;
} {
  if (merchants.length === 1) {
    const m = merchants[0]!;
    return {
      initialMerchant: { name: m.name, country: m.country, defaultCurrency: m.defaultCurrency },
      notApplicable: false,
    };
  }
  return { initialMerchant: null, notApplicable: merchants.length > 1 };
}
