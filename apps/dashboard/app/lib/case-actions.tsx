'use client';

import { useState } from 'react';
import { MESSAGES, type Locale } from '../messages';
import type { AdjustmentDirection } from './api';

/**
 * Acciones de operación sobre un caso y sus ajustes (F4-03c-ii). Cada una POSTea
 * a un route handler server-side que reenvía la cookie de sesión (el navegador
 * jamás sostiene el token ni conoce la URL de la API); en éxito recarga la vista
 * server-rendered. El API es la fuente de verdad del permiso y del four-eyes:
 * estos controles solo se muestran a roles con `reconciliation:manage` (hint de
 * UX) y el `four_eyes_required` (409) se muestra explícitamente al proponente.
 */

interface PostResult {
  ok: boolean;
  status: number;
  code?: string;
}

async function postAction(url: string, body?: unknown): Promise<PostResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    let code: string | undefined;
    try {
      const json = (await res.clone().json()) as { error?: { code?: string } };
      code = json.error?.code;
    } catch {
      /* respuesta sin cuerpo JSON */
    }
    return { ok: res.ok, status: res.status, code };
  } catch {
    return { ok: false, status: 0 };
  }
}

function reloadSoon(): void {
  setTimeout(() => window.location.reload(), 400);
}

export function AckButton({
  orgId,
  caseId,
  locale,
}: {
  orgId: string;
  caseId: string;
  locale: Locale;
}) {
  const t = MESSAGES[locale];
  const [phase, setPhase] = useState<'idle' | 'busy' | 'error'>('idle');
  async function run() {
    setPhase('busy');
    const r = await postAction(
      `/api/orgs/${encodeURIComponent(orgId)}/operational-cases/${encodeURIComponent(caseId)}/acknowledge`
    );
    if (r.ok) reloadSoon();
    else setPhase('error');
  }
  return (
    <span className="action-inline">
      <button type="button" className="btn" onClick={run} disabled={phase === 'busy'}>
        {phase === 'busy' ? t.acknowledging : t.acknowledge}
      </button>
      {phase === 'error' && (
        <span className="error" role="alert">
          {t.actionError}
        </span>
      )}
    </span>
  );
}

export function ResolveForm({
  orgId,
  caseId,
  locale,
}: {
  orgId: string;
  caseId: string;
  locale: Locale;
}) {
  const t = MESSAGES[locale];
  const [resolution, setResolution] = useState('');
  const [phase, setPhase] = useState<'idle' | 'busy' | 'error'>('idle');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!resolution.trim()) return;
    setPhase('busy');
    const r = await postAction(
      `/api/orgs/${encodeURIComponent(orgId)}/operational-cases/${encodeURIComponent(caseId)}/resolve`,
      { resolution: resolution.trim() }
    );
    if (r.ok) reloadSoon();
    else setPhase('error');
  }
  return (
    <form className="action-form" onSubmit={submit}>
      <label htmlFor="resolution">{t.resolutionLabel}</label>
      <textarea
        id="resolution"
        name="resolution"
        required
        rows={2}
        maxLength={2000}
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
      />
      <p className="hint">{t.documentalNote}</p>
      <button type="submit" className="btn" disabled={phase === 'busy'}>
        {phase === 'busy' ? t.resolving : t.resolveAction}
      </button>
      {phase === 'error' && (
        <span className="error" role="alert">
          {t.actionError}
        </span>
      )}
    </form>
  );
}

