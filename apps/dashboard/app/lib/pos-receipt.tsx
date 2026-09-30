'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAmount, type Locale } from '../messages';
import { parseReceipt, receiptRef, type PosReceipt } from './pos-receipt-contract';
import { POS_RECEIPT_MESSAGES } from './pos-receipt-messages';

/**
 * Justificante de un cobro confirmado del POS (cliente). Lee el BFF
 * `GET /api/orgs/:orgId/pos/payments/:id/receipt` y muestra SOLO lo que este
 * devuelve (nada inferido ni recompuesto). Imprimible con `window.print()`:
 * las hojas de estilo de impresión ocultan la navegación y los controles.
 *
 * Nunca muestra ids completos: la referencia son los 8 últimos caracteres del
 * cobro.
 */

type Load =
  | { kind: 'loading' }
  | { kind: 'ok'; receipt: PosReceipt; at: number }
  | { kind: 'error' }
  | { kind: 'auth' }
  | { kind: 'not_found' }
  | { kind: 'not_charged' };

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
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const seq = useRef(0);

  const read = useCallback(async () => {
    const my = ++seq.current;
    setLoad({ kind: 'loading' });
    let res: Response;
    try {
      res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/pos/payments/${encodeURIComponent(paymentId)}/receipt`,
        { cache: 'no-store' }
      );
    } catch {
      if (my === seq.current) setLoad({ kind: 'error' });
      return;
    }
    if (my !== seq.current) return;
    if (res.status === 401) return setLoad({ kind: 'auth' });
    if (res.status === 404 || res.status === 403) return setLoad({ kind: 'not_found' });
    if (res.status === 409) return setLoad({ kind: 'not_charged' });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* sin JSON */
    }
    if (my !== seq.current) return;
    const receipt = res.status === 200 ? parseReceipt(body) : null;
    if (!receipt || receipt.payment.id !== paymentId) return setLoad({ kind: 'error' });
    setLoad({ kind: 'ok', receipt, at: Date.now() });
  }, [orgId, paymentId]);

  useEffect(() => {
    void read();
  }, [read]);

  const posHref = `/o/${orgId}/pos${locale === 'en' ? '?lang=en' : ''}`;

  if (load.kind === 'loading') {
    return (
      <section className="card pos-receipt" aria-busy="true" aria-labelledby="pos-receipt-title">
        <h2 id="pos-receipt-title">{t.docTitle}</h2>
        <p className="hint" role="status">
          {t.loading}
        </p>
      </section>
    );
  }

  if (load.kind !== 'ok') {
    const text =
      load.kind === 'auth'
        ? t.authLost
        : load.kind === 'not_found'
          ? t.notFound
          : load.kind === 'not_charged'
            ? t.notCharged
            : t.loadError;
    return (
      <section className="card pos-receipt" aria-labelledby="pos-receipt-title">
        <h2 id="pos-receipt-title">{t.docTitle}</h2>
        <div className="pos-alert pos-alert-bad" role="alert">
          <p>
            {text}
            {load.kind === 'auth' && (
              <>
                {' '}
                <a href="/login">{t.signIn}</a>
              </>
            )}
          </p>
          {load.kind === 'error' && (
            <button type="button" className="btn btn-secondary" onClick={() => void read()}>
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

  const { receipt, at } = load;
  const { payment, sale } = receipt;
  const money = (n: number) => formatAmount(n, payment.currency, locale);

  return (
    <article className="card pos-receipt" aria-labelledby="pos-receipt-title">
      <header className="pos-receipt-head">
        <h2 id="pos-receipt-title">{t.docTitle}</h2>
        <p className="pos-receipt-disclaimer" data-testid="pos-receipt-not-fiscal">
          {t.notFiscal} {t.sandbox}
        </p>
      </header>

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

      <p className="hint pos-receipt-read">{t.readAt(dateTimeOf(at, locale))}</p>

      <div className="pos-actions no-print">
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          {t.print}
        </button>
        <a className="btn btn-secondary" href={posHref}>
          {t.back}
        </a>
      </div>
    </article>
  );
}
