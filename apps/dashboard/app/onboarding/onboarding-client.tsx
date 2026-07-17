'use client';

import { useRef, useState } from 'react';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../lib/csrf-header';
import { MESSAGES, type Locale } from '../messages';
import type { InitialMerchant, InitialOrganization } from './resolve';

/**
 * Wizard de onboarding sandbox (F6.5C2). Dos pasos contra los proxies BFF
 * (`/api/onboarding/organization` y `/api/orgs/:orgId/onboarding/merchant`),
 * cada uno con guard CSRF server-side y header `X-Fluvia-CSRF` del cliente.
 *
 * Recuperacion DURABLE: el paso inicial lo gobierna el estado enviado por el
 * SERVIDOR (props `initialOrganization`/`initialMerchant`/
 * `onboardingNotApplicable`, resueltas en page.tsx contra el backend) — un
 * reload tras crear la organizacion, o tras merchant-creado/chart-fallido,
 * retoma el paso correcto con los datos reales prellenados, sin recrear
 * filas, sin exigir recordar name/slug y sin localStorage/sessionStorage.
 *
 * El cliente JAMAS crea organizacion/merchant por si mismo ni guarda
 * secretos: un reintento llama al endpoint idempotente y el backend recupera
 * por replay natural y re-ejecuta ensureChart. Sin auto-login, sin emails
 * reales, sin provider real.
 */

// Espejo de CURRENCY_CODES de @fluvia/money (el dashboard no depende del
// paquete; el API valida la lista real y rechaza monedas ajenas).
const CURRENCY_OPTIONS = ['COP', 'USD', 'EUR', 'GBP', 'MXN', 'BRL', 'ARS', 'PEN', 'CLP', 'JPY'];

type Step = 'org' | 'merchant';
type Phase = 'idle' | 'submitting' | 'success';
type WizardError =
  | null
  | 'invalid'
  | 'slug_taken'
  | 'already_completed'
  | 'merchant_already_completed'
  | 'generic';

