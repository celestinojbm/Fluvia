'use client';

import { useEffect, useRef, useState } from 'react';
import { INSTALLMENTS_MESSAGES } from './installments-messages';
import { formatAmount, type Locale } from './messages';

/** Contrato de `GET /v1/checkout_sessions/:id/order` (ver apps/api commerce.ts). */
export interface CheckoutOrderView {
  order: {
    number: number;
    merchant_name: string | null;
    currency: string;
    total: number;
    lines: Array<{
      position: number;
      name: string;
      unit_price: number;
      quantity: number;
      line_total: number;
    }>;
  };
  installments: {
    simulated: true;
    eligible: boolean;
    ineligible_reason: 'sale_charged' | 'plan_exists' | 'checkout_closed' | null;
    allowed_counts: number[];
    interval_days: number;
    terms_version: string;
    plan: BuyerPlan | null;
  };
}

export interface BuyerPlan {
  id: string;
  status: 'pending' | 'approved' | 'declined';
  currency: string;
  total: number;
  installments_count: number;
  interval_days: number;
  terms_version: string;
  installments: Array<{
    seq: number;
    amount: number;
    due_date: string;
    status: 'scheduled' | 'paid_simulated' | 'overdue_simulated';
  }>;
  events: Array<{ kind: string; seq: number | null; created_at: string }>;
}

interface Quote {
  count: number;
  currency: string;
  total: number;
  initial_amount: number;
  interval_days: number;
  terms_version: string;
  schedule: Array<{ seq: number; amount: number; due_date: string }>;
}

function dateLabel(iso: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-CO', {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
  } catch {
    return iso;
  }
}

