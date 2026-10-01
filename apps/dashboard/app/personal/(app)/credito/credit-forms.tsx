'use client';

import { useState, type FormEvent } from 'react';
import { newKey, personalCall, personalError, toMinor } from '../../lib/client';
import { money } from '../../lib/format';
import type { Balance } from '../../lib/types';

function Msg({ m }: { m: { tone: string; text: string } | null }) {
  return m ? (
    <p className={`px-alert px-alert-${m.tone}`} role={m.tone === 'bad' ? 'alert' : 'status'}>
      {m.text}
    </p>
  ) : null;
}

export function CollateralForms({ balances }: { balances: Balance[] }) {
  const [kind, setKind] = useState<'lock' | 'release'>('lock');
  const [key, setKey] = useState(newKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = toMinor(String(f.get('amount') ?? ''));
    if (!amount) return setMsg({ tone: 'bad', text: 'Escribe un importe válido.' });
    setBusy(true);
    setMsg(null);
    const r = await personalCall<{ new_limit?: string | null }>(`collateral/${kind}`, {
      method: 'POST',
      body: { amount, currency: f.get('currency') },
      idempotencyKey: key,
    });
    setBusy(false);
    if (r.kind !== 'ok') return setMsg({ tone: 'bad', text: personalError(r) });
    setKey(newKey());
    setMsg({
      tone: 'ok',
      text:
        kind === 'lock'
          ? 'Garantía bloqueada. Sigue siendo tu dinero.'
          : r.body.new_limit
            ? `Garantía liberada. Tu límite se ajustó a ${money(r.body.new_limit, String(f.get('currency')))}.`
            : 'Garantía liberada.',
    });
    setTimeout(() => window.location.reload(), 1200);
  };
  return (
    <section className="px-card" aria-labelledby="px-coll">
      <h2 id="px-coll" style={{ marginTop: 0, fontSize: '1rem' }}>
        Garantía
      </h2>
      <div className="px-tabs-inline" role="group" aria-label="Operación de garantía">
        <button
          type="button"
          aria-pressed={kind === 'lock'}
          onClick={() => {
            setKind('lock');
            setKey(newKey());
            setMsg(null);
          }}
        >
          Bloquear
        </button>
        <button
          type="button"
          aria-pressed={kind === 'release'}
          onClick={() => {
            setKind('release');
            setKey(newKey());
            setMsg(null);
          }}
        >
          Liberar
        </button>
      </div>
      <form className="px-form" onSubmit={submit}>
        <div className="px-field">
          <label htmlFor="px-cccy">Moneda</label>
          <select id="px-cccy" name="currency">
            {balances.map((b) => (
              <option key={b.currency} value={b.currency}>
                {b.currency} · disponible {money(b.available, b.currency)} · garantía{' '}
                {money(b.collateral, b.currency)}
              </option>
            ))}
          </select>
        </div>
        <div className="px-field px-field-amount">
          <label htmlFor="px-camount">Importe</label>
          <input id="px-camount" name="amount" inputMode="decimal" required placeholder="0,00" />
        </div>
        <Msg m={msg} />
        <button className="px-btn px-btn-primary" type="submit" disabled={busy}>
          {busy ? 'Procesando…' : kind === 'lock' ? 'Bloquear garantía' : 'Liberar garantía'}
        </button>
      </form>
    </section>
  );
}

export function ApplyForm({ currencies }: { currencies: string[] }) {
  const [key, setKey] = useState(newKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = toMinor(String(f.get('amount') ?? ''));
    if (!amount) return setMsg({ tone: 'bad', text: 'Escribe el límite que necesitas.' });
    setBusy(true);
    setMsg(null);
    const r = await personalCall<{
      application: { status: string; approved_limit: string | null; currency: string };
    }>('credit/applications', {
      method: 'POST',
      body: { currency: f.get('currency'), requested_limit: amount },
      idempotencyKey: key,
    });
    setBusy(false);
    if (r.kind !== 'ok') return setMsg({ tone: 'bad', text: personalError(r) });
    setKey(newKey());
    const a = r.body.application;
    setMsg(
      a.status === 'approved'
        ? { tone: 'ok', text: `Aprobado: ${money(a.approved_limit!, a.currency)}.` }
        : a.status === 'manual_review'
          ? { tone: 'warn', text: 'Tu solicitud pasó a revisión por una persona del equipo.' }
          : { tone: 'bad', text: 'Esta vez no fue aprobada. Abajo verás los motivos.' }
    );
    setTimeout(() => window.location.reload(), 1500);
  };
  return (
    <section className="px-card" aria-labelledby="px-apply">
      <h2 id="px-apply" style={{ marginTop: 0, fontSize: '1rem' }}>
        Pedir o ampliar crédito
      </h2>
      <form className="px-form" onSubmit={submit}>
        <div className="px-field">
          <label htmlFor="px-accy">Moneda</label>
          <select id="px-accy" name="currency">
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="px-field px-field-amount">
          <label htmlFor="px-aamount">Límite que necesitas</label>
          <input id="px-aamount" name="amount" inputMode="decimal" required placeholder="0,00" />
        </div>
        <Msg m={msg} />
        <button className="px-btn px-btn-credit" type="submit" disabled={busy}>
          {busy ? 'Evaluando…' : 'Solicitar'}
        </button>
        <p className="px-muted" style={{ margin: 0 }}>
          La decisión se explica y queda registrada. Recargar tu wallet no amplía tu crédito.
        </p>
      </form>
    </section>
  );
}
