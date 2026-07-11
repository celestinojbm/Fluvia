'use client';

import { useState } from 'react';
import { formatAmount, MESSAGES, type Locale } from '../messages';
import type { Merchant } from './api';
import { CopyUrlButton } from './copy-button';

/**
 * Acciones de ESCRITURA del plano de sesión sobre pagos (F6.5A-bis). Cada
 * acción exige confirmación explícita y POSTea a un route handler server-side
 * (la cookie httpOnly viaja como Bearer; el navegador jamás sostiene el token).
 * La `Idempotency-Key` se genera UNA vez al entrar a la confirmación y se
 * reutiliza en los reintentos: reintentar un error no duplica la operación.
 * El API es la fuente de verdad del permiso (`reconciliation:manage`); estos
 * controles solo se muestran a owner/admin/finance (hint de UX).
 */

interface PostResult {
  ok: boolean;
  status: number;
  code?: string;
  body?: unknown;
}

async function postWithIdempotency(url: string, key: string, body: unknown): Promise<PostResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    let code: string | undefined;
    let parsed: unknown;
    try {
      parsed = await res.clone().json();
      code = (parsed as { error?: { code?: string } }).error?.code;
    } catch {
      /* respuesta sin cuerpo JSON */
    }
    return { ok: res.ok, status: res.status, code, body: parsed };
  } catch {
    return { ok: false, status: 0 };
  }
}

function reloadSoon(): void {
  setTimeout(() => window.location.reload(), 600);
}

export function CreateRefundForm({
  orgId,
  paymentIntentId,
  currency,
  locale,
}: {
  orgId: string;
  paymentIntentId: string;
  currency: string;
  locale: Locale;
}) {
  const t = MESSAGES[locale];
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'busy' | 'done' | 'error'>('idle');
  const [idemKey, setIdemKey] = useState('');
  const [errorCode, setErrorCode] = useState<string | undefined>();

  const amountNum = Number(amount);
  const amountValid = amount === '' || (Number.isInteger(amountNum) && amountNum > 0);

  function toConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!amountValid) return;
    // Una key por operación confirmable; un retry del mismo intento la reutiliza.
    setIdemKey(crypto.randomUUID());
    setPhase('confirm');
  }

  async function confirm() {
    setPhase('busy');
    const r = await postWithIdempotency(`/api/orgs/${encodeURIComponent(orgId)}/refunds`, idemKey, {
      payment_intent_id: paymentIntentId,
      ...(amount === '' ? {} : { amount: amountNum }),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
    if (r.ok) {
      setPhase('done');
      reloadSoon();
    } else {
      setErrorCode(r.code);
      setPhase('error');
    }
  }

  if (phase === 'done') return <p className="resent">{t.refundCreated}</p>;

  if (phase === 'confirm' || phase === 'busy' || phase === 'error') {
    return (
      <div className="action-form" role="group" aria-label={t.createRefundTitle}>
        <p>
          {t.confirmRefundText}{' '}
          <strong>{amount === '' ? t.amountFullRemaining : formatAmount(amountNum, currency, locale)}</strong>
        </p>
        <div className="action-inline">
          <button type="button" className="btn" onClick={confirm} disabled={phase === 'busy'}>
            {phase === 'busy' ? t.creating : t.confirmAction}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setPhase('idle')}
            disabled={phase === 'busy'}
          >
            {t.cancelAction}
          </button>
        </div>
        {phase === 'error' && (
          <p className="error" role="alert">
            {t.actionError}
            {errorCode ? ` (${errorCode})` : ''}
          </p>
        )}
      </div>
    );
  }

  return (
    <form className="action-form" onSubmit={toConfirm}>
      <fieldset>
        <legend>{t.createRefundTitle}</legend>
        <div className="field-grid">
          <div>
            <label htmlFor="refund-amount">{t.amountLabel}</label>
            <input
              id="refund-amount"
              name="amount"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-describedby="refund-amount-hint"
            />
            <p id="refund-amount-hint" className="hint">
              {t.refundAmountHint}
            </p>
          </div>
        </div>
        <label htmlFor="refund-reason">{t.reasonLabel}</label>
        <textarea
          id="refund-reason"
          name="reason"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button type="submit" className="btn" disabled={!amountValid}>
          {t.createRefundAction}
        </button>
      </fieldset>
    </form>
  );
}