export function ProposeForm({
  orgId,
  caseId,
  locale,
  defaultAmount,
}: {
  orgId: string;
  caseId: string;
  locale: Locale;
  defaultAmount?: number | null;
}) {
  const t = MESSAGES[locale];
  const [amount, setAmount] = useState(
    typeof defaultAmount === 'number' ? String(defaultAmount) : ''
  );
  const [currency, setCurrency] = useState('COP');
  const [direction, setDirection] = useState<AdjustmentDirection>('debit_differences');
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<'idle' | 'busy' | 'error'>('idle');

  const amountNum = Number(amount);
  const valid = Number.isInteger(amountNum) && amountNum > 0 && reason.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setPhase('busy');
    const r = await postAction(
      `/api/orgs/${encodeURIComponent(orgId)}/operational-cases/${encodeURIComponent(caseId)}/adjustments`,
      { amount: amountNum, currency, direction, reason: reason.trim() }
    );
    if (r.ok) reloadSoon();
    else setPhase('error');
  }

  return (
    <form className="action-form" onSubmit={submit}>
      <fieldset>
        <legend>{t.proposeTitle}</legend>
        <div className="field-grid">
          <div>
            <label htmlFor="adj-amount">{t.amountLabel}</label>
            <input
              id="adj-amount"
              name="amount"
              type="number"
              min={1}
              step={1}
              required
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-describedby="adj-amount-hint"
            />
            <p id="adj-amount-hint" className="hint">
              {t.amountHint}
            </p>
          </div>
          <div>
            <label htmlFor="adj-currency">{t.currencyLabel}</label>
            <input
              id="adj-currency"
              name="currency"
              required
              maxLength={3}
              pattern="[A-Za-z]{3}"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <label htmlFor="adj-direction">{t.directionLabel}</label>
            <select
              id="adj-direction"
              name="direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value as AdjustmentDirection)}
            >
              <option value="debit_differences">{t.dirDebit}</option>
              <option value="credit_differences">{t.dirCredit}</option>
            </select>
          </div>
        </div>
        <label htmlFor="adj-reason">{t.reasonLabel}</label>
        <textarea
          id="adj-reason"
          name="reason"
          required
          rows={2}
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="hint">{t.fourEyesHint}</p>
        <button type="submit" className="btn" disabled={phase === 'busy' || !valid}>
          {phase === 'busy' ? t.proposing : t.propose}
        </button>
        {phase === 'error' && (
          <span className="error" role="alert">
            {t.actionError}
          </span>
        )}
      </fieldset>
    </form>
  );
}

/**
 * Aprobar / rechazar un ajuste `proposed`. Aprobar es el punto del four-eyes: si
 * el aprobador es el proponente, la API devuelve 409 `four_eyes_required` y aquí
 * se muestra el mensaje específico (no un error genérico).
 */
export function AdjustmentDecision({
  orgId,
  adjustmentId,
  locale,
}: {
  orgId: string;
  adjustmentId: string;
  locale: Locale;
}) {
  const t = MESSAGES[locale];
  const [phase, setPhase] = useState<'idle' | 'busy' | 'error' | 'four_eyes'>('idle');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  async function approve() {
    setPhase('busy');
    const r = await postAction(
      `/api/orgs/${encodeURIComponent(orgId)}/case-adjustments/${encodeURIComponent(adjustmentId)}/approve`
    );
    if (r.ok) reloadSoon();
    else if (r.status === 409 && r.code === 'four_eyes_required') setPhase('four_eyes');
    else setPhase('error');
  }

  async function submitReject(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return;
    setPhase('busy');
    const r = await postAction(
      `/api/orgs/${encodeURIComponent(orgId)}/case-adjustments/${encodeURIComponent(adjustmentId)}/reject`,
      { reason: reason.trim() }
    );
    if (r.ok) reloadSoon();
    else setPhase('error');
  }

  return (
    <div className="decision">
      <div className="action-inline">
        <button type="button" className="btn" onClick={approve} disabled={phase === 'busy'}>
          {phase === 'busy' ? t.approving : t.approve}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => setRejecting((v) => !v)}
          aria-expanded={rejecting}
          disabled={phase === 'busy'}
        >
          {t.reject}
        </button>
      </div>
      {rejecting && (
        <form className="action-form" onSubmit={submitReject}>
          <label htmlFor={`rej-${adjustmentId}`}>{t.rejectReasonLabel}</label>
          <textarea
            id={`rej-${adjustmentId}`}
            required
            rows={2}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="submit" className="btn btn-danger" disabled={phase === 'busy'}>
            {phase === 'busy' ? t.rejecting : t.reject}
          </button>
        </form>
      )}
      {phase === 'four_eyes' && (
        <p className="error" role="alert">
          {t.fourEyesError}
        </p>
      )}
      {phase === 'error' && (
        <p className="error" role="alert">
          {t.actionError}
        </p>
      )}
    </div>
  );
}
