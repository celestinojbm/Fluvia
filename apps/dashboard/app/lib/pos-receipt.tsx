'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAmount, type Locale } from '../messages';
import {
  hasOpenRefund,
  hasUncertainRefund,
  parseReceipt,
  receiptRef,
  type PosReceipt,
} from './pos-receipt-contract';
import { installPrintUrlGuard, type PrintUrlGuard } from './pos-print-url';
import { POS_RECEIPT_MESSAGES } from './pos-receipt-messages';

/**
 * Justificante de un cobro confirmado del POS (cliente). Lee el BFF
 * `GET /api/orgs/:orgId/pos/payments/:id/receipt` y muestra SOLO lo que este
 * devuelve (nada inferido ni recompuesto): el importe devuelto es el
 * `amount_refunded` de la API y cada devolución lleva su estado tal cual; una
 * `indeterminate` se muestra como «pendiente de verificación», jamás como
 * devuelta. Imprimible con `window.print()` (los estilos de impresión ocultan
 * navegación y controles).
 *
 * Estados: carga; error sin datos (reintentar); relectura fallida con datos
 * (se conservan marcados como desactualizados y NO se pueden imprimir);
 * sesión caducada o sin acceso (los datos se retiran). Nunca muestra ids
 * completos: la referencia son los 8 últimos caracteres del cobro.
 */

type Phase = 'loading' | 'idle' | 'error' | 'auth' | 'not_found' | 'not_charged';

function dateTimeOf(iso: string | number, locale: Locale): string {
  try {
    return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return String(iso);
  }
}

function timeOf(ms: number, locale: Locale): string {
  try {
    return new Date(ms).toLocaleTimeString(locale === 'en' ? 'en-US' : 'es-CO');
  } catch {
    return '';
  }
}

