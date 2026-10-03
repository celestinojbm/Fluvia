'use client';

import { currencyLabel } from '../../../lib/fx';
import { useState, type FormEvent } from 'react';
import { newKey, personalCall, personalError, toMinor } from '../../lib/client';
import { money, shortDate } from '../../lib/format';
import type { Card } from '../../lib/types';

function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);
  return { busy, setBusy, msg, setMsg };
}

export function CardControls({ card }: { card: Card }) {
  const { busy, setBusy, msg, setMsg } = useAction();
  const [reveal, setReveal] = useState<string | null>(null);
  const run = async (path: string, body?: unknown, ok?: string) => {
    setBusy(true);
    setMsg(null);
    const r = await personalCall<{ notice?: string }>(`cards/${card.id}/${path}`, {
      method: 'POST',
      body: body ?? {},
    });
    setBusy(false);
    if (r.kind !== 'ok') return setMsg({ tone: 'bad', text: personalError(r) });
    if (path === 'reveal') return setReveal(r.body.notice ?? null);
    setMsg({ tone: 'ok', text: ok ?? 'Listo.' });
    setTimeout(() => window.location.reload(), 900);
  };
  const limits = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const per = String(f.get('per') ?? '').trim();
    const day = String(f.get('day') ?? '').trim();
    const perMinor = per ? toMinor(per) : null;
    const dayMinor = day ? toMinor(day) : null;
    if ((per && !perMinor) || (day && !dayMinor))
      return setMsg({ tone: 'bad', text: 'Revisa los límites.' });
    await run(
      'limits',
      { limit_per_tx: perMinor, limit_daily: dayMinor, funding_mode: f.get('mode') },
      'Límites guardados.'
    );
  };
  const closed = card.status === 'closed' || card.status === 'replaced';
  return (
    <section className="px-card" aria-labelledby="px-ctrl">
      <h2 id="px-ctrl" style={{ margin: '0 0 12px', fontSize: '1rem' }}>
        Controles
      </h2>
      {closed ? (
        <p className="px-muted">Esta tarjeta ya no se puede usar.</p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {card.status === 'active' || card.status === 'inactive' ? (
              <button
                type="button"
                className="px-btn px-btn-danger"
                disabled={busy}
                onClick={() =>
                  run('block', { reason: 'Bloqueo temporal del cliente' }, 'Tarjeta bloqueada.')
                }
              >
                Bloquear
              </button>
            ) : null}
            {card.status === 'blocked' && card.blocked_by !== 'operator' ? (
              <button
                type="button"
                className="px-btn"
                disabled={busy}
                onClick={() =>
                  run('unblock', { reason: 'Desbloqueo del cliente' }, 'Tarjeta desbloqueada.')
                }
              >
                Desbloquear
              </button>
            ) : null}
            {card.status === 'inactive' && card.shipment?.status === 'delivered' ? (
              <button
                type="button"
                className="px-btn px-btn-primary"
                disabled={busy}
                onClick={() => run('activate', {}, 'Tarjeta activada.')}
              >
                Activar tarjeta recibida
              </button>
            ) : null}
            {card.status === 'active' ? (
              <button
                type="button"
                className="px-btn"
                disabled={busy}
                onClick={() => run('reveal')}
              >
                Ver datos completos
              </button>
            ) : null}
            <button
              type="button"
              className="px-btn"
              disabled={busy}
              onClick={() =>
                run(
                  'replace',
                  { reason: 'Reemplazo solicitado por el cliente' },
                  'Pediste una tarjeta nueva. La anterior quedó anulada.'
                )
              }
            >
              Reemplazar
            </button>
          </div>
          {reveal ? (
            <p className="px-alert px-alert-info" role="status">
              {reveal}
            </p>
          ) : null}
          <form className="px-form" onSubmit={limits}>
            <div className="px-field">
              <label htmlFor="px-mode">Cómo paga</label>
              <select id="px-mode" name="mode" defaultValue={card.funding_mode}>
                <option value="wallet_first">Primero saldo propio, luego crédito</option>
                <option value="wallet_only">Solo saldo propio</option>
                <option value="credit_only">Solo crédito</option>
              </select>
            </div>
            <div className="px-field">
              <label htmlFor="px-per">Límite por compra ({currencyLabel(card.currency)})</label>
              <input id="px-per" name="per" inputMode="decimal" placeholder="Sin límite" />
            </div>
            <div className="px-field">
              <label htmlFor="px-day">Límite diario ({currencyLabel(card.currency)})</label>
              <input id="px-day" name="day" inputMode="decimal" placeholder="Sin límite" />
            </div>
            <button className="px-btn" type="submit" disabled={busy}>
              Guardar límites
            </button>
          </form>
          <button
            type="button"
            className="px-link"
            disabled={busy}
            onClick={() =>
              run('close', { reason: 'Cierre solicitado por el cliente' }, 'Tarjeta cerrada.')
            }
          >
            Cerrar esta tarjeta definitivamente
          </button>
        </div>
      )}
      {msg ? (
        <p
          className={`px-alert px-alert-${msg.tone}`}
          role={msg.tone === 'bad' ? 'alert' : 'status'}
          style={{ marginTop: 10 }}
        >
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}

interface Preview {
  amount: string;
  currency: string;
  down_payment: string;
  financed: string;
  installments: { seq: number; amount: string; due_date: string }[];
  terms: { interest_bps: number; interval_days: number; down_payment_bps: number };
}

/** Pagar en comercio: oferta visible ANTES de aceptar y código de un solo uso. */
export function PayCode({
  cardId,
  currency,
  counts,
  open,
}: {
  cardId: string;
  currency: string;
  counts: number[];
  open: boolean;
}) {
  const { busy, setBusy, msg, setMsg } = useAction();
  const [mode, setMode] = useState<'wallet' | 'installments'>('wallet');
  const [count, setCount] = useState<number>(counts.find((c) => c > 1) ?? counts[0] ?? 1);
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [accepted, setAccepted] = useState(false);

  const simulate = async () => {
    const minor = toMinor(amount);
    if (!minor) return setMsg({ tone: 'bad', text: 'Escribe el importe aproximado de la compra.' });
    setMsg(null);
    const r = await personalCall<Preview>(
      `offers/installments?count=${count}&amount=${minor}&currency=${currency}`
    );
    if (r.kind !== 'ok') return setMsg({ tone: 'bad', text: personalError(r) });
    setPreview(r.body);
  };
  const generate = async () => {
    setBusy(true);
    setMsg(null);
    const r = await personalCall<{ code: string; expires_at: string }>('payment-codes', {
      method: 'POST',
      body:
        mode === 'wallet'
          ? { card_id: cardId, mode }
          : { card_id: cardId, mode, installments_count: count },
      idempotencyKey: newKey(),
    });
    setBusy(false);
    if (r.kind !== 'ok') return setMsg({ tone: 'bad', text: personalError(r) });
    setCode(r.body);
  };

  return (
    <section
      className="px-section px-card"
      aria-labelledby="px-pay"
      id="pagar"
      data-open={open ? 'true' : 'false'}
    >
      <h2 id="px-pay" style={{ marginTop: 0 }}>
        Pagar en un comercio Fluvia
      </h2>
      <p className="px-muted">
        Genera un código de un solo uso y escríbelo en el checkout del comercio. Caduca en 10
        minutos.
      </p>
      <div className="px-tabs-inline" role="group" aria-label="Forma de pago">
        <button
          type="button"
          aria-pressed={mode === 'wallet'}
          onClick={() => {
            setMode('wallet');
            setCode(null);
          }}
        >
          Con mi saldo
        </button>
        <button
          type="button"
          aria-pressed={mode === 'installments'}
          onClick={() => {
            setMode('installments');
            setCode(null);
            setAccepted(false);
          }}
        >
          En cuotas
        </button>
      </div>
      {mode === 'installments' ? (
        <div className="px-form">
          <div className="px-field">
            <label htmlFor="px-count">Número de cuotas</label>
            <select
              id="px-count"
              value={count}
              onChange={(e) => {
                setCount(Number(e.target.value));
                setPreview(null);
              }}
            >
              {counts.map((c) => (
                <option key={c} value={c}>
                  {c === 1 ? '1 cuota' : `${c} cuotas`}
                </option>
              ))}
            </select>
          </div>
          <div className="px-field">
            <label htmlFor="px-sim">
              Importe aproximado de la compra ({currencyLabel(currency)})
            </label>
            <input
              id="px-sim"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0,00"
            />
          </div>
          <button type="button" className="px-btn" onClick={simulate}>
            Ver calendario
          </button>
          {preview ? (
            <div className="px-alert px-alert-info">
              <p style={{ margin: '0 0 6px' }}>
                Inicial con tu saldo:{' '}
                <strong>{money(preview.down_payment, preview.currency)}</strong> · Financiado:{' '}
                <strong>{money(preview.financed, preview.currency)}</strong> · Interés:{' '}
                {preview.terms.interest_bps / 100}%
              </p>
              <ul className="px-steps">
                {preview.installments.map((i) => (
                  <li key={i.seq}>
                    Cuota {i.seq}
                    <strong>{money(i.amount, preview.currency)}</strong>
                    {shortDate(i.due_date)}
                  </li>
                ))}
              </ul>
              <p style={{ margin: '8px 0 0', fontSize: '0.8rem' }}>
                Condiciones de prueba (política sintética), pendientes de validación comercial. El
                importe final lo fija el comercio; el calendario se recalcula con ese importe.
              </p>
            </div>
          ) : null}
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>
              Acepto pagar la inicial con mi saldo y el resto en {count} cuota(s) según estas
              condiciones de prueba.
            </span>
          </label>
        </div>
      ) : null}
      <p style={{ marginTop: 12 }}>
        <button
          type="button"
          className="px-btn px-btn-primary"
          disabled={busy || (mode === 'installments' && !accepted)}
          onClick={generate}
        >
          {busy ? 'Generando…' : 'Generar código de pago'}
        </button>
      </p>
      {code ? (
        <div role="status">
          <p style={{ margin: '8px 0 4px', fontWeight: 650 }}>
            Tu código (válido hasta {new Date(code.expires_at).toLocaleTimeString('es-VE')}):
          </p>
          <p className="px-code" data-testid="payment-code">
            {code.code}
          </p>
          <button
            type="button"
            className="px-btn"
            onClick={() => navigator.clipboard?.writeText(code.code)}
          >
            Copiar código
          </button>
        </div>
      ) : null}
      {msg ? (
        <p className={`px-alert px-alert-${msg.tone}`} role="alert">
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}

export function IssueCard({ currencies }: { currencies: string[] }) {
  const { busy, setBusy, msg, setMsg } = useAction();
  const [form, setForm] = useState<'virtual' | 'physical'>('virtual');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMsg(null);
    const r = await personalCall('cards', {
      method: 'POST',
      body: {
        currency: f.get('currency'),
        form,
        ...(form === 'physical'
          ? { shipping: { address_line: f.get('address'), city: f.get('city') } }
          : {}),
      },
    });
    setBusy(false);
    if (r.kind !== 'ok') return setMsg({ tone: 'bad', text: personalError(r) });
    setMsg({
      tone: 'ok',
      text:
        form === 'virtual'
          ? 'Tarjeta virtual lista.'
          : 'Pedimos tu tarjeta física. Actívala cuando la recibas.',
    });
    setTimeout(() => window.location.reload(), 900);
  };
  return (
    <section className="px-section px-card" aria-labelledby="px-new-card">
      <h2 id="px-new-card" style={{ marginTop: 0 }}>
        Pedir una tarjeta
      </h2>
      <form className="px-form" onSubmit={submit}>
        <fieldset className="px-choice">
          <legend className="sr-only">Tipo</legend>
          <label>
            <input
              type="radio"
              name="form"
              checked={form === 'virtual'}
              onChange={() => setForm('virtual')}
            />
            <span>Virtual (al instante)</span>
          </label>
          <label>
            <input
              type="radio"
              name="form"
              checked={form === 'physical'}
              onChange={() => setForm('physical')}
            />
            <span>Física (envío)</span>
          </label>
        </fieldset>
        <div className="px-field">
          <label htmlFor="px-ccy">Moneda</label>
          <select id="px-ccy" name="currency">
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        {form === 'physical' ? (
          <>
            <div className="px-field">
              <label htmlFor="px-addr">Dirección de entrega</label>
              <input
                id="px-addr"
                name="address"
                required
                minLength={5}
                maxLength={200}
                autoComplete="street-address"
              />
            </div>
            <div className="px-field">
              <label htmlFor="px-city">Ciudad</label>
              <input
                id="px-city"
                name="city"
                required
                minLength={2}
                maxLength={80}
                autoComplete="address-level2"
              />
            </div>
          </>
        ) : null}
        {msg ? (
          <p
            className={`px-alert px-alert-${msg.tone}`}
            role={msg.tone === 'bad' ? 'alert' : 'status'}
          >
            {msg.text}
          </p>
        ) : null}
        <button className="px-btn px-btn-primary" type="submit" disabled={busy}>
          {busy ? 'Pidiendo…' : 'Pedir tarjeta'}
        </button>
        <p className="px-muted" style={{ margin: 0 }}>
          Emisión de prueba con un emisor simulado: no se generan números de tarjeta reales.
        </p>
      </form>
    </section>
  );
}
