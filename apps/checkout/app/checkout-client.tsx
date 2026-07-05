'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAmount, MESSAGES, type Locale } from './messages';

/**
 * Página de checkout alojada (F3-05c-iv). Consume los route handlers
 * server-side (que proxyean a la API con el `client_secret`); el navegador
 * jamás conoce la URL de la API ni una API key. El secreto viaja en el
 * fragmento de la URL (`#…`), que no llega a los logs del servidor.
 *
 * Accesibilidad (WCAG AA): `main`/`h1`, `fieldset`/`legend` para los métodos,
 * `label` explícito, estado en una región `aria-live`, foco al resultado.
 */

interface HostedView {
  id: string;
  status: 'open' | 'completed' | 'expired';
  payment_intent: { id: string; status: string; amount: number; currency: string };
}

type Phase = 'loading' | 'ready' | 'paying' | 'error' | 'not_found';

const METHOD_TOKENS = [
  { token: 'tok_approve', key: 'methodApprove' as const },
  { token: 'tok_decline', key: 'methodDecline' as const },
  { token: 'tok_pse', key: 'methodAsync' as const },
];

export function CheckoutClient({ sessionId, locale }: { sessionId: string; locale: Locale }) {
  const t = MESSAGES[locale];
  const [phase, setPhase] = useState<Phase>('loading');
  const [view, setView] = useState<HostedView | null>(null);
  const [token, setToken] = useState('tok_approve');
  const statusRef = useRef<HTMLParagraphElement>(null);

  const clientSecret = useCallback(() => {
    if (typeof window === 'undefined') return '';
    return decodeURIComponent(window.location.hash.replace(/^#/, ''));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/checkout/${sessionId}/status`, {
        headers: { 'x-checkout-client-secret': clientSecret() },
      });
      if (res.status === 404) return setPhase('not_found');
      if (!res.ok) return setPhase('error');
      setView((await res.json()) as HostedView);
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, [sessionId, clientSecret]);

  useEffect(() => {
    void load();
  }, [load]);

  const pay = useCallback(async () => {
    setPhase('paying');
    try {
      const res = await fetch(`/api/checkout/${sessionId}/confirm`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-checkout-client-secret': clientSecret(),
        },
        body: JSON.stringify({ payment_method_token: token }),
      });
      if (res.status === 404) return setPhase('not_found');
      if (!res.ok) return setPhase('error');
      setView((await res.json()) as HostedView);
      setPhase('ready');
      statusRef.current?.focus();
    } catch {
      setPhase('error');
    }
  }, [sessionId, token, clientSecret]);

  if (phase === 'loading') {
    return (
      <main className="checkout">
        <p role="status">{t.statusOpen}…</p>
      </main>
    );
  }
  if (phase === 'not_found') {
    return (
      <main className="checkout">
        <h1>{t.title}</h1>
        <p className="error" role="alert">
          {t.notFound}
        </p>
      </main>
    );
  }
  if (phase === 'error' || !view) {
    return (
      <main className="checkout">
        <h1>{t.title}</h1>
        <p className="error" role="alert">
          {t.loadError}
        </p>
      </main>
    );
  }

  const intentStatus = view.payment_intent.status;
  const done = view.status === 'completed';
  const expired = view.status === 'expired';
  const failed = intentStatus === 'failed';
  const pending =
    view.status === 'open' && (intentStatus === 'processing' || intentStatus === 'submitted');
  const canPay = view.status === 'open' && !failed && !pending;

  let statusMessage = t.statusOpen;
  if (done) statusMessage = t.statusCompleted;
  else if (expired) statusMessage = t.statusExpired;
  else if (failed) statusMessage = t.paymentFailed;
  else if (pending) statusMessage = t.paymentPending;

  return (
    <main className="checkout" aria-labelledby="checkout-title">
      <h1 id="checkout-title">{t.title}</h1>

      <p className="amount">
        <span className="amount-label">{t.amountLabel}</span>
        <span className="amount-value" data-testid="amount">
          {formatAmount(view.payment_intent.amount, view.payment_intent.currency, locale)}
        </span>
      </p>

      <p
        ref={statusRef}
        tabIndex={-1}
        className={`status status-${done ? 'ok' : expired || failed ? 'bad' : 'neutral'}`}
        role="status"
        aria-live="polite"
        data-testid="status"
      >
        {statusMessage}
      </p>

      {canPay && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void pay();
          }}
        >
          <fieldset>
            <legend>{t.methodLegend}</legend>
            {METHOD_TOKENS.map((m) => (
              <label key={m.token} className="method">
                <input
                  type="radio"
                  name="method"
                  value={m.token}
                  checked={token === m.token}
                  onChange={() => setToken(m.token)}
                />
                <span>{t[m.key]}</span>
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={phase === 'paying'} className="pay">
            {phase === 'paying' ? t.paying : t.pay}
          </button>
        </form>
      )}

      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
