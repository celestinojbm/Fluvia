'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { displayExponent, formatAmount, type Locale } from '../messages';
import type { Merchant } from './api';
import { CopyUrlButton } from './copy-button';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './csrf-header';
import {
  classifySale,
  isTerminalPhase,
  UUID_RE,
  type PosCheckoutOpened,
  type PosSaleStatus,
  type SalePhase,
} from './pos-contract';
import { parseMajorAmount, POS_CURRENCIES } from './pos-money';
import { POS_MESSAGES, posErrorText } from './pos-messages';

/**
 * Terminal POS sandbox (cliente). Una venta a la vez:
 *   entrada → crear venta (payment link, idempotente) → abrir checkout →
 *   presentar al cliente → seguir el estado hasta un desenlace verificado.
 *
 * Garantías de UX sobre dinero (aunque sea simulado):
 *  - Doble envío imposible: candado síncrono (ref) + controles deshabilitados.
 *  - Crear la venta usa UNA `Idempotency-Key` por borrador: reintentar tras un
 *    resultado incierto no duplica; editar el borrador genera otra key.
 *  - Abrir el checkout NO es idempotente en la API: un resultado incierto se
 *    muestra como tal y solo se repite por acción EXPLÍCITA del operador.
 *  - El estado mostrado sale SIEMPRE de la API (sesión + intent); un fallo de
 *    lectura nunca se presenta como estado del pago.
 */

const POLL_MS = 2500;
const MAX_POLLS = 240; // ~10 min
const MAX_POLL_ERRORS = 5;

type Step =
  | { kind: 'entry' }
  | { kind: 'creating' }
  | { kind: 'create_failed'; code?: string }
  | { kind: 'create_uncertain' }
  | { kind: 'opening'; linkId: string }
  | { kind: 'open_failed'; linkId: string; code?: string }
  | { kind: 'open_uncertain'; linkId: string }
  | { kind: 'tracking'; linkId: string | null; sessionId: string; checkoutUrl: string | null };

type Poll =
  | { kind: 'idle' }
  | { kind: 'ok' }
  | { kind: 'retrying' }
  | { kind: 'stopped' }
  | { kind: 'not_found' }
  | { kind: 'auth_lost' };

type CallResult =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'http'; status: number; code?: string }
  | { kind: 'network' };

async function call(url: string, init?: RequestInit): Promise<CallResult> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    return { kind: 'network' };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* sin JSON */
  }
  if (res.ok) return { kind: 'ok', status: res.status, body };
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return { kind: 'http', status: res.status, code: typeof code === 'string' ? code : undefined };
}

function timeOf(iso: string, locale: Locale): string {
  try {
    return new Date(iso).toLocaleTimeString(locale === 'en' ? 'en-US' : 'es-CO');
  } catch {
    return iso;
  }
}

function dateTimeOf(iso: string, locale: Locale): string {
  try {
    return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'es-CO');
  } catch {
    return iso;
  }
}

function posHref(orgId: string, locale: Locale, sessionId?: string, linkId?: string | null) {
  const q = new URLSearchParams();
  if (locale === 'en') q.set('lang', 'en');
  if (sessionId) q.set('session', sessionId);
  if (linkId) q.set('link', linkId);
  const s = q.toString();
  return `/o/${orgId}/pos${s ? `?${s}` : ''}`;
}

export interface PosTerminalProps {
  orgId: string;
  locale: Locale;
  merchants: Merchant[];
  canCharge: boolean;
  /** Reanudar el seguimiento tras recargar (`?session=&link=`). */
  resume?: { sessionId: string; linkId: string | null };
}

