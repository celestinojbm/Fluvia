'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { displayExponent, formatAmount, type Locale } from '../messages';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './csrf-header';
import type { PosSaleStatus } from './pos-contract';
import { parseMajorAmount } from './pos-money';
import {
  isRefundableStatus,
  pickRefund,
  pickRefundList,
  REFUND_TERMINAL,
  summarizeRefunds,
  type PosRefund,
  type PosRefundList,
} from './pos-refund-contract';
import { POS_REFUND_MESSAGES, refundErrorText } from './pos-refund-messages';

/**
 * Devolución de un cobro del POS (cliente). Recorrido:
 *   cobro aprobado → «Devolver…» → total o parcial (+ motivo) → confirmar →
 *   registrar (idempotente) → seguir el desenlace hasta que el API lo cierre.
 *
 * Garantías sobre el dinero (aunque sea simulado):
 *  - El cupo sale del SERVIDOR (intent + lista de refunds) y es conservador:
 *    una devolución en curso o sin confirmar bloquea registrar otra.
 *  - Se envía SIEMPRE el importe confirmado (también en «todo»): si el cupo
 *    cambió entretanto, el API responde 422 en vez de devolver otra cifra.
 *  - UNA `Idempotency-Key` por borrador (importe + motivo): reintentar tras un
 *    resultado incierto no duplica; el borrador queda bloqueado mientras tanto.
 *  - Candado síncrono contra el doble envío.
 *  - Devolver NO libera la venta (0046): el terminal sigue en «aprobado» y no
 *    ofrece recuperar ni abrir otro checkout.
 */

type Read = { kind: 'loading' } | { kind: 'ok'; list: PosRefundList } | { kind: 'error' };

type Step =
  | { kind: 'closed' }
  | { kind: 'form' }
  | { kind: 'confirm'; amount: number }
  | { kind: 'submitting'; amount: number }
  | { kind: 'uncertain'; amount: number }
  | { kind: 'failed'; amount: number; code?: string }
  | { kind: 'tracking'; refundId: string };

const POLL_MS = 2_000;
const MAX_POLLS = 20;

type CallResult =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'http'; status: number; code?: string }
  | { kind: 'network' };

async function call(url: string, init?: RequestInit): Promise<CallResult> {
  try {
    const res = await fetch(url, { cache: 'no-store', ...init });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* sin JSON */
    }
    if (res.ok) return { kind: 'ok', status: res.status, body };
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return { kind: 'http', status: res.status, code: typeof code === 'string' ? code : undefined };
  } catch {
    return { kind: 'network' };
  }
}

