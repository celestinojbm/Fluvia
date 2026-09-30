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
 *  - «No se registró» solo se afirma si NINGÚN envío de esa key pudo cursarse.
 *    Si un envío anterior quedó incierto y el siguiente falla (401 incluido),
 *    el desenlace NO está verificado: no se ofrece repetir ni editar, solo
 *    consultar el estado real; cerrar exige una lectura posterior.
 *  - Candado síncrono contra el doble envío.
 *  - Solo se ofrece devolver con una lectura FRESCA y correcta: datos
 *    desactualizados, sesión caducada o sin acceso ⇒ se muestran, sin acción.
 *  - Devolver NO libera la venta (0046): el terminal sigue en «aprobado» y no
 *    ofrece recuperar ni abrir otro checkout.
 */

type ReadStatus = 'loading' | 'ok' | 'error' | 'auth' | 'forbidden';
interface Read {
  status: ReadStatus;
  /** Última lista leída correctamente (se conserva ante un fallo posterior). */
  list: PosRefundList | null;
  /** Hora de la última lectura correcta. */
  at: number | null;
  /** Hay una lectura en vuelo (sin vaciar lo que se ve). */
  refreshing: boolean;
}

type Step =
  | { kind: 'closed' }
  | { kind: 'form' }
  | { kind: 'confirm'; amount: number }
  | { kind: 'submitting'; amount: number }
  | { kind: 'uncertain'; amount: number }
  | { kind: 'failed'; amount: number; code?: string }
  /** Un envío previo de ESTA key quedó incierto y el siguiente falló: el
   *  primero pudo registrarse. `since`: hora del fallo (cerrar exige leer después). */
  | { kind: 'unverified'; amount: number; code?: string; since: number }
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

