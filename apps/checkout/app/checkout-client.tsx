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

// `uncertain`: el confirm no devolvió una vista válida (red/5xx/4xx). El pago
// pudo haberse procesado: jamás se invita a pagar otra vez sin consultar antes.
type Phase = 'loading' | 'ready' | 'paying' | 'uncertain' | 'error' | 'not_found';

const PENDING_POLL_MS = 3000;
const PENDING_MAX_POLLS = 40;

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
  const [checking, setChecking] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const payingRef = useRef(false);

  const clientSecret = useCallback(() => {
    if (typeof window === 'undefined') return '';
    return decodeURIComponent(window.location.hash.replace(/^#/, ''));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/checkout/${sessionId}/status`, {
        headers: { 'x-checkout-client-secret': clientSecret() },
      });
      // 400 = id con formato inválido: para el comprador es un enlace inválido.
      if (res.status === 404 || res.status === 400) return setPhase('not_found');
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

  const recheck = useCallback(async () => {
    setChecking(true);
    await load();
    setChecking(false);
    statusRef.current?.focus();
  }, [load]);

  const pay = useCallback(async () => {
    // Candado síncrono: un doble envío no genera dos confirmaciones.
    if (payingRef.current) return;
    payingRef.current = true;
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
      if (!res.ok) return setPhase('uncertain');
      setView((await res.json()) as HostedView);
      setPhase('ready');
      statusRef.current?.focus();
    } catch {
      setPhase('uncertain');
    } finally {
      payingRef.current = false;
    }
  }, [sessionId, token, clientSecret]);

  // Pago asíncrono en curso: se re-consulta el estado (acotado) hasta que el
  // proveedor simulado lo resuelva; nunca se asume el desenlace.
  const pendingNow =
    phase === 'ready' &&
    view?.status === 'open' &&
    (view.payment_intent.status === 'processing' || view.payment_intent.status === 'submitted');
  const pendingPolls = useRef(0);
  useEffect(() => {
    if (!pendingNow) {
      pendingPolls.current = 0;
      return;
    }
    if (pendingPolls.current >= PENDING_MAX_POLLS) return;
    const timer = setTimeout(() => {
      pendingPolls.current += 1;
      void load();
    }, PENDING_POLL_MS);
    return () => clearTimeout(timer);
  }, [pendingNow, view, load]);

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
  if (phase === 'uncertain') {
    return (
      <main className="checkout">
        <h1>{t.title}</h1>
        <p className="status status-warn" role="alert">
          {t.paymentUncertain}
        </p>
        <button type="button" className="pay" onClick={() => void recheck()} disabled={checking}>
          {checking ? t.checking : t.checkStatus}
        </button>
        <p className="notice">{t.sandboxNotice}</p>
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
        <button type="button" className="pay" onClick={() => void recheck()} disabled={checking}>
          {checking ? t.checking : t.retry}
        </button>
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

      {pending && (
        <button
          type="button"
          className="secondary"
          onClick={() => void recheck()}
          disabled={checking}
        >
          {checking ? t.checking : t.checkStatus}
        </button>
      )}

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
