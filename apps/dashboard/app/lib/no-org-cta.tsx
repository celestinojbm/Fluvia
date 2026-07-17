import { MESSAGES, type Locale } from '../messages';

/**
 * F6.5C1: un usuario autenticado SIN memberships es un estado VÁLIDO (decisión
 * del plan F6.5C §7.1). Esta CTA comunica el siguiente paso — crear la
 * organización — que pertenece al onboarding sandbox de F6.5C2, AÚN NO
 * implementado: por eso es texto informativo sin enlace (no se deja un enlace
 * roto ni se crean datos automáticamente).
 */
export function NoOrgCta({ locale }: { locale: Locale }) {
  const t = MESSAGES[locale];
  return (
    <section className="empty" aria-labelledby="no-org-title">
      <h2 id="no-org-title">{t.noOrgCtaTitle}</h2>
      <p>{t.noOrgs}</p>
      <p>{t.noOrgCtaBody}</p>
    </section>
  );
}