export function OrderSummary({
  view,
  locale,
  receipt,
}: {
  view: CheckoutOrderView;
  locale: Locale;
  receipt: boolean;
}) {
  const t = INSTALLMENTS_MESSAGES[locale];
  const o = view.order;
  const fmt = (v: number) => formatAmount(v, o.currency, locale);
  return (
    <section className="order" aria-labelledby="order-title">
      <h2 id="order-title">{receipt ? t.receiptTitle : t.summaryTitle}</h2>
      <p className="order-meta">
        {o.merchant_name ? `${o.merchant_name} · ` : ''}
        {t.orderNumber(o.number)}
      </p>
      <table className="order-lines">
        <caption className="sr-only">{t.summaryTitle}</caption>
        <thead>
          <tr>
            <th scope="col">{t.product}</th>
            <th scope="col" className="num">
              {t.qty}
            </th>
            <th scope="col" className="num">
              {t.lineTotal}
            </th>
          </tr>
        </thead>
        <tbody>
          {o.lines.map((l) => (
            <tr key={l.position}>
              <td>
                {l.name}
                <span className="order-sub">
                  {fmt(l.unit_price)} {locale === 'en' ? 'each' : 'c/u'}
                </span>
              </td>
              <td className="num">{l.quantity}</td>
              <td className="num">{fmt(l.line_total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>{t.total}</td>
            <td className="num">{fmt(o.total)}</td>
          </tr>
        </tfoot>
      </table>
      {receipt ? (
        <div className="order-receipt">
          <p className="order-sub">{t.receiptNote}</p>
          <button type="button" className="secondary no-print" onClick={() => window.print()}>
            {t.print}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function PlanSchedule({ plan, locale }: { plan: BuyerPlan; locale: Locale }) {
  const t = INSTALLMENTS_MESSAGES[locale];
  const label = { scheduled: t.statusScheduled, paid_simulated: t.statusPaid, overdue_simulated: t.statusOverdue };
  return (
    <ol className="schedule">
      {plan.installments.map((i) => (
        <li key={i.seq} data-status={i.status}>
          <span>
            <strong>{i.seq === 1 ? t.initial : t.installment(i.seq)}</strong>
            <span className="order-sub">
              {t.due(dateLabel(i.due_date, locale))} · {label[i.status]}
            </span>
          </span>
          <span className="num">{formatAmount(i.amount, plan.currency, locale)}</span>
        </li>
      ))}
    </ol>
  );
}

export function PlanBox({
  plan,
  locale,
  planHref,
}: {
  plan: BuyerPlan;
  locale: Locale;
  planHref: string;
}) {
  const t = INSTALLMENTS_MESSAGES[locale];
  const msg =
    plan.status === 'approved' ? t.planApproved : plan.status === 'declined' ? t.planDeclined : t.planPending;
  return (
    <section className="plan" aria-labelledby="plan-title" data-status={plan.status}>
      <h2 id="plan-title">{t.planTitle}</h2>
      <p className={`status status-${plan.status === 'declined' ? 'bad' : plan.status === 'approved' ? 'ok' : 'warn'}`} role="status">
        {msg}
      </p>
      {plan.status !== 'declined' ? (
        <>
          <p className="sim-note">{t.planNotPaid}</p>
          <PlanSchedule plan={plan} locale={locale} />
          <p className="order-sub">{t.cardBlocked}</p>
        </>
      ) : null}
      <a className="link-btn" href={planHref}>
        {t.planLink}
      </a>
    </section>
  );
}

type QuoteState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; quote: Quote } | { kind: 'error' };
type Submit = { kind: 'idle' } | { kind: 'sending' } | { kind: 'uncertain' } | { kind: 'not_allowed' };

/**
 * Elección de cuotas con confirmación EXPLÍCITA. La cotización la calcula el
 * servidor (reparto exacto); el escenario de prueba decide el proveedor
 * simulado. Doble envío bloqueado; un resultado incierto no se reintenta solo.
 */
export function InstallmentsOption({
  sessionId,
  secret,
  view,
  locale,
  onCreated,
}: {
  sessionId: string;
  secret: () => string;
  view: CheckoutOrderView;
  locale: Locale;
  onCreated: () => void;
}) {
  const t = INSTALLMENTS_MESSAGES[locale];
  const counts = view.installments.allowed_counts;
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(counts.includes(4) ? 4 : (counts[0] ?? 3));
  const [quote, setQuote] = useState<QuoteState>({ kind: 'idle' });
  const [scenario, setScenario] = useState<'approve' | 'decline' | 'pending'>('approve');
  const [accepted, setAccepted] = useState(false);
  const [showAcceptError, setShowAcceptError] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ kind: 'idle' });
  const lock = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQuote({ kind: 'loading' });
    void (async () => {
      try {
        const res = await fetch(`/api/checkout/${sessionId}/installments/quote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-checkout-client-secret': secret() },
          body: JSON.stringify({ count }),
        });
        if (cancelled) return;
        if (!res.ok) return setQuote({ kind: 'error' });
        setQuote({ kind: 'ok', quote: (await res.json()) as Quote });
      } catch {
        if (!cancelled) setQuote({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, count, sessionId, secret]);

  async function confirm() {
    if (!accepted) {
      setShowAcceptError(true);
      return;
    }
    if (lock.current || quote.kind !== 'ok') return;
    lock.current = true;
    setSubmit({ kind: 'sending' });
    try {
      const res = await fetch(`/api/checkout/${sessionId}/installments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-checkout-client-secret': secret() },
        body: JSON.stringify({ count, scenario, accept_terms: true }),
      });
      if (res.ok) {
        setSubmit({ kind: 'idle' });
        onCreated();
        return;
      }
      if (res.status === 409) {
        setSubmit({ kind: 'not_allowed' });
        onCreated();
        return;
      }
      setSubmit({ kind: 'uncertain' });
    } catch {
      setSubmit({ kind: 'uncertain' });
    } finally {
      lock.current = false;
      setTimeout(() => alertRef.current?.focus(), 0);
    }
  }

  return (
    <section className="installments" aria-labelledby="inst-title">
      <h2 id="inst-title">
        {t.optionTitle} <span className="sim-pill">{locale === 'en' ? 'Simulation' : 'Simulación'}</span>
      </h2>
      <p className="sim-note">{t.optionSim}</p>
      <button
        type="button"
        className="secondary"
        aria-expanded={open}
        aria-controls="inst-body"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t.optionClose : t.optionOpen}
      </button>
      {open ? (
        <div id="inst-body">
          <fieldset>
            <legend>{t.countLegend}</legend>
            {counts.map((n) => (
              <label key={n} className="method">
                <input
                  type="radio"
                  name="inst-count"
                  value={n}
                  checked={count === n}
                  onChange={() => setCount(n)}
                />
                <span>{t.countOption(n, view.installments.interval_days)}</span>
              </label>
            ))}
          </fieldset>
          <div aria-live="polite">
            {quote.kind === 'loading' ? <p className="order-sub">{t.quoteLoading}</p> : null}
            {quote.kind === 'error' ? (
              <p className="error" role="alert">
                {t.quoteError}
              </p>
            ) : null}
            {quote.kind === 'ok' ? (
              <>
                <PlanSchedule
                  locale={locale}
                  plan={{
                    id: 'quote',
                    status: 'pending',
                    currency: quote.quote.currency,
                    total: quote.quote.total,
                    installments_count: quote.quote.count,
                    interval_days: quote.quote.interval_days,
                    terms_version: quote.quote.terms_version,
                    installments: quote.quote.schedule.map((s) => ({ ...s, status: 'scheduled' as const })),
                    events: [],
                  }}
                />
                <p className="amount">
                  <span className="amount-label">{t.total}</span>
                  <span className="amount-value">
                    {formatAmount(quote.quote.total, quote.quote.currency, locale)}
                  </span>
                </p>
                <p className="order-sub">{t.conditions(quote.quote.terms_version)}</p>
              </>
            ) : null}
          </div>
          <fieldset>
            <legend>{t.scenarioLegend}</legend>
            {(
              [
                ['approve', t.scenarioApprove],
                ['decline', t.scenarioDecline],
                ['pending', t.scenarioPending],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="method">
                <input
                  type="radio"
                  name="inst-scenario"
                  value={v}
                  checked={scenario === v}
                  onChange={() => setScenario(v)}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <label className="accept">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => {
                setAccepted(e.target.checked);
                if (e.target.checked) setShowAcceptError(false);
              }}
              aria-invalid={showAcceptError ? true : undefined}
              aria-describedby={showAcceptError ? 'accept-err' : undefined}
            />
            <span>{t.accept}</span>
          </label>
          {showAcceptError ? (
            <p id="accept-err" className="error">
              {t.acceptRequired}
            </p>
          ) : null}
          <div ref={alertRef} tabIndex={-1}>
            {submit.kind === 'uncertain' ? (
              <p className="status status-warn" role="alert">
                {t.uncertain}
              </p>
            ) : null}
            {submit.kind === 'not_allowed' ? (
              <p className="status status-warn" role="alert">
                {t.notAllowed}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="pay"
            onClick={() => void confirm()}
            disabled={submit.kind === 'sending' || quote.kind !== 'ok'}
          >
            {submit.kind === 'sending' ? t.confirming : t.confirm}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function PlanTimeline({ plan, locale }: { plan: BuyerPlan; locale: Locale }) {
  const t = INSTALLMENTS_MESSAGES[locale];
  return (
    <section aria-labelledby="ev-title">
      <h2 id="ev-title">{t.eventsTitle}</h2>
      <ol className="events">
        {plan.events.map((e, i) => (
          <li key={i}>
            {t.event[e.kind] ?? e.kind}
            {e.seq ? ` · ${t.installment(e.seq)}` : ''}
            <span className="order-sub">
              {new Date(e.created_at).toLocaleString(locale === 'en' ? 'en-US' : 'es-CO', { timeZone: 'UTC' })} UTC
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
