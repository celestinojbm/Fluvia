'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FluviaSymbol } from './brand';
import { formatAmount, MESSAGES, type Locale } from './messages';
import { InstallmentsOption, OrderSummary, PlanBox, type CheckoutOrderView } from './order-panels';

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
  /** Venta de cobro único ya cobrada/cobrando por OTRO checkout: este no cobra. */
  sale_closed?: boolean;
}

// `uncertain`: el confirm no devolvió una vista válida (red/5xx/4xx). El pago
// pudo haberse procesado: jamás se invita a pagar otra vez sin consultar antes.
type Phase = 'loading' | 'ready' | 'paying' | 'uncertain' | 'error' | 'not_found';

// Pedido de la compra (venta con productos). `none`: venta de importe libre
// (sin pedido); `error`: no se pudo leer — el pago sigue siendo posible.
type OrderRead =
  { kind: 'idle' } | { kind: 'none' } | { kind: 'error' } | { kind: 'ok'; view: CheckoutOrderView };

const PENDING_POLL_MS = 3000;
const PENDING_MAX_POLLS = 40;

const METHOD_TOKENS = [
  { token: 'tok_approve', key: 'methodApprove' as const },
  { token: 'tok_decline', key: 'methodDecline' as const },
  { token: 'tok_pse', key: 'methodAsync' as const },
  { token: 'fluvia_personal', key: 'methodFluvia' as const },
];
const FLUVIA_CODE_RE = /^fcp_[0-9a-f]{64}$/;

