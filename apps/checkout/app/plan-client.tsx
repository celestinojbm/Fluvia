'use client';

import { useCallback, useEffect, useState } from 'react';
import { INSTALLMENTS_MESSAGES } from './installments-messages';
import { MESSAGES, type Locale } from './messages';
import { OrderSummary, PlanBox, PlanTimeline, type CheckoutOrderView } from './order-panels';

/**
 * Consulta del plan de cuotas por el COMPRADOR. Credencial: el client_secret
 * de su checkout (fragmento de la URL, no llega a logs). Solo lectura.
 */
export function PlanClient({ sessionId, locale }: { sessionId: string; locale: Locale }) {
  const t = MESSAGES[locale];
  const ti = INSTALLMENTS_MESSAGES[locale];
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'not_found' } | { kind: 'error' } | { kind: 'ok'; view: CheckoutOrderView }
  >({ kind: 'loading' });
  const secret = useCallback(
    () => (typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.replace(/^#/, ''))),
    []
  );
  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(`/api/checkout/${sessionId}/order`, {
        headers: { 'x-checkout-client-secret': secret() },
      });
      if (res.status === 404 || res.status === 400) return setState({ kind: 'not_found' });
      if (!res.ok) return setState({ kind: 'error' });
      const body = (await res.json()) as Partial<CheckoutOrderView> | null;
      if (!body?.order || !Array.isArray(body.order.lines) || !body.installments) {
        return setState({ kind: 'error' });
      }
      setState({ kind: 'ok', view: body as CheckoutOrderView });
    } catch {
      setState({ kind: 'error' });
    }
  }, [sessionId, secret]);
  useEffect(() => {
    void load();
  }, [load]);

  const back = `/c/${sessionId}${locale === 'en' ? '?lang=en' : ''}#${encodeURIComponent(secret())}`;
  return (
    <main className="checkout" aria-labelledby="plan-page-title">
      <h1 id="plan-page-title">{ti.planTitle}</h1>
      {state.kind === 'loading' ? <p role="status">{t.checking}</p> : null}
      {state.kind === 'not_found' ? (
        <p className="error" role="alert">
          {t.notFound}
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <>
          <p className="error" role="alert">
            {t.loadError}
          </p>
          <button type="button" className="pay" onClick={() => void load()}>
            {t.retry}
          </button>
        </>
      ) : null}
      {state.kind === 'ok' ? (
        <>
          {state.view.installments.plan ? (
            <>
              <PlanBox plan={state.view.installments.plan} locale={locale} planHref={back} />
              <PlanTimeline plan={state.view.installments.plan} locale={locale} />
            </>
          ) : (
            <p className="status status-neutral">{ti.noPlan}</p>
          )}
          <OrderSummary view={state.view} locale={locale} receipt={false} />
        </>
      ) : null}
      <p>
        <a className="link-btn" href={back}>
          {ti.backToCheckout}
        </a>
      </p>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