export function PosTerminal({ orgId, locale, merchants, canCharge, resume }: PosTerminalProps) {
  const t = POS_MESSAGES[locale];
  const org = encodeURIComponent(orgId);

  const [merchantId, setMerchantId] = useState(merchants[0]?.id ?? '');
  const merchant = merchants.find((m) => m.id === merchantId);
  const [currency, setCurrency] = useState<string>(merchants[0]?.defaultCurrency ?? 'USD');
  const [amountText, setAmountText] = useState('');
  const [concept, setConcept] = useState('');
  const [showAmountError, setShowAmountError] = useState(false);

  const [step, setStep] = useState<Step>(
    resume
      ? { kind: 'tracking', linkId: resume.linkId, sessionId: resume.sessionId, checkoutUrl: null }
      : { kind: 'entry' }
  );
  const [status, setStatus] = useState<PosSaleStatus | null>(null);
  const [poll, setPoll] = useState<Poll>({ kind: 'idle' });
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [pollNonce, setPollNonce] = useState(0);

  const inFlight = useRef(false);
  const idem = useRef<{ key: string; fingerprint: string } | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const statusHeadingRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => parseMajorAmount(amountText, currency), [amountText, currency]);
  const exponent = displayExponent(currency);
  const formatted = parsed.ok ? formatAmount(parsed.minor, currency, locale) : null;
  const currencies = useMemo(() => {
    const list: string[] = [...POS_CURRENCIES];
    if (merchant && !list.includes(merchant.defaultCurrency))
      list.unshift(merchant.defaultCurrency);
    return list;
  }, [merchant]);

  const busy = step.kind === 'creating' || step.kind === 'opening';

  // Foco a la alerta/estado al cambiar de paso (teclado y lector de pantalla).
  useEffect(() => {
    if (step.kind === 'tracking') statusHeadingRef.current?.focus();
    else if (
      step.kind === 'create_failed' ||
      step.kind === 'create_uncertain' ||
      step.kind === 'open_failed' ||
      step.kind === 'open_uncertain'
    ) {
      alertRef.current?.focus();
    }
  }, [step.kind]);

  const openCheckout = useCallback(
    async (linkId: string) => {
      setStep({ kind: 'opening', linkId });
      const r = await call(`/api/orgs/${org}/pos/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
        body: JSON.stringify({ payment_link_id: linkId }),
      });
      if (r.kind === 'ok') {
        const body = r.body as Partial<PosCheckoutOpened> | null;
        const sid = body?.checkout_session_id;
        const url = body?.checkout_url;
        if (
          r.status === 201 &&
          typeof sid === 'string' &&
          UUID_RE.test(sid) &&
          typeof url === 'string'
        ) {
          setStatus(null);
          setPoll({ kind: 'idle' });
          setLastChecked(null);
          setStep({ kind: 'tracking', linkId, sessionId: sid, checkoutUrl: url });
          try {
            window.history.replaceState(null, '', posHref(orgId, locale, sid, linkId));
          } catch {
            /* sin history: el seguimiento sigue en memoria */
          }
          return;
        }
        setStep({ kind: 'open_uncertain', linkId });
        return;
      }
      if (r.kind === 'network' || r.status >= 500) {
        setStep({ kind: 'open_uncertain', linkId });
        return;
      }
      setStep({ kind: 'open_failed', linkId, code: r.code });
    },
    [org, orgId, locale]
  );

  const createSale = useCallback(async () => {
    if (inFlight.current) return;
    if (!parsed.ok || !merchantId) {
      setShowAmountError(true);
      amountRef.current?.focus();
      return;
    }
    inFlight.current = true;
    try {
      const payload = {
        merchant_id: merchantId,
        amount: parsed.minor,
        currency,
        ...(concept.trim() ? { description: concept.trim() } : {}),
      };
      const fingerprint = JSON.stringify(payload);
      if (!idem.current || idem.current.fingerprint !== fingerprint) {
        idem.current = { key: crypto.randomUUID(), fingerprint };
      }
      setStep({ kind: 'creating' });
      const r = await call(`/api/orgs/${org}/payment-links`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idem.current.key,
          [CSRF_HEADER]: CSRF_HEADER_VALUE,
        },
        body: fingerprint,
      });
      if (r.kind === 'ok') {
        const id = (r.body as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && UUID_RE.test(id)) {
          await openCheckout(id);
          return;
        }
        setStep({ kind: 'create_uncertain' });
        return;
      }
      if (r.kind === 'network' || r.status >= 500) {
        setStep({ kind: 'create_uncertain' });
        return;
      }
      if (r.code === 'idempotency_key_reuse') idem.current = null;
      setStep({ kind: 'create_failed', code: r.code });
    } finally {
      inFlight.current = false;
    }
  }, [parsed, merchantId, currency, concept, org, openCheckout]);

  const reopen = useCallback(
    async (linkId: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        await openCheckout(linkId);
      } finally {
        inFlight.current = false;
      }
    },
    [openCheckout]
  );

  const newSale = useCallback(() => {
    idem.current = null;
    setAmountText('');
    setConcept('');
    setShowAmountError(false);
    setStatus(null);
    setPoll({ kind: 'idle' });
    setLastChecked(null);
    setStep({ kind: 'entry' });
    try {
      window.history.replaceState(null, '', posHref(orgId, locale));
    } catch {
      /* noop */
    }
    setTimeout(() => amountRef.current?.focus(), 0);
  }, [orgId, locale]);

  // Seguimiento del estado: consulta encadenada (sin solapes) hasta un
  // desenlace terminal, un error persistente o el tope de tiempo.
  const trackingId = step.kind === 'tracking' ? step.sessionId : null;
  useEffect(() => {
    if (!trackingId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    let errors = 0;

    const tick = async () => {
      polls += 1;
      const r = await call(`/api/orgs/${org}/pos/sessions/${encodeURIComponent(trackingId)}`);
      if (cancelled) return;
      if (r.kind === 'ok') {
        errors = 0;
        const s = r.body as PosSaleStatus;
        setStatus(s);
        setLastChecked(new Date().toISOString());
        const phase = classifySale(s.session.status, s.payment.status);
        if (isTerminalPhase(phase)) {
          setPoll({ kind: 'ok' });
          return;
        }
        if (polls >= MAX_POLLS) {
          setPoll({ kind: 'stopped' });
          return;
        }
        setPoll({ kind: 'ok' });
      } else if (r.kind === 'http' && r.status === 404) {
        setPoll({ kind: 'not_found' });
        return;
      } else if (r.kind === 'http' && r.status === 401) {
        setPoll({ kind: 'auth_lost' });
        return;
      } else {
        errors += 1;
        if (errors >= MAX_POLL_ERRORS || polls >= MAX_POLLS) {
          setPoll({ kind: 'stopped' });
          return;
        }
        setPoll({ kind: 'retrying' });
      }
      timer = setTimeout(tick, POLL_MS * Math.min(errors + 1, 4));
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [trackingId, org, pollNonce]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!canCharge && step.kind !== 'tracking') {
    return (
      <section className="card pos-panel" aria-labelledby="pos-norole">
        <h2 id="pos-norole">{t.noRoleTitle}</h2>
        <p>{t.noRoleText}</p>
      </section>
    );
  }
  if (merchants.length === 0 && step.kind !== 'tracking') {
    return (
      <section className="card pos-panel" aria-labelledby="pos-nomerchant">
        <h2 id="pos-nomerchant">{t.noMerchantsTitle}</h2>
        <p>{t.noMerchantsText}</p>
        <a className="btn" href="/onboarding">
          {t.noMerchantsCta}
        </a>
      </section>
    );
  }

  if (step.kind === 'tracking') {
    const phase: SalePhase | null = status
      ? classifySale(status.session.status, status.payment.status)
      : null;
    const linkId = step.linkId;
    const canReopen =
      canCharge &&
      linkId !== null &&
      (phase === 'failed' ||
        phase === 'expired' ||
        phase === 'canceled' ||
        (phase === 'awaiting_payment' && !step.checkoutUrl));
    const tone =
      phase === 'succeeded'
        ? 'ok'
        : phase === 'failed' || phase === 'expired' || phase === 'canceled'
          ? 'bad'
          : phase === 'unknown'
            ? 'warn'
            : 'neutral';
    // Consulta manual: solo cuando el seguimiento automático se detuvo o el
    // estado no es reconocible (los terminales ya no cambian de fase).
    const manualRefresh = poll.kind === 'stopped' || phase === 'unknown';

    return (
      <section className="card pos-panel" aria-labelledby="pos-status-title">
        <h2 id="pos-status-title" ref={statusHeadingRef} tabIndex={-1}>
          {t.statusTitle}
        </h2>

        {status && (
          <p className="pos-amount-display" data-testid="pos-amount">
            {formatAmount(status.payment.amount, status.payment.currency, locale)}
          </p>
        )}

        <div
          className={`pos-status pos-status-${tone}`}
          role="status"
          aria-live="polite"
          data-testid="pos-phase"
          data-phase={phase ?? 'loading'}
        >
          <span className="pos-status-dot" aria-hidden="true" />
          <div>
            <p className="pos-status-label">{phase ? t.phase[phase] : t.refreshing}</p>
            {phase && <p className="pos-status-detail">{t.phaseDetail[phase]}</p>}
            {phase === 'unknown' && status && (
              <p className="pos-status-detail">
                <code>{status.payment.status}</code>
              </p>
            )}
            {status?.payment.failure_code && (phase === 'failed' || phase === 'canceled') && (
              <p className="pos-status-detail">{t.failureCode(status.payment.failure_code)}</p>
            )}
            {phase === 'succeeded' && status && status.payment.amount_refunded > 0 && (
              <p className="pos-status-detail">{t.refundedNote}</p>
            )}
          </div>
        </div>

        {poll.kind === 'retrying' && (
          <p className="hint" role="status">
            {t.pollError}
          </p>
        )}
        {poll.kind === 'stopped' && (
          <p className="error" role="alert">
            {t.pollStopped}
          </p>
        )}
        {poll.kind === 'not_found' && (
          <p className="error" role="alert">
            {t.sessionNotFound}
          </p>
        )}
        {poll.kind === 'auth_lost' && (
          <p className="error" role="alert">
            {t.sessionExpiredLogin} <a href="/login">{t.signInAgain}</a>
          </p>
        )}
        {lastChecked && <p className="hint">{t.lastChecked(timeOf(lastChecked, locale))}</p>}

        {phase !== 'succeeded' &&
          phase !== null &&
          !isTerminalPhase(phase) &&
          (step.checkoutUrl ? (
            <div className="pos-present">
              <h3>{t.presentTitle}</h3>
              <p>{t.presentText}</p>
              <div className="pos-actions">
                <a
                  className="btn btn-primary"
                  href={step.checkoutUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  {t.openCheckout}
                </a>
                <CopyUrlButton url={step.checkoutUrl} locale={locale} />
              </div>
              <p className="pos-url">
                <code>{step.checkoutUrl.split('#')[0]}</code>
              </p>
            </div>
          ) : (
            <p className="hint">{t.urlLostText}</p>
          ))}

        {status && (
          <dl className="kv pos-refs">
            <dt>{t.saleRef}</dt>
            <dd>
              <code>{status.session.id}</code>
            </dd>
            <dt>{t.paymentRef}</dt>
            <dd>
              <code>{status.payment.id}</code>
            </dd>
            {phase !== null && !isTerminalPhase(phase) && (
              <>
                <dt>{t.expiresLabel}</dt>
                <dd>{dateTimeOf(status.session.expires_at, locale)}</dd>
              </>
            )}
          </dl>
        )}

        <div className="pos-actions">
          {canReopen && (
            <button type="button" className="btn" onClick={() => void reopen(linkId!)}>
              {t.newCheckoutForSale}
            </button>
          )}
          {manualRefresh && poll.kind !== 'not_found' && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setPollNonce((n) => n + 1)}
            >
              {t.refreshStatus}
            </button>
          )}
          {status && (
            <a
              className="btn btn-secondary"
              href={`/o/${orgId}/payments/${status.payment.id}${locale === 'en' ? '?lang=en' : ''}`}
            >
              {t.viewPayment}
            </a>
          )}
          {canCharge && (
            <button
              type="button"
              className={phase === 'succeeded' ? 'btn btn-primary' : 'btn btn-secondary'}
              onClick={newSale}
            >
              {t.nextSale}
            </button>
          )}
        </div>
        {phase !== null && !isTerminalPhase(phase) && <p className="hint">{t.noCancelNote}</p>}
      </section>
    );
  }

  // Estados de entrada / creación / apertura / fallos.
  const alert = (() => {
    switch (step.kind) {
      case 'create_failed':
        return (
          <div className="pos-alert pos-alert-bad" role="alert" tabIndex={-1} ref={alertRef}>
            <p>{posErrorText(t, step.code, t.createFailed)}</p>
            {step.code === 'invalid_session' && <a href="/login">{t.signInAgain}</a>}
          </div>
        );
      case 'create_uncertain':
        return (
          <div className="pos-alert pos-alert-warn" role="alert" tabIndex={-1} ref={alertRef}>
            <p className="pos-alert-title">{t.createUncertainTitle}</p>
            <p>{t.createUncertainText}</p>
            <div className="pos-actions">
              <button type="button" className="btn" onClick={() => void createSale()}>
                {t.retrySafe}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStep({ kind: 'entry' })}
              >
                {t.discardDraft}
              </button>
            </div>
          </div>
        );
      case 'open_failed':
        return (
          <div className="pos-alert pos-alert-bad" role="alert" tabIndex={-1} ref={alertRef}>
            <p>{posErrorText(t, step.code, t.openFailed)}</p>
            <div className="pos-actions">
              {step.code !== 'link_unavailable' && step.code !== 'insufficient_permissions' && (
                <button type="button" className="btn" onClick={() => void reopen(step.linkId)}>
                  {t.openAgain}
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={newSale}>
                {t.nextSale}
              </button>
            </div>
          </div>
        );
      case 'open_uncertain':
        return (
          <div className="pos-alert pos-alert-warn" role="alert" tabIndex={-1} ref={alertRef}>
            <p className="pos-alert-title">{t.openUncertainTitle}</p>
            <p>{t.openUncertainText}</p>
            <div className="pos-actions">
              <button type="button" className="btn" onClick={() => void reopen(step.linkId)}>
                {t.openAgain}
              </button>
              <button type="button" className="btn btn-secondary" onClick={newSale}>
                {t.nextSale}
              </button>
            </div>
          </div>
        );
      default:
        return null;
    }
  })();

  // Con la venta creada (o posiblemente creada) el borrador queda bloqueado:
  // editarlo cambiaría la Idempotency-Key y podría duplicar la venta.
  const locked =
    busy ||
    step.kind === 'create_uncertain' ||
    step.kind === 'open_failed' ||
    step.kind === 'open_uncertain';
  const amountInvalid = showAmountError && !parsed.ok;

  return (
    <section className="card pos-panel" aria-labelledby="pos-new-title">
      <h2 id="pos-new-title">{t.newSaleTitle}</h2>
      {alert}
      <form
        className="pos-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void createSale();
        }}
        aria-busy={busy}
      >
        <fieldset disabled={locked}>
          <legend className="sr-only">{t.newSaleTitle}</legend>
          {merchants.length > 1 ? (
            <div className="pos-field">
              <label htmlFor="pos-merchant">{t.merchantLabel}</label>
              <select
                id="pos-merchant"
                value={merchantId}
                onChange={(e) => {
                  setMerchantId(e.target.value);
                  const m = merchants.find((x) => x.id === e.target.value);
                  if (m) setCurrency(m.defaultCurrency);
                }}
              >
                {merchants.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="pos-merchant-static">
              <span className="pos-k">{t.merchantLabel}</span> <strong>{merchant?.name}</strong>
            </p>
          )}

          <div className="pos-amount-row">
            <div className="pos-field pos-field-amount">
              <label htmlFor="pos-amount">{t.amountLabel}</label>
              <input
                id="pos-amount"
                ref={amountRef}
                name="amount"
                inputMode={exponent === 0 ? 'numeric' : 'decimal'}
                autoComplete="off"
                placeholder={exponent === 0 ? '0' : '0.00'}
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                onBlur={() => amountText !== '' && setShowAmountError(true)}
                aria-invalid={amountInvalid}
                aria-describedby="pos-amount-hint pos-amount-error pos-amount-preview"
                autoFocus
              />
            </div>
            <div className="pos-field pos-field-currency">
              <label htmlFor="pos-currency">{t.currencyLabel}</label>
              <select
                id="pos-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p id="pos-amount-hint" className="hint">
            {t.amountHintMinor(exponent)}
          </p>
          <p id="pos-amount-error" className="error pos-field-error" aria-live="polite">
            {amountInvalid && !parsed.ok ? t.amountErrors[parsed.error] : ''}
          </p>
          <p id="pos-amount-preview" className="pos-preview">
            {parsed.ok && formatted ? t.preview(formatted, parsed.minor) : ''}
          </p>

          <div className="pos-field">
            <label htmlFor="pos-concept">{t.conceptLabel}</label>
            <input
              id="pos-concept"
              name="concept"
              maxLength={500}
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              aria-describedby="pos-concept-hint"
            />
            <p id="pos-concept-hint" className="hint">
              {t.conceptHint}
            </p>
          </div>

          <button type="submit" className="btn btn-primary pos-charge" disabled={busy}>
            {step.kind === 'creating'
              ? t.creatingSale
              : step.kind === 'opening'
                ? t.openingCheckout
                : formatted
                  ? t.charge(formatted)
                  : t.chargeIdle}
          </button>
        </fieldset>
      </form>
    </section>
  );
}