export function CheckoutClient({ sessionId, locale }: { sessionId: string; locale: Locale }) {
  const t = MESSAGES[locale];
  const [phase, setPhase] = useState<Phase>('loading');
  const [view, setView] = useState<HostedView | null>(null);
  const [token, setToken] = useState('tok_approve');
  const [fluviaCode, setFluviaCode] = useState('');
  const [codeError, setCodeError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [order, setOrder] = useState<OrderRead>({ kind: 'idle' });
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
    try {
      const r = await fetch(`/api/checkout/${sessionId}/order`, {
        headers: { 'x-checkout-client-secret': clientSecret() },
      });
      if (r.status === 404) setOrder({ kind: 'none' });
      else if (!r.ok) setOrder({ kind: 'error' });
      else {
        const body = (await r.json()) as Partial<CheckoutOrderView> | null;
        // Forma inesperada ⇒ se trata como venta sin pedido (no rompe el pago).
        setOrder(
          body && body.order && Array.isArray(body.order.lines) && body.installments
            ? { kind: 'ok', view: body as CheckoutOrderView }
            : { kind: 'none' }
        );
      }
    } catch {
      setOrder({ kind: 'error' });
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
    const methodToken = token === 'fluvia_personal' ? fluviaCode.trim() : token;
    if (token === 'fluvia_personal' && !FLUVIA_CODE_RE.test(methodToken)) {
      setCodeError(true);
      return;
    }
    setCodeError(false);
    payingRef.current = true;
    setPhase('paying');
    try {
      const res = await fetch(`/api/checkout/${sessionId}/confirm`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-checkout-client-secret': clientSecret(),
        },
        body: JSON.stringify({ payment_method_token: methodToken }),
      });
      if (res.status === 404) return setPhase('not_found');
      if (res.status === 409) {
        // Rechazo CIERTO del servidor (nada se envió al proveedor): la venta ya
        // tiene otro pago. Se relee la vista, que lo explica sin formulario.
        const code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)
          ?.error?.code;
        if (
          code === 'sale_already_charged' ||
          code === 'installment_plan_active' ||
          code === 'order_cancelled'
        ) {
          await load();
          statusRef.current?.focus();
          return;
        }
      }
      if (!res.ok) return setPhase('uncertain');
      setView((await res.json()) as HostedView);
      setPhase('ready');
      statusRef.current?.focus();
    } catch {
      setPhase('uncertain');
    } finally {
      payingRef.current = false;
    }
  }, [sessionId, token, fluviaCode, clientSecret, load]);

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
  const saleClosed = view.status === 'open' && !failed && !pending && view.sale_closed === true;
  const orderView = order.kind === 'ok' ? order.view : null;
  const plan = orderView?.installments.plan ?? null;
  // Plan de cuotas SIMULADO vivo: la compra no se paga con otro método (lo
  // impide el servidor) y tampoco queda pagada.
  const planActive = plan !== null && plan.status !== 'declined';
  const cancelled = orderView?.order.cancelled === true && !done;
  const canPay =
    view.status === 'open' && !failed && !pending && !saleClosed && !planActive && !cancelled;
  const planHref = `/c/${sessionId}/cuotas${locale === 'en' ? '?lang=en' : ''}#${encodeURIComponent(clientSecret())}`;

  let statusMessage = t.statusOpen;
  if (done) statusMessage = t.statusCompleted;
  else if (expired) statusMessage = t.statusExpired;
  else if (failed) statusMessage = t.paymentFailed;
  else if (pending) statusMessage = t.paymentPending;
  else if (cancelled) statusMessage = t.saleCancelled;
  else if (saleClosed) statusMessage = t.saleClosed;
  const tone = done
    ? 'ok'
    : expired || failed
      ? 'bad'
      : saleClosed || cancelled || pending
        ? 'warn'
        : 'neutral';
  const merchant = orderView?.order.merchant_name ?? null;

  return (
    <main className="checkout" aria-labelledby="checkout-title">
      <header className="co-head">
        <FluviaSymbol size={44} />
        <div>
          {merchant ? (
            <p className="co-merchant">
              <span className="co-muted">{t.payTo}</span> {merchant}
            </p>
          ) : null}
          <h1 id="checkout-title">{t.title}</h1>
        </div>
      </header>

      <p className="amount">
        <span className="amount-label">{t.amountLabel}</span>
        <span className="amount-value" data-testid="amount">
          {formatAmount(view.payment_intent.amount, view.payment_intent.currency, locale, {
            code: true,
          })}
        </span>
      </p>

      <p
        ref={statusRef}
        tabIndex={-1}
        className={`status status-${tone}`}
        role="status"
        aria-live="polite"
        data-testid="status"
      >
        <StatusIcon tone={tone} />
        <span>{statusMessage}</span>
      </p>

      {orderView ? <OrderSummary view={orderView} locale={locale} receipt={done} /> : null}

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

      {plan && !done ? <PlanBox plan={plan} locale={locale} planHref={planHref} /> : null}

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
              <label key={m.token} className="method" data-checked={token === m.token}>
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
          {token === 'fluvia_personal' ? (
            <div className="fluvia-code">
              <label htmlFor="fluvia-code">{t.fluviaCodeLabel}</label>
              <input
                id="fluvia-code"
                name="fluvia_code"
                autoComplete="off"
                spellCheck={false}
                value={fluviaCode}
                onChange={(e) => setFluviaCode(e.target.value)}
                aria-describedby="fluvia-code-hint"
                aria-invalid={codeError}
              />
              <p id="fluvia-code-hint" className="co-muted">
                {t.fluviaCodeHint}
              </p>
              {codeError ? (
                <p className="error" role="alert">
                  {t.fluviaCodeInvalid}
                </p>
              ) : null}
            </div>
          ) : null}
          <button type="submit" disabled={phase === 'paying'} className="pay">
            {phase === 'paying' ? t.paying : t.pay}
          </button>
        </form>
      )}

      {canPay && orderView?.installments.eligible ? (
        <InstallmentsOption
          sessionId={sessionId}
          secret={clientSecret}
          view={orderView}
          locale={locale}
          onCreated={() => void recheck()}
        />
      ) : null}

      <footer className="co-foot">
        <p className="notice">{t.sandboxNotice}</p>
        <p className="co-muted co-secured">
          <FluviaSymbol size={16} /> {t.securedBy}
        </p>
      </footer>
    </main>
  );
}

function StatusIcon({ tone }: { tone: 'ok' | 'bad' | 'warn' | 'neutral' }) {
  const d =
    tone === 'ok'
      ? 'M5 12.5 10 17l9-10'
      : tone === 'bad'
        ? 'M6 6l12 12M18 6 6 18'
        : tone === 'warn'
          ? 'M12 3 2 20h20zM12 10v4m0 3v.5'
          : 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2';
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="status-ico"
    >
      <path d={d} />
    </svg>
  );
}