export function PosReceiptView({
  orgId,
  orgName,
  paymentId,
  locale,
}: {
  orgId: string;
  orgName: string | null;
  paymentId: string;
  locale: Locale;
}) {
  const t = POS_RECEIPT_MESSAGES[locale];
  const [data, setData] = useState<{ receipt: PosReceipt; at: number } | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [announce, setAnnounce] = useState('');
  const seq = useRef(0);
  const alertRef = useRef<HTMLDivElement>(null);
  const userRead = useRef(false);

  const read = useCallback(
    async (byUser: boolean) => {
      const my = ++seq.current;
      userRead.current = byUser;
      setPhase('loading');
      setAnnounce('');
      let res: Response;
      try {
        res = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/pos/payments/${encodeURIComponent(paymentId)}/receipt`,
          { cache: 'no-store' }
        );
      } catch {
        if (my === seq.current) setPhase('error');
        return;
      }
      if (my !== seq.current) return;
      // Sesión caducada o sin acceso: se retiran los datos (no se deja un
      // justificante a la vista de quien esté en el terminal).
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 409) {
        setData(null);
        setPhase(res.status === 401 ? 'auth' : res.status === 409 ? 'not_charged' : 'not_found');
        return;
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* sin JSON */
      }
      if (my !== seq.current) return;
      const receipt = res.status === 200 ? parseReceipt(body) : null;
      if (!receipt || receipt.payment.id !== paymentId) return setPhase('error');
      setData({ receipt, at: Date.now() });
      setPhase('idle');
      if (byUser) setAnnounce(t.updated);
    },
    [orgId, paymentId, t.updated]
  );

  useEffect(() => {
    void read(false);
  }, [read]);

  // Un fallo tras una acción del usuario se enfoca para que el lector de
  // pantalla y el teclado lleguen al mensaje y a «Reintentar».
  useEffect(() => {
    if (phase !== 'idle' && phase !== 'loading' && userRead.current) alertRef.current?.focus();
  }, [phase]);

  // La URL (con ids completos) no debe llegar al pie de página impreso.
  const printGuard = useRef<PrintUrlGuard | null>(null);
  const printable = useRef(false);
  useEffect(() => {
    const g = installPrintUrlGuard(window, { canPrint: () => printable.current });
    printGuard.current = g;
    return () => g.dispose();
  }, []);
  const print = () => printGuard.current?.print();

  const posHref = `/o/${orgId}/pos${locale === 'en' ? '?lang=en' : ''}`;
  const busy = phase === 'loading';

  if (!data) {
    printable.current = false;
    if (phase === 'loading') {
      return (
        <section className="card pos-receipt" aria-busy="true" aria-labelledby="pos-receipt-title">
          <h2 id="pos-receipt-title">{t.docTitle}</h2>
          <p className="hint" role="status">
            {t.loading}
          </p>
        </section>
      );
    }
    const text =
      phase === 'auth'
        ? t.authLost
        : phase === 'not_found'
          ? t.notFound
          : phase === 'not_charged'
            ? t.notCharged
            : t.loadError;
    return (
      <section className="card pos-receipt" aria-labelledby="pos-receipt-title">
        <h2 id="pos-receipt-title">{t.docTitle}</h2>
        <div
          className="pos-alert pos-alert-bad"
          role="alert"
          tabIndex={-1}
          ref={alertRef}
          data-testid="pos-receipt-alert"
          data-kind={phase}
        >
          <p>
            {text}
            {phase === 'auth' && (
              <>
                {' '}
                <a href="/login">{t.signIn}</a>
              </>
            )}
          </p>
          {phase === 'error' && (
            <button type="button" className="btn btn-secondary" onClick={() => void read(true)}>
              {t.retry}
            </button>
          )}
        </div>
        <p className="no-print">
          <a href={posHref}>{t.back}</a>
        </p>
      </section>
    );
  }

  const { receipt, at } = data;
  // Solo una lectura fresca y completa se imprime (botón y Ctrl/Cmd+P).
  printable.current = phase === 'idle';
  const { payment, sale, refunds } = receipt;
  const money = (n: number) => formatAmount(n, payment.currency, locale);
  const stale = phase === 'error';
  const uncertain = hasUncertainRefund(refunds);
  const open = hasOpenRefund(refunds);
  const staleId = 'pos-receipt-stale';

  return (
    <article
      className={`card pos-receipt${stale ? ' pos-stale-receipt' : ''}`}
      aria-labelledby="pos-receipt-title"
      aria-busy={busy}
      data-testid="pos-receipt"
    >
      <header className="pos-receipt-head">
        <h2 id="pos-receipt-title">
          {refunds.length > 0 || receipt.refunds_truncated ? t.docTitleRefunds : t.docTitle}
        </h2>
        <p className="pos-receipt-disclaimer" data-testid="pos-receipt-not-fiscal">
          {t.notFiscal} {t.sandbox}
        </p>
      </header>

      {stale && (
        <p className="pos-print-stale print-only" data-testid="pos-receipt-print-stale">
          {t.printStale}
        </p>
      )}
      {stale && (
        <div
          id={staleId}
          className="pos-alert pos-alert-bad no-print"
          role="alert"
          tabIndex={-1}
          ref={alertRef}
          data-testid="pos-receipt-alert"
          data-kind="stale"
        >
          <p>{t.stale(timeOf(at, locale))}</p>
          <button type="button" className="btn btn-secondary" onClick={() => void read(true)}>
            {t.retry}
          </button>
        </div>
      )}

      <p className="pos-receipt-total">
        <span className="pos-receipt-total-label">{t.amountCharged}</span>
        <span className="pos-receipt-total-amount" data-testid="pos-receipt-captured">
          {money(payment.amount_captured)}
        </span>
      </p>

      <dl className="pos-receipt-kv">
        <dt>{t.statusLabel}</dt>
        <dd data-testid="pos-receipt-status">{t.status[payment.status] ?? payment.status}</dd>
        {orgName && (
          <>
            <dt>{t.organization}</dt>
            <dd className="pos-wrap">{orgName}</dd>
          </>
        )}
        <dt>{t.merchant}</dt>
        <dd className="pos-wrap">{receipt.merchant_name}</dd>
        <dt>{t.concept}</dt>
        <dd className="pos-wrap" data-testid="pos-receipt-concept">
          {sale ? (sale.description ?? t.noConcept) : t.saleUnlinked}
        </dd>
        {payment.amount !== payment.amount_captured && (
          <>
            <dt>{t.saleAmount}</dt>
            <dd>{money(payment.amount)}</dd>
          </>
        )}
        <dt>{t.paymentCreated}</dt>
        <dd>{dateTimeOf(payment.created_at, locale)}</dd>
        {sale && (
          <>
            <dt>{t.checkoutCompleted}</dt>
            <dd>
              {sale.checkout_completed_at
                ? dateTimeOf(sale.checkout_completed_at, locale)
                : t.checkoutCompletedMissing}
            </dd>
          </>
        )}
        <dt>{t.reference}</dt>
        <dd>
          <code data-testid="pos-receipt-ref" aria-describedby="pos-receipt-ref-hint">
            {receiptRef(payment.id)}
          </code>
          <span id="pos-receipt-ref-hint" className="hint pos-receipt-ref-hint">
            {t.referenceHint}
          </span>
        </dd>
      </dl>

      <section className="pos-receipt-refunds" aria-labelledby="pos-receipt-refunds-title">
        <h3 id="pos-receipt-refunds-title">{t.refundsTitle}</h3>
        <dl className="pos-receipt-kv">
          <dt>{t.refundedConfirmed}</dt>
          <dd data-testid="pos-receipt-refunded">{money(payment.amount_refunded)}</dd>
        </dl>
        {receipt.refunds_truncated ? (
          <p className="pos-alert pos-alert-warn" data-testid="pos-receipt-truncated">
            {t.truncatedNote}
          </p>
        ) : (
          <>
            {uncertain && (
              <p className="pos-alert pos-alert-warn" data-testid="pos-receipt-uncertain">
                {t.uncertainBanner}
              </p>
            )}
            {open && (
              <p className="pos-alert pos-alert-warn" data-testid="pos-receipt-open">
                {t.openBanner}
              </p>
            )}
            {refunds.length === 0 ? (
              <p className="hint">{t.refundsNone}</p>
            ) : (
              <ul className="pos-receipt-refund-list">
                {refunds.map((r) => (
                  <li
                    key={r.id}
                    className="pos-receipt-refund"
                    data-testid="pos-receipt-refund"
                    data-status={r.status}
                  >
                    <span className="pos-refund-amount">{money(r.amount)}</span>
                    <span className={`badge pos-refund-${r.status}`}>
                      {t.refundStatus[r.status]}
                    </span>
                    <span className="pos-receipt-refund-at">
                      {dateTimeOf(r.created_at, locale)}
                    </span>
                    <span className="hint pos-receipt-refund-detail">
                      {t.refundDetail[r.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <p className="hint pos-receipt-read">{t.readAt(dateTimeOf(at, locale))}</p>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      <p className="hint no-print" id="pos-receipt-print-hint" data-testid="pos-receipt-print-hint">
        {t.printHint}
      </p>
      <div className="pos-actions no-print">
        <button
          type="button"
          className="btn btn-primary"
          onClick={print}
          disabled={stale || busy}
          aria-describedby={stale ? `${staleId} pos-receipt-print-hint` : 'pos-receipt-print-hint'}
        >
          {t.print}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void read(true)}
          disabled={busy}
        >
          {busy ? t.refreshing : t.refresh}
        </button>
        <a className="btn btn-secondary" href={posHref}>
          {t.back}
        </a>
      </div>
    </article>
  );
}