function timeOf(ms: number, locale: Locale): string {
  try {
    return new Date(ms).toLocaleTimeString(locale === 'en' ? 'en-US' : 'es-CO');
  } catch {
    return '';
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

  const [read, setRead] = useState<Read>({
    status: 'loading',
    list: null,
    at: null,
    refreshing: true,
  });
  const [readNonce, setReadNonce] = useState(0);
  const [step, setStep] = useState<Step>({ kind: 'closed' });
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const [showAmountError, setShowAmountError] = useState(false);
  const [stalled, setStalled] = useState(false);

  const inFlight = useRef(false);
  /** `uncertain`: algún envío de esta key pudo cursarse sin respuesta. */
  const idem = useRef<{ key: string; fingerprint: string; uncertain: boolean } | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const startRef = useRef<HTMLButtonElement>(null);
  const firstChoiceRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLParagraphElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const reread = useCallback(() => setReadNonce((n) => n + 1), []);

  // Lectura de las devoluciones: al montar, cuando cambia el cobro leído y a
  // demanda. Todo o nada (el BFF invalida listas incompletas). Un fallo NO
  // vacía lo que se ve: se marca desactualizado y se retira la acción.
  const refundsUrl = `/api/orgs/${org}/pos/payments/${encodeURIComponent(payment.id)}/refunds`;
  useEffect(() => {
    let cancelled = false;
    setRead((r) => ({ ...r, refreshing: true }));
    void call(refundsUrl).then((r) => {
      if (cancelled) return;
      const list = r.kind === 'ok' ? pickRefundList(r.body, payment.id) : null;
      if (list) {
        setRead({ status: 'ok', list, at: Date.now(), refreshing: false });
        return;
      }
      const status: ReadStatus =
        r.kind === 'http' && r.status === 401
          ? 'auth'
          : r.kind === 'http' && (r.status === 403 || r.status === 404)
            ? 'forbidden'
            : 'error';
      setRead((prev) => ({ ...prev, status, refreshing: false }));
    });
    return () => {
      cancelled = true;
    };
  }, [refundsUrl, payment.id, payment.status, payment.amount_refunded, readNonce]);

  // Seguimiento de la devolución registrada hasta un desenlace del API.
  const trackingId = step.kind === 'tracking' ? step.refundId : null;
  const tracked =
    trackingId && read.list ? (read.list.refunds.find((r) => r.id === trackingId) ?? null) : null;
  const trackedStatus = tracked?.status ?? null;
  const settled =
    !!trackedStatus && (REFUND_TERMINAL.has(trackedStatus) || trackedStatus === 'indeterminate');
  const polls = useRef(0);
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (!trackingId || read.refreshing) return;
    if (settled) {
      // Una sola relectura del cobro por desenlace (amount_refunded / estado).
      if (notified.current !== trackingId) {
        notified.current = trackingId;
        onChangedRef.current?.();
      }
      return;
    }
    // Sesión caducada o sin acceso: no se sigue consultando.
    if (read.status === 'auth' || read.status === 'forbidden') return;
    if (polls.current >= MAX_POLLS) {
      setStalled(true);
      return;
    }
    const timer = setTimeout(() => {
      polls.current += 1;
      reread();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [trackingId, settled, read, reread]);

  // Foco (teclado y lector de pantalla) al cambiar de paso.
  useEffect(() => {
    if (step.kind === 'form') {
      if (mode === 'partial') amountRef.current?.focus();
      else firstChoiceRef.current?.focus();
    } else if (step.kind === 'confirm') confirmRef.current?.focus();
    else if (step.kind === 'uncertain' || step.kind === 'failed' || step.kind === 'unverified')
      alertRef.current?.focus();
    else if (step.kind === 'tracking') resultRef.current?.focus();
    // `mode` solo decide el destino al abrir el formulario (no es dependencia).
  }, [step.kind]);

  const fresh = read.status === 'ok' && !read.refreshing;
  const list = read.list;
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

  // Por qué no se ofrece devolver (texto único para el cajero). Los estados de
  // lectura (cargando, desactualizado, sesión, acceso) tienen su propio aviso.
  const blockReason: string | null = !canRefund
    ? t.noRole
    : !verified
      ? t.notVerified
      : captured === null
        ? t.noCaptured
        : !fresh || !list || !summary
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
    fresh &&
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
          idem.current = { key: crypto.randomUUID(), fingerprint, uncertain: false };
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
            setStalled(false);
            setStep({ kind: 'tracking', refundId: refund.id });
            reread();
            onChangedRef.current?.();
            return;
          }
          idem.current.uncertain = true;
          setStep({ kind: 'uncertain', amount });
          return;
        }
        if (r.kind === 'network' || r.status >= 500) {
          idem.current.uncertain = true;
          setStep({ kind: 'uncertain', amount });
          return;
        }
        const code = r.code ?? (r.status === 401 ? 'invalid_session' : undefined);
        if (idem.current.uncertain) {
          // Este envío se rechazó, pero uno ANTERIOR con la misma key pudo
          // cursarse: afirmar «no se registró» sería falso. Se conserva la key
          // (un reintento en esta sesión haría replay) y solo se ofrece consultar.
          setStep({ kind: 'unverified', amount, code, since: Date.now() });
          if (code !== 'invalid_session') reread();
          return;
        }
        if (r.code === 'idempotency_key_reuse') idem.current = null;
        // Ningún envío de esta key pudo cursarse: un 401 (BFF sin cookie o
        // sesión rechazada ANTES del handler) garantiza que nada se registró.
        setStep({ kind: 'failed', amount, code });
        // El servidor pudo cambiar (otra devolución, estado del cobro).
        if (code !== 'invalid_session') reread();
      } finally {
        inFlight.current = false;
      }
    },
    [org, payment.id, reason, reread]
  );

  const reset = useCallback((focusStart = false) => {
    setStep({ kind: 'closed' });
    setMode('full');
    setAmountText('');
    setReason('');
    setShowAmountError(false);
    if (focusStart) setTimeout(() => startRef.current?.focus(), 0);
  }, []);

  const refunds = list?.refunds ?? [];
  const locked =
    step.kind === 'submitting' ||
    step.kind === 'uncertain' ||
    step.kind === 'unverified' ||
    step.kind === 'confirm';
  const editing = step.kind !== 'closed' && step.kind !== 'tracking';
  const sessionLost =
    read.status === 'auth' ||
    ((step.kind === 'failed' || step.kind === 'unverified') && step.code === 'invalid_session');
  // Cerrar un desenlace no verificado exige una lectura correcta POSTERIOR.
  const checkedAfter =
    step.kind === 'unverified' && fresh && read.at !== null && read.at > step.since;
  const resultTone =
    tracked?.status === 'succeeded'
      ? 'pos-alert-ok'
      : tracked?.status === 'failed' || tracked?.status === 'canceled'
        ? 'pos-alert-bad'
        : 'pos-alert-warn';

  return (
    <section
      className="pos-refund"
      aria-labelledby="pos-refund-title"
      aria-busy={read.refreshing}
      data-testid="pos-refund"
    >
      <h3 id="pos-refund-title">{t.title}</h3>
      <p className="hint">{t.intro}</p>

      {/* Estados de lectura: cargando / desactualizado / sesión / acceso. */}
      {read.status === 'loading' && (
        <p className="hint" role="status" data-testid="pos-refund-loading">
          {t.loading}
        </p>
      )}
      {read.status === 'error' && (
        <div className="pos-alert pos-alert-bad" role="alert" data-testid="pos-refund-read-error">
          <p>{list && read.at ? t.stale(timeOf(read.at, locale)) : t.loadError}</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={reread}
            disabled={read.refreshing}
          >
            {read.refreshing ? t.refreshing : t.retry}
          </button>
        </div>
      )}
      {sessionLost && (
        <div className="pos-alert pos-alert-bad" role="alert" data-testid="pos-refund-auth">
          <p>
            {t.authLost}{' '}
            {step.kind === 'failed'
              ? t.authNothingRecorded
              : step.kind === 'unverified'
                ? t.authUnverified
                : ''}
          </p>
          <a href="/login">{t.signIn}</a>
        </div>
      )}
      {read.status === 'forbidden' && (
        <p className="error" role="alert" data-testid="pos-refund-forbidden">
          {t.forbidden}
        </p>
      )}

      {summary && (
        <dl
          className={`kv pos-refund-summary${fresh ? '' : ' pos-stale'}`}
          data-testid="pos-refund-summary"
        >
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

      {step.kind === 'tracking' && (
        <div
          ref={resultRef}
          tabIndex={-1}
          className={`pos-alert ${tracked ? resultTone : 'pos-alert-warn'}`}
          role="status"
          aria-live="polite"
          data-testid="pos-refund-result"
          data-status={tracked?.status ?? 'pending'}
        >
          {tracked ? (
            <>
              <p className="pos-alert-title">{t.resultTitle[tracked.status]}</p>
              <p>
                {money(tracked.amount)} · {t.statusDetail[tracked.status]}
              </p>
              {tracked.failure_code && (
                <p>
                  {t.failureReasons[tracked.failure_code] ?? t.failureCode(tracked.failure_code)}
                </p>
              )}
              <p>{t.saleStaysClosed}</p>
            </>
          ) : (
            <p className="pos-alert-title">{t.resultTitle.created}</p>
          )}
          {(stalled || tracked?.status === 'indeterminate') && (
            <>
              {stalled && <p data-testid="pos-refund-stalled">{t.stalledText}</p>}
              <div className="pos-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={read.refreshing}
                  onClick={() => {
                    polls.current = 0;
                    setStalled(false);
                    reread();
                  }}
                >
                  {read.refreshing ? t.refreshing : t.checkRefunds}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {blockReason && !editing && (
        <p className="hint" data-testid="pos-refund-block">
          {blockReason}
        </p>
      )}

      {!editing ? (
        canStart && (
          <div className="pos-actions">
            <button
              ref={startRef}
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
          aria-busy={step.kind === 'submitting'}
          onKeyDown={(e) => {
            // Escape cancela mientras nada está en vuelo ni es incierto.
            if (e.key === 'Escape' && (step.kind === 'form' || step.kind === 'confirm')) {
              e.preventDefault();
              reset(true);
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            if (step.kind !== 'form') return;
            if (draftAmount === null || amountError) {
              setShowAmountError(true);
              amountRef.current?.focus();
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
                  ref={firstChoiceRef}
                  type="radio"
                  name="pos-refund-mode"
                  value="full"
                  checked={mode === 'full'}
                  onChange={() => setMode('full')}
                />
                <span>{t.modeFull(money(remaining))}</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="pos-refund-mode"
                  value="partial"
                  checked={mode === 'partial'}
                  onChange={() => {
                    setMode('partial');
                    setTimeout(() => amountRef.current?.focus(), 0);
                  }}
                />
                <span>{t.modePartial}</span>
              </label>
            </div>
            {mode === 'partial' && (
              <div className="pos-field">
                <label htmlFor="pos-refund-amount">{t.amountLabel}</label>
                <input
                  id="pos-refund-amount"
                  ref={amountRef}
                  name="refund-amount"
                  inputMode={exponent === 0 ? 'numeric' : 'decimal'}
                  autoComplete="off"
                  placeholder={exponent === 0 ? '0' : '0.00'}
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  onBlur={() => amountText !== '' && setShowAmountError(true)}
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
                <button type="button" className="btn btn-secondary" onClick={() => reset(true)}>
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
              <p
                id="pos-refund-confirm-title"
                className="pos-alert-title"
                ref={confirmRef}
                tabIndex={-1}
              >
                {t.confirmTitle}
              </p>
              <p>{t.confirmText(money(step.amount), money(summary?.captured ?? payment.amount))}</p>
              <p>{t.confirmIrreversible}</p>
              {step.kind === 'submitting' && (
                <p className="hint" role="status">
                  {t.submitting}
                </p>
              )}
              {step.kind === 'failed' && (
                <div
                  className="pos-alert pos-alert-bad"
                  role="alert"
                  ref={alertRef}
                  tabIndex={-1}
                  data-testid="pos-refund-failed"
                >
                  <p>{refundErrorText(t, step.code)}</p>
                </div>
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

          {step.kind === 'unverified' && (
            <div
              className="pos-alert pos-alert-warn"
              role="alert"
              ref={alertRef}
              tabIndex={-1}
              data-testid="pos-refund-unverified"
            >
              <p className="pos-alert-title">{t.unverifiedTitle}</p>
              <p>{t.unverifiedText}</p>
              {step.code && step.code !== 'invalid_session' && t.errorCodes[step.code] && (
                <p className="hint">{t.unverifiedLastError(t.errorCodes[step.code])}</p>
              )}
              <div className="pos-actions">
                {step.code !== 'invalid_session' && (
                  <button type="button" className="btn" onClick={reread} disabled={read.refreshing}>
                    {read.refreshing ? t.refreshing : t.checkRefunds}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => reset(true)}
                  disabled={!checkedAfter}
                  aria-describedby={checkedAfter ? undefined : 'pos-refund-unverified-close'}
                >
                  {t.closeAfterCheck}
                </button>
              </div>
              {!checkedAfter && (
                <p id="pos-refund-unverified-close" className="hint">
                  {t.closeNeedsCheck}
                </p>
              )}
            </div>
          )}

          {step.kind === 'uncertain' && (
            <div
              className="pos-alert pos-alert-warn"
              role="alert"
              ref={alertRef}
              tabIndex={-1}
              data-testid="pos-refund-uncertain"
            >
              <p className="pos-alert-title">{t.uncertainTitle}</p>
              <p>{t.uncertainText}</p>
              <div className="pos-actions">
                <button type="button" className="btn" onClick={() => void submit(step.amount)}>
                  {t.retrySafe}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={reread}
                  disabled={read.refreshing}
                >
                  {read.refreshing ? t.refreshing : t.checkRefunds}
                </button>
              </div>
            </div>
          )}
        </form>
      )}

      <h4 className="pos-refund-list-title">{t.listTitle}</h4>
      {list && refunds.length === 0 && <p className="hint">{t.listEmpty}</p>}
      {refunds.length > 0 && (
        <ul className={`pos-refund-list${fresh ? '' : ' pos-stale'}`} data-testid="pos-refund-list">
          {refunds.map((r) => (
            <RefundRow key={r.id} refund={r} locale={locale} current={r.id === trackingId} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RefundRow({
  refund,
  locale,
  current,
}: {
  refund: PosRefund;
  locale: Locale;
  current: boolean;
}) {
  const t = POS_REFUND_MESSAGES[locale];
  return (
    <li className="pos-refund-item" aria-current={current ? 'true' : undefined}>
      <span className="pos-refund-amount">
        {formatAmount(refund.amount, refund.currency, locale)}
      </span>
      <span className={`badge pos-refund-${refund.status}`}>{t.status[refund.status]}</span>
      <span className="hint">{when(refund.created_at, locale)}</span>
      {refund.reason && <span className="hint pos-wrap">{t.reasonShown(refund.reason)}</span>}
      {refund.failure_code && (
        <span className="hint pos-wrap">
          {t.failureReasons[refund.failure_code] ?? t.failureCode(refund.failure_code)}
        </span>
      )}
    </li>
  );
}
