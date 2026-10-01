'use client';

import { useState, type FormEvent } from 'react';
import { newKey, personalCall, personalError, toMinor } from '../../lib/client';

export function RepayForm({
  currencies,
  plans,
}: {
  currencies: string[];
  plans: { id: string; label: string; currency: string }[];
}) {
  const [key, setKey] = useState(newKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = toMinor(String(f.get('amount') ?? ''));
    if (!amount) return setMsg({ tone: 'bad', text: 'Escribe un importe válido.' });
    const plan = String(f.get('plan') ?? '');
    const currency = plan ? plans.find((p) => p.id === plan)!.currency : String(f.get('currency'));
    setBusy(true);
    setMsg(null);
    const r = await personalCall('credit/repayments', {
      method: 'POST',
      body: { amount, currency, ...(plan ? { plan_id: plan } : {}) },
      idempotencyKey: key,
    });
    setBusy(false);
    if (r.kind !== 'ok') return setMsg({ tone: 'bad', text: personalError(r) });
    setKey(newKey());
    setMsg({
      tone: 'ok',
      text: 'Pago aplicado a tus cuotas (primero las vencidas, luego por fecha).',
    });
    setTimeout(() => window.location.reload(), 1200);
  };
  return (
    <form className="px-form" onSubmit={submit} style={{ marginTop: 12 }}>
      <div className="px-field">
        <label htmlFor="px-plan">Aplicar a</label>
        <select id="px-plan" name="plan" defaultValue="">
          <option value="">Las cuotas más antiguas</option>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      {currencies.length > 1 ? (
        <div className="px-field">
          <label htmlFor="px-rccy">Moneda</label>
          <select id="px-rccy" name="currency">
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      ) : (
        <input type="hidden" name="currency" value={currencies[0]} />
      )}
      <div className="px-field px-field-amount">
        <label htmlFor="px-ramount">Importe a pagar con tu saldo</label>
        <input id="px-ramount" name="amount" inputMode="decimal" required placeholder="0,00" />
      </div>
      {msg ? (
        <p
          className={`px-alert px-alert-${msg.tone}`}
          role={msg.tone === 'bad' ? 'alert' : 'status'}
        >
          {msg.text}
        </p>
      ) : null}
      <button className="px-btn px-btn-credit" type="submit" disabled={busy}>
        {busy ? 'Pagando…' : 'Pagar cuotas'}
      </button>
      <p className="px-muted" style={{ margin: 0 }}>
        Se paga con tu saldo propio disponible. La garantía bloqueada no se usa para pagar cuotas.
      </p>
    </form>
  );
}
