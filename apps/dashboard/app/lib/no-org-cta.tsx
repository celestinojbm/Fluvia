import { MESSAGES, type Locale } from '../messages';

/**
 * F6.5C1/C2: un usuario autenticado SIN memberships es un estado VÁLIDO. Esta
 * CTA enlaza al wizard de onboarding sandbox (`/onboarding`, F6.5C2) — el
 * siguiente paso es crear la organización; no se crean datos automáticamente.
 */
export function NoOrgCta({ locale }: { locale: Locale }) {
  const t = MESSAGES[locale];
  const onboardingHref = locale === 'en' ? '/onboarding?lang=en' : '/onboarding';
  return (
    <section className="empty" aria-labelledby="no-org-title">
      <h2 id="no-org-title">{t.noOrgCtaTitle}</h2>
      <p>{t.noOrgs}</p>
      <p>{t.noOrgCtaBody}</p>
      <p>
        <a href={onboardingHref}>{t.noOrgCtaAction}</a>
      </p>
    </section>
  );
}
