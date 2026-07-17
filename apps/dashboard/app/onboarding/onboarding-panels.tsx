import type { InitialOrganization } from './resolve';
import { MESSAGES, type Locale } from '../messages';

/**
 * RA-F65C2-EXT-002/003 — paneles server-rendered del onboarding. Ninguno
 * ejecuta mutaciones ni guarda estado en el cliente:
 *  - seleccion explicita: cada opcion es un ENLACE a `/onboarding?orgId=…`
 *    (validado de nuevo server-side al navegar); jamas un <select> con
 *    mutacion automatica; solo se listan organizaciones OWNER de la propia
 *    sesion (cero IDs ajenos);
 *  - seleccion invalida: mensaje GENERICO que no revela si el ID existe;
 *  - lectura fallida: estado recuperable con reintento por enlace (re-resuelve
 *    desde el backend), sin detalles de red/stack/body.
 */

function onboardingHref(locale: Locale, orgId?: string): string {
  const params = new URLSearchParams();
  if (orgId !== undefined) params.set('orgId', orgId);
  if (locale === 'en') params.set('lang', 'en');
  const qs = params.toString();
  return qs === '' ? '/onboarding' : `/onboarding?${qs}`;
}

function OwnerOptions({ options, locale }: { options: InitialOrganization[]; locale: Locale }) {
  const t = MESSAGES[locale];
  return (
    <ul className="org-list">
      {options.map((o) => (
        <li key={o.id}>
          <a
            href={onboardingHref(locale, o.id)}
            aria-label={`${t.onboardingSelectOption} — ${o.name}`}
          >
            <span className="org-name">{o.name}</span>
            <span className="org-role">{o.slug}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** 2+ organizaciones owner sin `orgId`: seleccion EXPLICITA obligatoria. */
export function OrgSelectionPanel({
  options,
  locale,
}: {
  options: InitialOrganization[];
  locale: Locale;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="auth" aria-labelledby="onboarding-title">
      <h1 id="onboarding-title">{t.onboardingTitle}</h1>
      <p className="notice">{t.onboardingSelectBody}</p>
      <p className="notice">{t.sandboxNotice}</p>
      <OwnerOptions options={options} locale={locale} />
      <p>
        <a href={locale === 'en' ? '/?lang=en' : '/'}>{t.goToDashboard}</a>
      </p>
    </main>
  );
}

/**
 * `orgId` inexistente/ajeno/no-owner: SIN fallback, SIN lectura de merchants,
 * SIN formulario de mutacion. Mensaje generico + solo organizaciones owner
 * propias; sin owners, enlace explicito a un onboarding nuevo (sin orgId).
 */
export function InvalidSelectionPanel({
  options,
  locale,
}: {
  options: InitialOrganization[];
  locale: Locale;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="auth" aria-labelledby="onboarding-title">
      <h1 id="onboarding-title">{t.onboardingTitle}</h1>
      <p className="error" role="alert">
        {t.onboardingInvalidSelection}
      </p>
      {options.length > 0 ? (
        <>
          <p className="notice">{t.onboardingSelectBody}</p>
          <OwnerOptions options={options} locale={locale} />
        </>
      ) : (
        <p>
          <a href={onboardingHref(locale)}>{t.onboardingStartNew}</a>
        </p>
      )}
      <p>
        <a href={locale === 'en' ? '/?lang=en' : '/'}>{t.goToDashboard}</a>
      </p>
    </main>
  );
}

/** Fallo de lectura: estado recuperable, jamas «vacio»; retry re-resuelve. */
export function ReadErrorPanel({ locale, retryOrgId }: { locale: Locale; retryOrgId?: string }) {
  const t = MESSAGES[locale];
  return (
    <main className="auth" aria-labelledby="onboarding-title">
      <h1 id="onboarding-title">{t.onboardingTitle}</h1>
      <p className="error" role="alert">
        {t.onboardingReadError}
      </p>
      <p className="notice">{t.onboardingReadErrorHint}</p>
      <p>
        <a href={onboardingHref(locale, retryOrgId)}>{t.retryAction}</a>
      </p>
      <p>
        <a href={locale === 'en' ? '/?lang=en' : '/'}>{t.goToDashboard}</a>
      </p>
    </main>
  );
}
