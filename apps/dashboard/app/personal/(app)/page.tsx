import { Icon } from '../../lib/icons';
import { shortDate, CARD_STATUS } from '../lib/format';
import { readPersonal } from '../lib/server';
import type { Application, Balance, Card, Installment, Me, StatementLine } from '../lib/types';
import { ErrorPanel } from '../lib/panels';
import { HideAmountsButton } from '../lib/hide-amounts';
import { CartButton, Money, ProductCard } from '../lib/shop-ui';
import { OUTCOME, type CartGroup, type ShopOrder, type ShopProduct } from '../lib/shop-types';

export const dynamic = 'force-dynamic';

interface Overview {
  balances: Balance[];
  upcoming: (Installment & { currency: string; merchant_name: string })[];
  cards: Card[];
  pending_application: Application | null;
  recent: StatementLine[];
}

/**
 * Inicio de Fluvia Personal.
 *  - Saldo propio protagonista (ocultable). Garantía bloqueada y crédito
 *    disponible se muestran APARTE: nunca se suman en una cifra.
 *  - Accesos rápidos a contratos existentes (ingresar, enviar, pagar, retirar).
 *  - Tarjeta, próxima cuota y crédito como módulos amplios.
 *  - Continuidad de compras (pedidos y carrito) y destacados de Tiendas.
 */
