import type { Org } from './api';
import { MESSAGES, type Locale } from '../messages';

/**
 * F6.5C2 — lista de organizaciones de la raiz del dashboard. Cada fila
 * conserva su enlace NORMAL al panel (`/o/{orgId}`); para las organizaciones
 * donde el usuario es OWNER se anade una accion SECUNDARIA
 * «Configurar / continuar onboarding sandbox» hacia `/onboarding?orgId=…`
 * (validada server-side contra la sesion en esa pagina). No se afirma que el
 * onboarding este incompleto — el estado real lo resuelve `/onboarding` en el
 * servidor; la accion solo garantiza una via visible y no rota para
 * continuar/retomar el onboarding despues de navegar o recargar.
 *
 * El `{' '}` entre nombre y rol NO es cosmetico: los `<span>` son inline, y el
 * nombre accesible del enlace se concatena SIN separador («Mi Empresaowner»)
 * salvo que el CSS los blockifique (hoy lo hace el `display:flex` del enlace).
 * Con el espacio explicito el lector de pantalla anuncia «Mi Empresa owner»
 * aunque la hoja de estilos no cargue o cambie. Visualmente no altera nada: en
 * un contenedor flex el texto solo-espacio no genera item.
 */
export function OrgList({ orgs, locale }: { orgs: Org[]; locale: Locale }) {
  const t = MESSAGES[locale];
  const onboardingHref = (orgId: string) =>
    locale === 'en'
      ? `/onboarding?orgId=${encodeURIComponent(orgId)}&lang=en`
      : `/onboarding?orgId=${encodeURIComponent(orgId)}`;
  return (
    <ul className="org-list">
      {orgs.map((o) => (
        <li key={o.organization_id}>
          <a href={`/o/${o.organization_id}`}>
            <span className="org-name">{o.name}</span>{' '}
            <span className="org-role">{o.role}</span>
          </a>
          {o.role === 'owner' && (
            <a
              className="org-secondary"
              href={onboardingHref(o.organization_id)}
              aria-label={`${t.continueOnboardingAction} — ${o.name}`}
            >
              {t.continueOnboardingAction}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
