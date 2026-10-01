'use client';

import { useState, type FormEvent } from 'react';
import { newKey, personalCall, personalError, toMinor } from '../../lib/client';
import { money } from '../../lib/format';

type Action = 'ingresar' | 'enviar' | 'retirar';

/**
 * Formularios de la wallet. Cada intención tiene su clave de idempotencia: un
 * reintento tras «sin respuesta» reutiliza la misma clave y no duplica. Un
 * resultado incierto se comunica como tal.
 */
export function MoveForms({ currency, initial }: { currency: string; initial: string | null }) {
  const [action, setAction] = useState<Action | null>(
    initial === 'ingresar' || initial === 'enviar' || initial === 'retirar' ? initial : null
  );
  const [key, setKey] = useState(newKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn' | 'info'; text: string } | null>(
    null
  );

  const choose = (a: Action) => {
    setAction(a);
    setMsg(null);
    setKey(newKey());
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = toMinor(String(f.get('amount') ?? ''));
    if (!amount) {
      setMsg({ tone: 'bad', text: 'Escribe un importe válido (por ejemplo 150,00).' });
      return;
    }
    setBusy(true);
    setMsg(null);
    let r;
    if (action === 'ingresar') {
      r = await personalCall<{ funding: { reference: string }; instructions: { text: string } }>(
        'wallet/fundings',
        {
          method: 'POST',
          body: { amount, currency, method: f.get('method') },
          idempotencyKey: key,
        }
      );
      if (r.kind === 'ok') {
        setMsg({
          tone: 'info',
          text: `Instrucción creada. Referencia ${r.body.funding.reference}. Se acreditará cuando el banco la confirme. ${r.body.instructions.text}`,
        });
      }
    } else if (action === 'enviar') {
      r = await personalCall('wallet/transfers', {
        method: 'POST',
        body: { to_email: f.get('to'), amount, currency, note: f.get('note') || undefined },
        idempotencyKey: key,
      });
      if (r.kind === 'ok') setMsg({ tone: 'ok', text: `Enviaste ${money(amount, currency)}.` });
    } else {
      r = await personalCall<{ status: string }>('wallet/withdrawals', {
        method: 'POST',
        body: { amount, currency, destination: f.get('destination') },
        idempotencyKey: key,
      });
      if (r.kind === 'ok') {
        const s = r.body.status;
        setMsg(
          s === 'completed'
            ? { tone: 'ok', text: 'Retiro enviado al banco.' }
            : s === 'failed'
              ? { tone: 'bad', text: 'El banco rechazó el retiro. El dinero volvió a tu saldo.' }
              : {
                  tone: 'warn',
                  text: 'El banco no respondió todavía. El importe queda retenido hasta tener confirmación; no lo repitas.',
                }
        );
      }
    }
    setBusy(false);
    if (r && r.kind !== 'ok') setMsg({ tone: 'bad', text: personalError(r) });
    if (r && r.kind === 'ok') {
      setKey(newKey());
      setTimeout(() => window.location.reload(), 1600);
    }
  };

  return (
    <section className="px-card" aria-labelledby="px-actions">
      <h2 id="px-actions" className="sr-only">
        Operaciones
      </h2>
      <div className="px-tabs-inline" role="group" aria-label="Elige una operación">
        <button
          type="button"
          aria-pressed={action === 'ingresar'}
          onClick={() => choose('ingresar')}
        >
          Ingresar fondos
        </button>
        <button type="button" aria-pressed={action === 'enviar'} onClick={() => choose('enviar')}>
          Enviar a otra persona
        </button>
        <button type="button" aria-pressed={action === 'retirar'} onClick={() => choose('retirar')}>
          Retirar al banco
        </button>
      </div>
      {action ? (
        <form className="px-form" onSubmit={submit}>
          <div className="px-field px-field-amount">
            <label htmlFor="px-amount">Importe en {currency}</label>
            <input
              id="px-amount"
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              required
              placeholder="0,00"
            />
          </div>
          {action === 'ingresar' ? (
            <fieldset className="px-choice">
              <legend className="sr-only">Método</legend>
              <label>
                <input type="radio" name="method" value="mobile_payment" defaultChecked />{' '}
                <span>Pago móvil</span>
              </label>
              <label>
                <input type="radio" name="method" value="bank_transfer" />{' '}
                <span>Transferencia</span>
              </label>
              <label>
                <input type="radio" name="method" value="cash_agent" />{' '}
                <span>Efectivo en agente</span>
              </label>
            </fieldset>
          ) : null}
          {action === 'enviar' ? (
            <>
              <div className="px-field">
                <label htmlFor="px-to">Correo de la persona (cliente Fluvia)</label>
                <input id="px-to" name="to" type="email" required />
              </div>
              <div className="px-field">
                <label htmlFor="px-note">Concepto (opcional)</label>
                <input id="px-note" name="note" maxLength={140} />
              </div>
            </>
          ) : null}
          {action === 'retirar' ? (
            <div className="px-field">
              <label htmlFor="px-dest">Cuenta de destino</label>
              <select id="px-dest" name="destination" defaultValue="sim:approve">
                <option value="sim:approve">Cuenta de prueba — el banco paga</option>
                <option value="sim:decline">Cuenta de prueba — el banco rechaza</option>
                <option value="sim:timeout">
                  Cuenta de prueba — el banco no responde a tiempo
                </option>
              </select>
              <span className="px-hint">Entorno de prueba: el banco es simulado.</span>
            </div>
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
            {busy
              ? 'Procesando…'
              : action === 'ingresar'
                ? 'Crear instrucción de ingreso'
                : action === 'enviar'
                  ? 'Enviar'
                  : 'Retirar'}
          </button>
        </form>
      ) : (
        <p className="px-muted" style={{ margin: 0 }}>
          Elige una operación. Los ingresos se acreditan cuando el banco los confirma.
        </p>
      )}
    </section>
  );
}
