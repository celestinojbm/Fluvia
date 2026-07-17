import type { Merchant, Org } from '../lib/api';

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
 * Selecciona la organizacion del onboarding entre las organizaciones OWNER del
 * usuario (obtenidas server-side con su sesion). Un `orgId` de query string
 * JAMAS se usa directamente: solo selecciona si pertenece a esa lista; un
 * orgId ajeno/inexistente/no-owner se IGNORA (fail-safe, sin fuga — se cae a
 * la resolucion propia por defecto). Sin organizacion owner => null (Paso 1).
 */
export function selectOnboardingOrganization(
  orgs: Org[],
  requestedOrgId?: string
): InitialOrganization | null {
  const owned = orgs.filter((o) => o.role === 'owner');
  const pick =
    (requestedOrgId !== undefined && owned.find((o) => o.organization_id === requestedOrgId)) ||
    owned[0];
  if (!pick) return null;
  return { id: pick.organization_id, name: pick.name, slug: pick.slug };
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
export function resolveMerchantState(merchants: Merchant[]): {
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