export default async function PersonalHome({
  searchParams,
}: {
  searchParams: Promise<{ moneda?: string }>;
}) {
  const sp = await searchParams;
  const [r, me, orders, cart, featured] = await Promise.all([
    readPersonal<Overview>('/overview'),
    readPersonal<Me>('/me'),
    readPersonal<{ data: ShopOrder[] }>('/shop/orders'),
    readPersonal<{ data: CartGroup[] }>('/shop/cart'),
    readPersonal<{ data: ShopProduct[] }>('/shop/featured'),
  ]);
  if (r.kind !== 'ok') return <ErrorPanel />;
  const { balances, upcoming, cards, pending_application, recent } = r.data;
  const b = balances.find((x) => x.currency === sp.moneda) ?? balances[0];
  if (!b) return <ErrorPanel />;
  const c = b.credit;
  const first = me.kind === 'ok' ? me.data.consumer.display_name.split(' ')[0] : null;
  const next = upcoming[0];
  const card = cards.find((k) => k.status === 'active') ?? cards[0];
  const active = (orders.kind === 'ok' ? orders.data.data : []).filter(
    (o) =>
      o.fulfillment_status !== 'delivered' &&
      o.fulfillment_status !== 'cancelled' &&
      o.outcome !== 'cancelled'
  );
  const cartGroups = cart.kind === 'ok' ? cart.data.data : [];
  const cartCount = cartGroups.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.quantity, 0), 0);

  return (
    <main aria-labelledby="pm-home-title">
      <div className="pm-screen-head">
        <h1 id="pm-home-title">{first ? `Hola, ${first}` : 'Inicio'}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <HideAmountsButton />
          <CartButton count={cartCount} />
        </div>
      </div>

      {pending_application ? (
        <p className="pm-banner is-info" role="status" style={{ marginBottom: 12 }}>
          <Icon name="clock" />
          <span>
            Tu solicitud de crédito está en revisión por una persona del equipo. Te mostraremos la
            decisión aquí.
          </span>
        </p>
      ) : null}

      <div className="pm-home">
        <div>
          <section className="pm-hero" aria-labelledby="pm-own">
            <div className="pm-hero-top">
              <p className="pm-hero-label" id="pm-own">
                Saldo propio disponible
              </p>
              {balances.length > 1 ? (
                <nav className="pm-chips" aria-label="Moneda" style={{ margin: 0, padding: 0 }}>
                  {balances.map((x) => (
                    <a
                      key={x.currency}
                      className="pm-chip"
                      style={{ minHeight: 36 }}
                      href={`/personal?moneda=${x.currency}`}
                      aria-current={x.currency === b.currency ? 'true' : undefined}
                    >
                      {x.currency}
                    </a>
                  ))}
                </nav>
              ) : (
                <span className="pm-hero-cur">{b.currency}</span>
              )}
            </div>
            <Money minor={b.available} currency={b.currency} className="pm-hero-amount" />
            <dl className="pm-hero-split">
              <div className="pm-hero-cell">
                <dt>Garantía bloqueada</dt>
                <dd>
                  <Money minor={b.collateral} currency={b.currency} />
                </dd>
              </div>
              <div className="pm-hero-cell is-credit">
                <dt>Crédito disponible</dt>
                <dd>{c ? <Money minor={c.available} currency={b.currency} /> : 'Sin línea'}</dd>
              </div>
            </dl>
            {BigInt(b.held) > 0n ? (
              <p className="pm-hero-note">
                Retenido por compras o retiros en curso:{' '}
                <Money minor={b.held} currency={b.currency} />.
              </p>
            ) : null}
            <p className="pm-hero-note">
              El crédito no es saldo propio: lo que usas se paga en cuotas. La garantía es tu
              dinero, bloqueado como respaldo.
            </p>
          </section>

          <ul className="pm-quick" aria-label="Accesos rápidos">
            <li>
              <a href="/personal/movimientos?accion=ingresar">
                <span className="pm-quick-ico">
                  <Icon name="in" size={22} />
                </span>
                Ingresar
              </a>
            </li>
            <li>
              <a href="/personal/movimientos?accion=enviar">
                <span className="pm-quick-ico">
                  <Icon name="send" size={22} />
                </span>
                Enviar
              </a>
            </li>
            <li>
              <a className="is-primary" href="/personal/pagar">
                <span className="pm-quick-ico">
                  <Icon name="qr" size={22} />
                </span>
                Pagar
              </a>
            </li>
            <li>
              <a href="/personal/movimientos?accion=retirar">
                <span className="pm-quick-ico">
                  <Icon name="out" size={22} />
                </span>
                Retirar
              </a>
            </li>
          </ul>

          <div className="pm-modules">
            <a className="pm-module" href="/personal/tarjetas">
              <span className="pm-minicard" aria-hidden="true" />
              <span className="pm-module-body">
                <p className="pm-module-title">
                  {card
                    ? `Tarjeta ${card.form === 'virtual' ? 'virtual' : 'física'} •••• ${card.last4 ?? '····'}`
                    : 'Pide tu tarjeta'}
                </p>
                <p className="pm-module-sub">
                  {card
                    ? CARD_STATUS[card.status]?.label
                    : 'Virtual, al instante, para comercios Fluvia'}
                </p>
              </span>
              <Icon name="chevron-right" />
            </a>
            <a className="pm-module" href="/personal/cuotas">
              {next ? (
                <span
                  className={`pm-datebox${next.status === 'overdue' ? ' is-overdue' : ''}`}
                  aria-hidden="true"
                >
                  <strong>{new Date(`${next.due_date}T00:00:00Z`).getUTCDate()}</strong>
                  {shortDate(next.due_date).split(' ')[1]}
                </span>
              ) : (
                <span className="pm-datebox" aria-hidden="true">
                  <Icon name="calendar" />
                </span>
              )}
              <span className="pm-module-body">
                <p className="pm-module-title">
                  {next ? 'Próxima cuota' : 'Sin cuotas pendientes'}
                </p>
                <p className="pm-module-sub">
                  {next ? (
                    <>
                      <Money minor={next.outstanding} currency={next.currency} /> ·{' '}
                      {next.merchant_name}
                      {next.status === 'overdue' ? ' · vencida' : ''}
                    </>
                  ) : (
                    'Cuando compres en cuotas, el calendario aparece aquí.'
                  )}
                </p>
              </span>
              <Icon name="chevron-right" />
            </a>
            <a className="pm-module" href="/personal/credito">
              <span
                className="pm-quick-ico"
                style={{
                  background: 'var(--fl-credit-soft)',
                  color: 'var(--fl-credit)',
                  boxShadow: 'none',
                }}
                aria-hidden="true"
              >
                <Icon name="shield" size={22} />
              </span>
              <span className="pm-module-body">
                <p className="pm-module-title">Crédito y garantía</p>
                <p className="pm-module-sub">
                  {c ? (
                    <>
                      Límite <Money minor={c.approved_limit} currency={b.currency} /> · por pagar{' '}
                      <Money minor={b.debt} currency={b.currency} />
                    </>
                  ) : (
                    'Cómo funciona y cómo solicitarlo'
                  )}
                </p>
              </span>
              <Icon name="chevron-right" />
            </a>
          </div>
        </div>

        <div>
          {active.length || cartGroups.length ? (
            <section aria-labelledby="pm-continue">
              <div className="pm-section-head">
                <h2 id="pm-continue">Tus compras</h2>
                <a href="/personal/actividad?filtro=pedidos">Ver todas</a>
              </div>
              <ul className="pm-list">
                {active.slice(0, 3).map((o) => (
                  <li key={o.order_id}>
                    <a className="pm-row" href={`/personal/pedidos/${o.order_id}`}>
                      <span className="pm-row-ico" aria-hidden="true">
                        <Icon name="bag" />
                      </span>
                      <span className="pm-row-body">
                        <p className="pm-row-title">
                          {o.shop_name} · #{o.number}
                        </p>
                        <p className="pm-row-sub">{OUTCOME[o.outcome].label}</p>
                      </span>
                      <span className="pm-row-end">
                        <Money minor={o.total} currency={o.currency} className="pm-amount" />
                      </span>
                    </a>
                  </li>
                ))}
                {cartGroups.slice(0, 2).map((g) => (
                  <li key={`${g.shop_slug}-${g.currency}`}>
                    <a className="pm-row" href="/personal/carrito">
                      <span className="pm-row-ico" aria-hidden="true">
                        <Icon name="cart" />
                      </span>
                      <span className="pm-row-body">
                        <p className="pm-row-title">Carrito en {g.shop_name}</p>
                        <p className="pm-row-sub">
                          {g.lines.reduce((n, l) => n + l.quantity, 0)} artículos sin pagar
                        </p>
                      </span>
                      <span className="pm-row-end">
                        <Money minor={g.total} currency={g.currency} className="pm-amount" />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section
            className={active.length || cartGroups.length ? 'pm-section' : undefined}
            aria-labelledby="pm-recent"
          >
            <div className="pm-section-head">
              <h2 id="pm-recent">Actividad reciente</h2>
              <a href="/personal/actividad">Ver toda</a>
            </div>
            {recent.length === 0 ? (
              <div className="pm-card">
                <p style={{ margin: 0 }}>Todavía no hay movimientos. Empieza ingresando fondos.</p>
              </div>
            ) : (
              <ul className="pm-list">
                {recent.slice(0, 4).map((m) => (
                  <li key={m.entry_id}>
                    <div className="pm-row">
                      <span className="pm-row-ico" aria-hidden="true">
                        <Icon name={m.direction === 'in' ? 'in' : 'out'} />
                      </span>
                      <span className="pm-row-body">
                        <p className="pm-row-title">{m.description}</p>
                        <p className="pm-row-sub">{shortDate(m.created_at)}</p>
                      </span>
                      <span className="pm-row-end">
                        <span
                          className="pm-amount"
                          style={{
                            color:
                              m.account === 'debt'
                                ? 'var(--fl-credit)'
                                : m.direction === 'in'
                                  ? 'var(--fl-ok)'
                                  : undefined,
                          }}
                        >
                          {m.direction === 'in' ? '+' : '−'}
                          <Money minor={m.amount} currency={m.currency} />
                        </span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {featured.kind === 'ok' && featured.data.data.length ? (
        <section className="pm-section" aria-labelledby="pm-home-shops">
          <div className="pm-section-head">
            <h2 id="pm-home-shops">En Tiendas</h2>
            <a href="/personal/tiendas">Explorar</a>
          </div>
          <ul className="pm-grid">
            {featured.data.data.slice(0, 4).map((p) => (
              <li key={p.id}>
                <ProductCard product={p} showShop />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
