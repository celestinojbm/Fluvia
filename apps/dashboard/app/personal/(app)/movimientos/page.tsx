import { currencyLabel } from '../../../lib/fx';
import { Icon } from '../../../lib/icons';
import { dateTime, money, Status } from '../../lib/format';
import { ErrorPanel } from '../../lib/panels';
import { readPersonal } from '../../lib/server';
import type { Funding, Me, StatementLine, Transfer } from '../../lib/types';
import { MoveForms } from './move-forms';

export const dynamic = 'force-dynamic';

const FUNDING_STATUS = {
  pending: { label: 'Esperando al banco', tone: 'warn' },
  confirmed: { label: 'Acreditado', tone: 'ok' },
  failed: { label: 'No recibido', tone: 'bad' },
} as const;
const TRANSFER_STATUS = {
  processing: { label: 'En curso', tone: 'info' },
  completed: { label: 'Completado', tone: 'ok' },
  failed: { label: 'Devuelto', tone: 'bad' },
  indeterminate: { label: 'Confirmando con el banco', tone: 'warn' },
} as const;
const ACCOUNT_LABEL = {
  available: 'Disponible',
  held: 'Retenido',
  collateral: 'Garantía',
  debt: 'Crédito',
} as const;

export default async function Movimientos({
  searchParams,
}: {
  searchParams: Promise<{ moneda?: string; accion?: string }>;
}) {
  const sp = await searchParams;
  const me = await readPersonal<Me>('/me');
  if (me.kind !== 'ok') return <ErrorPanel />;
  const currencies = me.data.program.currencies;
  const currency = currencies.includes(sp.moneda ?? '') ? sp.moneda! : currencies[0]!;
  const [st, fundings, transfers] = await Promise.all([
    readPersonal<{ data: StatementLine[] }>(`/wallet/statement?currency=${currency}&limit=100`),
    readPersonal<{ data: Funding[] }>('/wallet/fundings'),
    readPersonal<{ data: Transfer[] }>('/wallet/transfers'),
  ]);
  if (st.kind !== 'ok' || fundings.kind !== 'ok' || transfers.kind !== 'ok') return <ErrorPanel />;
  const pendingFundings = fundings.data.data.filter((f) => f.status !== 'confirmed').slice(0, 5);

  return (
    <main aria-labelledby="px-mov">
      <div className="px-head">
        <div>
          <p className="px-eyebrow">Wallet</p>
          <h1 id="px-mov">Movimientos</h1>
        </div>
        <nav className="px-tabs-inline" aria-label="Cuenta (moneda real)">
          {currencies.map((c) => (
            <a
              key={c}
              href={`/personal/movimientos?moneda=${c}`}
              aria-current={c === currency ? 'true' : undefined}
            >
              {currencyLabel(c)}
            </a>
          ))}
        </nav>
      </div>

      <MoveForms currency={currency} initial={sp.accion ?? null} />

      {pendingFundings.length > 0 ? (
        <section className="px-section" aria-labelledby="px-pend">
          <h2 id="px-pend">Ingresos por confirmar</h2>
          <ul className="px-list">
            {pendingFundings.map((f) => (
              <li key={f.id}>
                <span className="px-icon-chip" aria-hidden="true">
                  <Icon name="clock" />
                </span>
                <div className="px-grow">
                  <p className="px-title">Referencia {f.reference}</p>
                  <p className="px-sub">{dateTime(f.created_at)}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p className="px-amount" style={{ margin: 0 }}>
                    {money(f.amount, f.currency)}
                  </p>
                  <Status {...FUNDING_STATUS[f.status]} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {transfers.data.data.length > 0 ? (
        <section className="px-section" aria-labelledby="px-tr">
          <h2 id="px-tr">Envíos y retiros</h2>
          <ul className="px-list">
            {transfers.data.data.slice(0, 8).map((t) => (
              <li key={t.id}>
                <span
                  className={`px-icon-chip${t.direction === 'out' ? ' is-out' : ''}`}
                  aria-hidden="true"
                >
                  <Icon name={t.kind === 'withdrawal' ? 'out' : 'send'} />
                </span>
                <div className="px-grow">
                  <p className="px-title">
                    {t.kind === 'withdrawal'
                      ? `Retiro a ${t.destination_masked}`
                      : t.direction === 'in'
                        ? 'Transferencia recibida'
                        : 'Transferencia enviada'}
                  </p>
                  <p className="px-sub">
                    {dateTime(t.created_at)}
                    {t.note ? ` · ${t.note}` : ''}
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p
                    className={`px-amount${t.direction === 'in' ? ' px-amount-in' : ''}`}
                    style={{ margin: 0 }}
                  >
                    {t.direction === 'in' ? '+' : '−'}
                    {money(t.amount, t.currency)}
                  </p>
                  <Status {...TRANSFER_STATUS[t.status]} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="px-section" aria-labelledby="px-ext">
        <h2 id="px-ext">Extracto · {currencyLabel(currency)}</h2>
        <p className="px-muted">
          Cada línea es un asiento del registro contable: nada se calcula en tu navegador.
        </p>
        {st.data.data.length === 0 ? (
          <div className="px-empty">
            <p>Aún no hay movimientos en {currencyLabel(currency)}.</p>
          </div>
        ) : (
          <ul className="px-list">
            {st.data.data.map((m) => (
              <li key={m.entry_id}>
                <span
                  className={`px-icon-chip${m.account === 'debt' ? ' is-credit' : m.direction === 'out' ? ' is-out' : ''}`}
                  aria-hidden="true"
                >
                  <Icon name={m.direction === 'in' ? 'in' : 'out'} />
                </span>
                <div className="px-grow">
                  <p className="px-title">{m.description}</p>
                  <p className="px-sub">
                    {dateTime(m.created_at)} · {ACCOUNT_LABEL[m.account]}
                  </p>
                </div>
                <span
                  className={`px-amount${m.account === 'debt' ? ' px-amount-credit' : m.direction === 'in' ? ' px-amount-in' : ''}`}
                >
                  {m.direction === 'in' ? '+' : '−'}
                  {money(m.amount, m.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