function when(iso: string, locale: Locale): string {
  try {
    return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'es-CO', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

export interface PosRefundPanelProps {
  orgId: string;
  locale: Locale;
  payment: PosSaleStatus['payment'];
  /** Rol con `reconciliation:manage` (hint de UX; el API decide). */
  canRefund: boolean;
  /** La última lectura del cobro fue correcta. */
  verified: boolean;
  /** Algo cambió en el servidor (refund registrado o cerrado): releer el cobro. */
  onChanged?: () => void;
}

export function PosRefundPanel({
  orgId,
  locale,
  payment,
  canRefund,
  verified,
  onChanged,
}: PosRefundPanelProps) {
  const t = POS_REFUND_MESSAGES[locale];
  const org = encodeURIComponent(orgId);
  const money = (minor: number) => formatAmount(minor, payment.currency, locale);

  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [readNonce, setReadNonce] = useState(0);
  const [step, setStep] = useState<Step>({ kind: 'closed' });
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const [showAmountError, setShowAmountError] = useState(false);

  const inFlight = useRef(false);
  const idem = useRef<{ key: string; fingerprint: string } | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  // Lectura de las devoluciones: al montar, cuando cambia el cobro leído y a
  // demanda. Todo o nada (el BFF invalida listas incompletas).
  const refundsUrl = `/api/orgs/${org}/pos/payments/${encodeURIComponent(payment.id)}/refunds`;
  useEffect(() => {
    let cancelled = false;
    void call(refundsUrl).then((r) => {
      if (cancelled) return;
      const list = r.kind === 'ok' ? pickRefundList(r.body, payment.id) : null;
      setRead(list ? { kind: 'ok', list } : { kind: 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [refundsUrl, payment.id, payment.status, payment.amount_refunded, readNonce]);

  // Seguimiento de la devolución registrada hasta un desenlace del API.
  const trackingId = step.kind === 'tracking' ? step.refundId : null;
  const tracked =
    trackingId && read.kind === 'ok'
      ? (read.list.refunds.find((r) => r.id === trackingId) ?? null)
      : null;
  const trackedStatus = tracked?.status ?? null;
  const polls = useRef(0);
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (!trackingId) return;
    if (
      trackedStatus &&
      (REFUND_TERMINAL.has(trackedStatus) || trackedStatus === 'indeterminate')
    ) {
      // Una sola relectura del cobro por desenlace (amount_refunded / estado).
      if (notified.current !== trackingId) {
        notified.current = trackingId;
        onChangedRef.current?.();
      }
      return;
    }
    if (polls.current >= MAX_POLLS) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      setReadNonce((n) => n + 1);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [trackingId, trackedStatus, read]);

  const list = read.kind === 'ok' ? read.list : null;
  const captured = payment.amount_captured;
  const summary = useMemo(
    () =>
      list && captured !== null
        ? summarizeRefunds(
            { amount_captured: captured, amount_refunded: payment.amount_refunded },
            list.refunds
          )
        : null,
    [list, captured, payment.amount_refunded]
  );

  const exponent = displayExponent(payment.currency);
  const parsed = useMemo(
    () => parseMajorAmount(amountText, payment.currency),
    [amountText, payment.currency]
  );
  const remaining = summary?.remaining ?? 0;
  const draftAmount = mode === 'full' ? remaining : parsed.ok ? parsed.minor : null;
  const amountError: string | null =
    mode === 'full'
      ? null
      : !parsed.ok
        ? t.amountErrors[parsed.error]
        : parsed.minor > remaining
          ? t.amountErrors.over_remaining(money(remaining))
          : null;

  // Por qué no se ofrece devolver (texto único para el cajero).
  const blockReason: string | null = !canRefund
    ? t.noRole
    : !verified
      ? t.notVerified
      : captured === null
        ? t.noCaptured
        : !list || !summary
          ? null
          : list.truncated
            ? t.listTruncated
            : summary.uncertain
              ? t.uncertainBlock
              : summary.open
                ? t.openBlock
                : payment.status === 'refunded' || summary.remaining === 0
                  ? t.fullyRefunded
                  : null;
  const canStart =
    canRefund &&
    verified &&
    isRefundableStatus(payment.status) &&
    !!summary &&
    !!list &&
    !list.truncated &&
    !summary.open &&
    summary.remaining > 0;

  const submit = useCallback(
    async (amount: number) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const payload = {
          payment_intent_id: payment.id,
          amount,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        };
        const fingerprint = JSON.stringify(payload);
        if (!idem.current || idem.current.fingerprint !== fingerprint) {
          idem.current = { key: crypto.randomUUID(), fingerprint };
        }
        setStep({ kind: 'submitting', amount });
        const r = await call(`/api/orgs/${org}/refunds`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idem.current.key,
            [CSRF_HEADER]: CSRF_HEADER_VALUE,
          },
          body: fingerprint,
        });
        if (r.kind === 'ok') {
          const refund = pickRefund(r.body);
          if (refund && refund.payment_intent_id === payment.id) {
            idem.current = null;
            polls.current = 0;
            setStep({ kind: 'tracking', refundId: refund.id });
            setReadNonce((n) => n + 1);
            onChangedRef.current?.();
            return;
          }
          setStep({ kind: 'uncertain', amount });
          return;
        }
        if (r.kind === 'network' || r.status >= 500) {
          setStep({ kind: 'uncertain', amount });
          return;
        }
        if (r.code === 'idempotency_key_reuse') idem.current = null;
        setStep({ kind: 'failed', amount, code: r.code });
        // El servidor pudo cambiar (otra devolución, estado del cobro).
        setReadNonce((n) => n + 1);
      } finally {
        inFlight.current = false;
      }
    },
    [org, payment.id, reason]
  );

  const reset = useCallback(() => {
    setStep({ kind: 'closed' });
    setMode('full');
    setAmountText('');
    setReason('');
    setShowAmountError(false);
  }, []);

  const refunds = list?.refunds ?? [];
  const locked = step.kind === 'submitting' || step.kind === 'uncertain' || step.kind === 'confirm';

  return (
    <section className="pos-refund" aria-labelledby="pos-refund-title" data-testid="pos-refund">
      <h3 id="pos-refund-title">{t.title}</h3>
      <p className="hint">{t.intro}</p>

      {read.kind === 'loading' && <p className="hint">{t.loading}</p>}
      {read.kind === 'error' && (
        <div className="pos-alert pos-alert-bad" role="alert">
          <p>{t.loadError}</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setReadNonce((n) => n + 1)}
          >
            {t.retry}
          </button>
        </div>
      )}

      {summary && (
        <dl className="kv pos-refund-summary" data-testid="pos-refund-summary">
          <dt>{t.summaryCaptured}</dt>
          <dd>{money(summary.captured)}</dd>
          <dt>{t.summaryRefunded}</dt>
          <dd>{money(summary.refunded)}</dd>
          {summary.pending > 0 && (
            <>
              <dt>{t.summaryPending}</dt>
              <dd>{money(summary.pending)}</dd>
            </>
          )}
          <dt>{t.summaryRemaining}</dt>
          <dd>
            <strong>{money(summary.remaining)}</strong>
          </dd>
        </dl>
      )}

      {tracked && (
        <div
          className={`pos-alert ${tracked.status === 'succeeded' ? 'pos-alert-ok' : tracked.status === 'failed' || tracked.status === 'canceled' ? 'pos-alert-bad' : 'pos-alert-warn'}`}
          role="status"
          data-testid="pos-refund-result"
          data-status={tracked.status}
        >
          <p className="pos-alert-title">{t.resultTitle[tracked.status]}</p>
          <p>
            {money(tracked.amount)} · {t.statusDetail[tracked.status]}
          </p>
          {tracked.failure_code && (
            <p>{t.failureReasons[tracked.failure_code] ?? t.failureCode(tracked.failure_code)}</p>
          )}
          <p>{t.saleStaysClosed}</p>
        </div>
      )}

      {blockReason && (step.kind === 'closed' || step.kind === 'tracking') && (
        <p className="hint" data-testid="pos-refund-block">
          {blockReason}
        </p>
      )}

      {step.kind === 'closed' || step.kind === 'tracking' ? (
        canStart && (
          <div className="pos-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                reset();
                setStep({ kind: 'form' });
              }}
            >
              {t.start}
            </button>
          </div>
        )
      ) : (
        <form
          className="pos-form pos-refund-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (step.kind !== 'form') return;
            if (draftAmount === null || amountError) {
              setShowAmountError(true);
              return;
            }
            setStep({ kind: 'confirm', amount: draftAmount });
          }}
        >
          <fieldset disabled={locked}>
            <legend>{t.modeLabel}</legend>
            <div className="pos-choice">
              <label>
                <input
                  type="radio"
                  name="pos-refund-mode"
                  value="full"
                  checked={mode === 'full'}
                  onChange={() => setMode('full')}
                />{' '}
                {t.modeFull(money(remaining))}
              </label>
              <label>
                <input
                  type="radio"
                  name="pos-refund-mode"
                  value="partial"
                  checked={mode === 'partial'}
                  onChange={() => setMode('partial')}
                />{' '}
                {t.modePartial}
              </label>
            </div>
            {mode === 'partial' && (
              <div className="pos-field">
                <label htmlFor="pos-refund-amount">{t.amountLabel}</label>
                <input
                  id="pos-refund-amount"
                  name="refund-amount"
                  inputMode={exponent === 0 ? 'numeric' : 'decimal'}
                  autoComplete="off"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  aria-invalid={showAmountError && !!amountError}
                  aria-describedby="pos-refund-amount-hint pos-refund-amount-error"
                />
                <p id="pos-refund-amount-hint" className="hint">
                  {t.amountHint(exponent, money(remaining))}
                </p>
                <p
                  id="pos-refund-amount-error"
                  className="error pos-field-error"
                  aria-live="polite"
                >
                  {showAmountError && amountError ? amountError : ''}
                </p>
              </div>
            )}
            <div className="pos-field">
              <label htmlFor="pos-refund-reason">{t.reasonLabel}</label>
              <input
                id="pos-refund-reason"
                name="refund-reason"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-describedby="pos-refund-reason-hint"
              />
              <p id="pos-refund-reason-hint" className="hint">
                {t.reasonHint}
              </p>
            </div>
            {step.kind === 'form' && (
              <div className="pos-actions">
                <button type="submit" className="btn btn-primary">
                  {t.review}
                </button>
                <button type="button" className="btn btn-secondary" onClick={reset}>
                  {t.cancel}
                </button>
              </div>
            )}
          </fieldset>

          {(step.kind === 'confirm' || step.kind === 'submitting' || step.kind === 'failed') && (
            <div
              className="pos-refund-confirm"
              role="group"
              aria-labelledby="pos-refund-confirm-title"
            >
              <p id="pos-refund-confirm-title" className="pos-alert-title">
                {t.confirmTitle}
              </p>
              <p>{t.confirmText(money(step.amount), money(summary?.captured ?? payment.amount))}</p>
              <p>{t.confirmIrreversible}</p>
              {step.kind === 'failed' && (
                <p className="pos-alert pos-alert-bad" role="alert">
                  {refundErrorText(t, step.code)}
                </p>
              )}
              <div className="pos-actions">
                {step.kind !== 'failed' && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={step.kind === 'submitting'}
                    onClick={() => void submit(step.amount)}
                  >
                    {step.kind === 'submitting' ? t.submitting : t.confirm(money(step.amount))}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={step.kind === 'submitting'}
                  onClick={() => setStep({ kind: 'form' })}
                >
                  {t.back}
                </button>
              </div>
            </div>
          )}

          {step.kind === 'uncertain' && (
            <div className="pos-alert pos-alert-warn" role="alert">
              <p className="pos-alert-title">{t.uncertainTitle}</p>
              <p>{t.uncertainText}</p>
              <div className="pos-actions">
                <button type="button" className="btn" onClick={() => void submit(step.amount)}>
                  {t.retrySafe}
                </button>
              </div>
            </div>
          )}
        </form>
      )}

      <h4 className="pos-refund-list-title">{t.listTitle}</h4>
      {list && refunds.length === 0 && <p className="hint">{t.listEmpty}</p>}
      {refunds.length > 0 && (
        <ul className="pos-refund-list" data-testid="pos-refund-list">
          {refunds.map((r) => (
            <RefundRow key={r.id} refund={r} locale={locale} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RefundRow({ refund, locale }: { refund: PosRefund; locale: Locale }) {
  const t = POS_REFUND_MESSAGES[locale];
  return (
    <li className="pos-refund-item">
      <span className="pos-refund-amount">
        {formatAmount(refund.amount, refund.currency, locale)}
      </span>
      <span className={`badge pos-refund-${refund.status}`}>{t.status[refund.status]}</span>
      <span className="hint">{when(refund.created_at, locale)}</span>
      {refund.reason && <span className="hint">{t.reasonShown(refund.reason)}</span>}
      {refund.failure_code && (
        <span className="hint">
          {t.failureReasons[refund.failure_code] ?? t.failureCode(refund.failure_code)}
        </span>
      )}
    </li>
  );
}