export function CreatePaymentLinkForm({
  orgId,
  merchants,
  locale,
}: {
  orgId: string;
  merchants: Merchant[];
  locale: Locale;
}) {
  const t = MESSAGES[locale];
  const [merchantId, setMerchantId] = useState(merchants[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('COP');
  const [description, setDescription] = useState('');
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'busy' | 'done' | 'error'>('idle');
  const [idemKey, setIdemKey] = useState('');
  const [errorCode, setErrorCode] = useState<string | undefined>();
  const [createdUrl, setCreatedUrl] = useState('');

  const amountNum = Number(amount);
  const valid = merchantId !== '' && Number.isInteger(amountNum) && amountNum > 0;

  function toConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setIdemKey(crypto.randomUUID());
    setPhase('confirm');
  }

  async function confirm() {
    setPhase('busy');
    const r = await postWithIdempotency(
      `/api/orgs/${encodeURIComponent(orgId)}/payment-links`,
      idemKey,
      {
        merchant_id: merchantId,
        amount: amountNum,
        currency,
        ...(description.trim() ? { description: description.trim() } : {}),
      }
    );
    if (r.ok) {
      setCreatedUrl(String((r.body as { url?: string })?.url ?? ''));
      setPhase('done');
    } else {
      setErrorCode(r.code);
      setPhase('error');
    }
  }

  if (phase === 'done') {
    return (
      <div className="action-form">
        <p className="resent">{t.linkCreated}</p>
        {createdUrl && (
          <p className="action-inline">
            <code>{createdUrl}</code>
            <CopyUrlButton url={createdUrl} locale={locale} />
          </p>
        )}
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          {t.refreshList}
        </button>
      </div>
    );
  }

  if (phase === 'confirm' || phase === 'busy' || phase === 'error') {
    return (
      <div className="action-form" role="group" aria-label={t.createLinkTitle}>
        <p>
          {t.confirmLinkText}{' '}
          <strong>{Number.isFinite(amountNum) ? formatAmount(amountNum, currency, locale) : ''}</strong>
        </p>
        <div className="action-inline">
          <button type="button" className="btn" onClick={confirm} disabled={phase === 'busy'}>
            {phase === 'busy' ? t.creating : t.confirmAction}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setPhase('idle')}
            disabled={phase === 'busy'}
          >
            {t.cancelAction}
          </button>
        </div>
        {phase === 'error' && (
          <p className="error" role="alert">
            {t.actionError}
            {errorCode ? ` (${errorCode})` : ''}
          </p>
        )}
      </div>
    );
  }

  return (
    <form className="action-form" onSubmit={toConfirm}>
      <fieldset>
        <legend>{t.createLinkTitle}</legend>
        <div className="field-grid">
          <div>
            <label htmlFor="link-merchant">{t.colMerchant}</label>
            <select
              id="link-merchant"
              name="merchant"
              required
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
            >
              {merchants.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="link-amount">{t.amountLabel}</label>
            <input
              id="link-amount"
              name="amount"
              type="number"
              min={1}
              step={1}
              required
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-describedby="link-amount-hint"
            />
            <p id="link-amount-hint" className="hint">
              {t.amountHint}
            </p>
          </div>
          <div>
            <label htmlFor="link-currency">{t.currencyLabel}</label>
            <input
              id="link-currency"
              name="currency"
              required
              maxLength={3}
              pattern="[A-Za-z]{3}"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </div>
        </div>
        <label htmlFor="link-description">{t.fldDescription}</label>
        <textarea
          id="link-description"
          name="description"
          rows={2}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button type="submit" className="btn" disabled={!valid}>
          {t.createLinkAction}
        </button>
      </fieldset>
    </form>
  );
}