export function OnboardingWizard({
  locale,
  navigate,
  initialOrganization = null,
  initialMerchant = null,
  onboardingNotApplicable = false,
}: {
  locale: Locale;
  /** Inyectable para tests; default: navegacion real del navegador. */
  navigate?: (url: string) => void;
  /** Organizacion owner ya existente, validada server-side contra la sesion. */
  initialOrganization?: InitialOrganization | null;
  /** Merchant unico ya existente (replay + ensureChart al reenviar). */
  initialMerchant?: InitialMerchant | null;
  /** 2+ merchants: el onboarding inicial ya no aplica (sin seleccion). */
  onboardingNotApplicable?: boolean;
}) {
  const t = MESSAGES[locale];
  const go = navigate ?? ((url: string) => window.location.assign(url));
  const dashboardHref = locale === 'en' ? '/?lang=en' : '/';

  const [step, setStep] = useState<Step>(initialOrganization ? 'merchant' : 'org');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<WizardError>(null);
  const [orgRecovered, setOrgRecovered] = useState(initialOrganization !== null);
  const [orgId, setOrgId] = useState<string | null>(initialOrganization?.id ?? null);
  const [merchantFailedOnce, setMerchantFailedOnce] = useState(false);

  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [merchantName, setMerchantName] = useState(initialMerchant?.name ?? '');
  const [country, setCountry] = useState(initialMerchant?.country ?? 'CO');
  const [currency, setCurrency] = useState(initialMerchant?.defaultCurrency ?? 'COP');

  const errorRef = useRef<HTMLParagraphElement>(null);

  function showError(kind: Exclude<WizardError, null>) {
    setError(kind);
    setPhase('idle');
    // Foco al alert tras el error (tabIndex=-1): el lector de pantalla lo
    // anuncia y el operador retoma el formulario desde ahi.
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  async function submitOrg(e: React.FormEvent) {
    e.preventDefault();
    if (phase !== 'idle') return; // anti doble-submit
    setError(null);
    setPhase('submitting');
    try {
      const res = await fetch('/api/onboarding/organization', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
        body: JSON.stringify({ organizationName: orgName, slug }),
      });
      if (res.status === 201 || res.status === 200) {
        const body = (await res.json().catch(() => null)) as {
          organization?: { id?: string };
          replayed?: boolean;
        } | null;
        const id = body?.organization?.id;
        if (typeof id === 'string' && id) {
          setOrgId(id);
          setOrgRecovered(body?.replayed === true);
          setStep('merchant');
          setPhase('idle');
          return;
        }
        showError('generic');
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      const code = body.error?.code;
      if (code === 'organization_slug_taken') showError('slug_taken');
      else if (code === 'onboarding_already_completed') showError('already_completed');
      else if (code === 'validation_error') showError('invalid');
      else showError('generic');
    } catch {
      showError('generic');
    }
  }

  async function submitMerchant(e: React.FormEvent) {
    e.preventDefault();
    if (phase !== 'idle' || !orgId) return; // anti doble-submit
    setError(null);
    setPhase('submitting');
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/onboarding/merchant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
        body: JSON.stringify({ name: merchantName, country, defaultCurrency: currency }),
      });
      if (res.status === 201 || res.status === 200) {
        const body = (await res.json().catch(() => null)) as { chartReady?: boolean } | null;
        if (body?.chartReady === true) {
          setPhase('success');
          go(dashboardHref);
          return;
        }
        setMerchantFailedOnce(true);
        showError('generic');
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      const code = body.error?.code;
      setMerchantFailedOnce(true);
      if (code === 'merchant_onboarding_already_completed') showError('merchant_already_completed');
      else if (code === 'validation_error') showError('invalid');
      else showError('generic');
    } catch {
      setMerchantFailedOnce(true);
      showError('generic');
    }
  }

  const errorText =
    error === 'slug_taken'
      ? t.onboardingSlugTaken
      : error === 'already_completed'
        ? t.onboardingAlreadyCompleted
        : error === 'merchant_already_completed'
          ? t.merchantOnboardingAlreadyCompleted
          : error === 'invalid'
            ? t.onboardingInvalidInput
            : t.onboardingGenericError;

  // 2+ merchants: el onboarding inicial ya no aplica — sin seleccion
  // arbitraria, sin formulario; solo la explicacion y el enlace al panel.
  if (onboardingNotApplicable) {
    return (
      <main className="auth" aria-labelledby="onboarding-title">
        <h1 id="onboarding-title">{t.onboardingTitle}</h1>
        <p className="notice">{t.onboardingNotApplicableBody}</p>
        <p className="notice">{t.sandboxNotice}</p>
        <p>
          <a href={dashboardHref}>{t.goToDashboard}</a>
        </p>
      </main>
    );
  }

  return (
    <main className="auth" aria-labelledby="onboarding-title">
      <h1 id="onboarding-title">{t.onboardingTitle}</h1>
      <p className="notice">{t.onboardingIntro}</p>
      <p className="notice">{t.sandboxNotice}</p>

      {step === 'org' && (
        <form onSubmit={submitOrg} aria-labelledby="onboarding-step-org">
          <h2 id="onboarding-step-org">{t.onboardingStepOrg}</h2>
          <label htmlFor="org-name">{t.orgNameLabel}</label>
          <input
            id="org-name"
            type="text"
            required
            minLength={2}
            maxLength={120}
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
          />

          <label htmlFor="org-slug">{t.orgSlugLabel}</label>
          <input
            id="org-slug"
            type="text"
            required
            minLength={2}
            maxLength={49}
            pattern="[a-z0-9][a-z0-9-]{1,48}"
            aria-describedby="org-slug-hint"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
          <p className="hint" id="org-slug-hint">
            {t.orgSlugHint}
          </p>

          {error !== null && (
            <p className="error" role="alert" tabIndex={-1} ref={errorRef}>
              {errorText}
              {error === 'already_completed' && (
                <>
                  {' '}
                  <a href={dashboardHref}>{t.goToDashboard}</a>
                </>
              )}
            </p>
          )}

          <button type="submit" className="primary" disabled={phase !== 'idle'}>
            {phase === 'submitting' ? t.creatingOrgAction : t.continueAction}
          </button>
        </form>
      )}

      {step === 'merchant' && (
        <form onSubmit={submitMerchant} aria-labelledby="onboarding-step-merchant">
          <h2 id="onboarding-step-merchant">{t.onboardingStepMerchant}</h2>
          {orgRecovered && (
            <p className="notice" role="status">
              {initialOrganization
                ? `${t.onboardingOrgResumed} (${initialOrganization.name})`
                : t.onboardingOrgRecovered}
            </p>
          )}
          {initialMerchant !== null && (
            <p className="notice" role="status">
              {t.onboardingMerchantResumed}
            </p>
          )}
          <label htmlFor="merchant-name">{t.merchantNameLabel}</label>
          <input
            id="merchant-name"
            type="text"
            required
            minLength={2}
            maxLength={80}
            value={merchantName}
            onChange={(e) => setMerchantName(e.target.value)}
          />

          <label htmlFor="merchant-country">{t.merchantCountryLabel}</label>
          <input
            id="merchant-country"
            type="text"
            required
            pattern="[A-Z]{2}"
            maxLength={2}
            aria-describedby="merchant-country-hint"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          />
          <p className="hint" id="merchant-country-hint">
            {t.merchantCountryHint}
          </p>

          <label htmlFor="merchant-currency">{t.merchantCurrencyLabel}</label>
          <select
            id="merchant-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {CURRENCY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          {error !== null && (
            <p className="error" role="alert" tabIndex={-1} ref={errorRef}>
              {errorText}
              {error === 'merchant_already_completed' && (
                <>
                  {' '}
                  <a href={dashboardHref}>{t.goToDashboard}</a>
                </>
              )}
            </p>
          )}
          {merchantFailedOnce && error !== null && error !== 'merchant_already_completed' && (
            <p className="hint">{t.onboardingMerchantRetryHint}</p>
          )}
          {phase === 'success' && (
            <p className="notice" role="status">
              {t.onboardingDone}
            </p>
          )}

          <button type="submit" className="primary" disabled={phase !== 'idle'}>
            {phase === 'submitting'
              ? t.creatingMerchantAction
              : merchantFailedOnce
                ? t.retryAction
                : t.finishAction}
          </button>
        </form>
      )}
    </main>
  );
}
