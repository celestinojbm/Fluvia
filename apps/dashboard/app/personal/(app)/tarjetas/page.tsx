import { currencyLabel } from '../../../lib/fx';
import {
  CARD_STATUS,
  DECLINE_TEXT,
  PURCHASE_STATUS,
  dateTime,
  money,
  Status,
} from '../../lib/format';
import { FluviaWordmark } from '../../../lib/brand';
import { ErrorPanel } from '../../lib/panels';
import { readPersonal } from '../../lib/server';
import type { Authorization, Card, Me } from '../../lib/types';
import { CardControls, IssueCard, PayCode } from './card-actions';

export const dynamic = 'force-dynamic';

const MODE: Record<string, string> = {
  wallet_first: 'Primero saldo propio, luego crédito',
  wallet_only: 'Solo saldo propio',
  credit_only: 'Solo crédito',
};

export default async function Tarjetas({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; accion?: string }>;
}) {
  const sp = await searchParams;
  const [me, list] = await Promise.all([
    readPersonal<Me>('/me'),
    readPersonal<{ data: Card[] }>('/cards'),
  ]);
  if (me.kind !== 'ok' || list.kind !== 'ok') return <ErrorPanel />;
  const cards = list.data.data;
  const live = cards.filter((c) => c.status !== 'replaced' && c.status !== 'closed');
  const selected = cards.find((c) => c.id === sp.id) ?? live[0] ?? null;
  const detail = selected
    ? await readPersonal<{ card: Card; authorizations: Authorization[] }>(`/cards/${selected.id}`)
    : null;
  const auths = detail?.kind === 'ok' ? detail.data.authorizations : [];

  return (
    <main aria-labelledby="px-cards">
      <div className="px-head">
        <div>
          <p className="px-eyebrow">Tarjetas</p>
          <h1 id="px-cards">Tus tarjetas</h1>
        </div>
      </div>

      {selected ? (
        <div className="px-cards-grid">
          <div>
            <div
              className={`px-cardart${selected.status !== 'active' ? ' is-muted' : ''}`}
              aria-label="Tarjeta"
            >
              <div className="px-cardart-top">
                <span>
                  <FluviaWordmark height={20} color="var(--fl-white)" />
                  <span className="sr-only">Fluvia</span>
                </span>
                <span>{selected.form === 'virtual' ? 'Virtual' : 'Física'}</span>
              </div>
              <div
                className="px-cardart-num"
                aria-label={`Termina en ${selected.last4 ?? 'pendiente'}`}
              >
                •••• •••• •••• {selected.last4 ?? '····'}
              </div>
              <div className="px-cardart-foot">
                <span>{me.data.consumer.display_name}</span>
                <span>
                  {selected.exp_month
                    ? `${String(selected.exp_month).padStart(2, '0')}/${String(selected.exp_year).slice(2)}`
                    : '--/--'}
                </span>
              </div>
            </div>
            <p style={{ marginTop: 12 }}>
              <Status {...CARD_STATUS[selected.status]!} />{' '}
              {selected.blocked_by === 'operator' ? (
                <span className="px-muted">Bloqueada por Fluvia: escribe a soporte.</span>
              ) : null}
            </p>
            {live.length > 1 || cards.length > live.length ? (
              <nav className="px-tabs-inline" aria-label="Elegir tarjeta">
                {cards.map((c) => (
                  <a
                    key={c.id}
                    href={`/personal/tarjetas?id=${c.id}`}
                    aria-current={c.id === selected.id ? 'true' : undefined}
                  >
                    •••• {c.last4 ?? '····'} · {CARD_STATUS[c.status]!.label}
                  </a>
                ))}
              </nav>
            ) : null}
            <section className="px-card px-card-info" aria-labelledby="px-card-info">
              <h2 id="px-card-info" style={{ margin: '0 0 8px', fontSize: '1rem' }}>
                Datos y uso
              </h2>
              <dl
                style={{
                  margin: 0,
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: '4px 16px',
                }}
              >
                <dt className="px-muted">Moneda</dt>
                <dd style={{ margin: 0 }}>{currencyLabel(selected.currency)}</dd>
                <dt className="px-muted">Cómo paga</dt>
                <dd style={{ margin: 0 }}>{MODE[selected.funding_mode]}</dd>
                <dt className="px-muted">Límite por compra</dt>
                <dd style={{ margin: 0 }}>
                  {selected.limit_per_tx
                    ? money(selected.limit_per_tx, selected.currency)
                    : 'Sin límite propio'}
                </dd>
                <dt className="px-muted">Límite diario</dt>
                <dd style={{ margin: 0 }}>
                  {selected.limit_daily
                    ? money(selected.limit_daily, selected.currency)
                    : 'Sin límite propio'}
                </dd>
                {selected.shipment ? (
                  <>
                    <dt className="px-muted">Envío</dt>
                    <dd style={{ margin: 0 }}>
                      {selected.shipment.status === 'delivered'
                        ? 'Entregada'
                        : selected.shipment.status === 'shipped'
                          ? 'En camino'
                          : selected.shipment.status === 'produced'
                            ? 'Fabricada'
                            : selected.shipment.status === 'returned'
                              ? 'Devuelta por mensajería'
                              : 'Solicitada'}{' '}
                      · {selected.shipment.city}
                    </dd>
                  </>
                ) : null}
              </dl>
            </section>
          </div>
          <div className="px-controls">
            <CardControls card={selected} />
          </div>
        </div>
      ) : (
        <div className="px-empty">
          <p>Aún no tienes tarjeta. Pide una virtual: queda activa al instante.</p>
        </div>
      )}

      {selected && selected.status === 'active' ? (
        <PayCode
          cardId={selected.id}
          currency={selected.currency}
          counts={me.data.policy.installment_counts}
          open={sp.accion === 'pagar'}
        />
      ) : null}

      {selected ? (
        <section className="px-section" aria-labelledby="px-card-mov">
          <h2 id="px-card-mov">Compras con esta tarjeta</h2>
          {auths.length === 0 ? (
            <div className="px-empty">
              <p>Sin compras todavía.</p>
            </div>
          ) : (
            <ul className="px-list">
              {auths.map((a) => (
                <li key={a.id}>
                  <div className="px-grow">
                    <p className="px-title">{a.merchant_name}</p>
                    <p className="px-sub">
                      {dateTime(a.created_at)}
                      {a.decline_code ? ` · ${DECLINE_TEXT[a.decline_code] ?? 'Rechazada'}` : ''}
                      {BigInt(a.credit_amount) > 0n
                        ? ` · ${money(a.credit_amount, a.currency)} con crédito`
                        : ''}
                    </p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p className="px-amount" style={{ margin: 0 }}>
                      {money(a.amount, a.currency)}
                    </p>
                    <Status
                      {...(PURCHASE_STATUS[a.status] ?? { label: a.status, tone: 'neutral' })}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <IssueCard currencies={me.data.program.currencies} />
    </main>
  );
}
