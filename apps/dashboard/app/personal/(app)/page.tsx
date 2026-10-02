import { Icon } from '../../lib/icons';
import { money, shortDate, Status, INSTALLMENT_STATUS, CARD_STATUS } from '../lib/format';
import { readPersonal } from '../lib/server';
import type { Application, Balance, Card, Installment, StatementLine } from '../lib/types';
import { ErrorPanel } from '../lib/panels';
import { CardRail } from '../../lib/card-rail';
import { CATEGORIES } from '../../lib/categories';
import { MerchantCard, PhotoCard } from '../../lib/public-cards';
import { searchDirectory } from '../../lib/public-api';
import '../../publico.css';

export const dynamic = 'force-dynamic';

interface Overview {
  balances: Balance[];
  upcoming: (Installment & { currency: string; merchant_name: string })[];
  cards: Card[];
  pending_application: Application | null;
  recent: StatementLine[];
}

function pct(part: bigint, total: bigint): string {
  if (total <= 0n) return '0%';
  return `${Number((part * 10000n) / total) / 100}%`;
}

export default async function PersonalHome({
  searchParams,
}: {
  searchParams: Promise<{ moneda?: string }>;
}) {
  const sp = await searchParams;
  const [r, discover] = await Promise.all([
    readPersonal<Overview>('/overview'),
    searchDirectory({}),
  ]);
  if (r.kind !== 'ok') return <ErrorPanel />;
  const { balances, upcoming, cards, pending_application, recent } = r.data;
  const b = balances.find((x) => x.currency === sp.moneda) ?? balances[0];
  if (!b) return <ErrorPanel />;
  const available = BigInt(b.available);
  const held = BigInt(b.held);
  const collateral = BigInt(b.collateral);
  const own = available + held + collateral;
  const c = b.credit;
  const limit = c ? BigInt(c.approved_limit) : 0n;

  return (
    <main aria-labelledby="px-home-title">
      <div className="px-head">
        <div>
          <p className="px-eyebrow">Inicio</p>
          <h1 id="px-home-title">Tu dinero</h1>
        </div>
      </div>

      {pending_application ? (
        <p className="px-alert px-alert-info" role="status">
          Tu solicitud de crédito está en revisión por una persona del equipo. Te mostraremos la
          decisión aquí.
        </p>
      ) : null}

      <div className="px-home">
        <div>
          <section className="px-hero" aria-labelledby="px-own">
            {balances.length > 1 ? (
              <nav className="px-currency-switch" aria-label="Moneda">
                {balances.map((x) => (
                  <a
                    key={x.currency}
                    href={`/personal?moneda=${x.currency}`}
                    aria-current={x.currency === b.currency ? 'true' : undefined}
                  >
                    {x.currency}
                  </a>
                ))}
              </nav>
            ) : null}
            <p className="px-eyebrow" id="px-own">
              Saldo propio disponible · {b.currency}
            </p>
            <p className="px-hero-amount">{money(b.available, b.currency)}</p>
            <div className="px-hero-actions">
              <a className="px-btn px-btn-primary" href="/personal/movimientos?accion=ingresar">
                <Icon name="in" /> Ingresar
              </a>
              <a className="px-btn" href="/personal/movimientos?accion=enviar">
                <Icon name="send" /> Enviar
              </a>
              <a className="px-btn px-btn-lime" href="/personal/tarjetas?accion=pagar">
                <Icon name="card" /> Pagar en comercio
              </a>
            </div>
          </section>

          <section className="px-split" aria-labelledby="px-own-split">
            <h2 id="px-own-split" className="px-eyebrow" style={{ margin: '0 0 10px' }}>
              Tu dinero propio · {money(own.toString(), b.currency)}
            </h2>
            <div className="px-split-bar" role="img" aria-label="Composición de tu dinero propio">
              <span className="px-seg-available" style={{ width: pct(available, own) }} />
              <span className="px-seg-held" style={{ width: pct(held, own) }} />
              <span className="px-seg-collateral" style={{ width: pct(collateral, own) }} />
            </div>
            <dl>
              <div>
                <dt>
                  <span className="px-key px-seg-available" /> Disponible
                </dt>
                <dd>{money(b.available, b.currency)}</dd>
              </div>
              <div>
                <dt>
                  <span className="px-key px-seg-held" /> Retenido por compras o retiros
                </dt>
                <dd>{money(b.held, b.currency)}</dd>
              </div>
              <div>
                <dt>
                  <span className="px-key px-seg-collateral" /> Garantía bloqueada
                </dt>
                <dd>{money(b.collateral, b.currency)}</dd>
              </div>
            </dl>
          </section>

          <section className="px-credit" aria-labelledby="px-credit-title">
            <h2 id="px-credit-title">
              <Icon name="shield" /> Crédito
            </h2>
            {c ? (
              <>
                <p className="px-credit-amount">{money(c.available, b.currency)}</p>
                <p className="px-muted" style={{ margin: '0 0 8px' }}>
                  disponible para comprar {c.status !== 'active' ? '· línea congelada' : ''}
                </p>
                <div className="px-credit-meter" role="img" aria-label="Uso de tu crédito">
                  <span
                    className="px-credit-used"
                    style={{ width: pct(BigInt(c.utilized), limit) }}
                  />
                  <span
                    className="px-credit-reserved"
                    style={{ width: pct(BigInt(c.reserved), limit) }}
                  />
                </div>
                <dl>
                  <div>
                    <dt>Límite aprobado</dt>
                    <dd>{money(c.approved_limit, b.currency)}</dd>
                  </div>
                  <div>
                    <dt>Te queda por pagar</dt>
                    <dd>{money(b.debt, b.currency)}</dd>
                  </div>
                  <div>
                    <dt>Reservado por compras</dt>
                    <dd>{money(c.reserved, b.currency)}</dd>
                  </div>
                </dl>
                <p className="px-credit-note">
                  El crédito no es saldo propio: lo que usas se paga en cuotas.
                </p>
              </>
            ) : (
              <>
                <p className="px-muted">Aún no tienes una línea de crédito en {b.currency}.</p>
                <a className="px-btn px-btn-credit" href="/personal/credito">
                  Conocer cómo funciona
                </a>
              </>
            )}
          </section>
        </div>

        <div>
          <section aria-labelledby="px-next">
            <h2 id="px-next" className="px-eyebrow">
              Próximos pagos
            </h2>
            {upcoming.length === 0 ? (
              <div className="px-empty">
                <p>No tienes cuotas pendientes.</p>
              </div>
            ) : (
              <ul className="px-list">
                {upcoming.map((i) => {
                  const d = new Date(`${i.due_date}T00:00:00Z`);
                  return (
                    <li key={i.id}>
                      <span
                        className={`px-date-chip${i.status === 'overdue' ? ' is-overdue' : ''}`}
                        aria-hidden="true"
                      >
                        <strong>{d.getUTCDate()}</strong>
                        {shortDate(i.due_date).split(' ')[1]}
                      </span>
                      <div className="px-grow">
                        <p className="px-title">{i.merchant_name}</p>
                        <p className="px-sub">
                          Cuota {i.seq} · vence {shortDate(i.due_date)}
                        </p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <p className="px-amount" style={{ margin: 0 }}>
                          {money(i.outstanding, i.currency)}
                        </p>
                        <Status {...INSTALLMENT_STATUS[i.status]!} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {upcoming.length > 0 ? (
              <p style={{ marginTop: 10 }}>
                <a href="/personal/cuotas">Pagar cuotas</a>
              </p>
            ) : null}
          </section>

          <section className="px-section" aria-labelledby="px-cards-mini">
            <h2 id="px-cards-mini" className="px-eyebrow">
              Tarjetas
            </h2>
            {cards.length === 0 ? (
              <div className="px-empty">
                <p>Pide tu tarjeta virtual y úsala al instante en comercios Fluvia.</p>
                <a className="px-btn px-btn-primary" href="/personal/tarjetas">
                  Pedir tarjeta
                </a>
              </div>
            ) : (
              <ul className="px-list">
                {cards.map((k) => (
                  <li key={k.id}>
                    <span className="px-icon-chip" aria-hidden="true">
                      <Icon name="card" />
                    </span>
                    <div className="px-grow">
                      <p className="px-title">
                        {k.form === 'virtual' ? 'Virtual' : 'Física'} •••• {k.last4 ?? '····'}
                      </p>
                      <p className="px-sub">{k.currency}</p>
                    </div>
                    <Status {...CARD_STATUS[k.status]!} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="px-section" aria-labelledby="px-recent">
            <h2 id="px-recent" className="px-eyebrow">
              Actividad reciente
            </h2>
            {recent.length === 0 ? (
              <div className="px-empty">
                <p>Todavía no hay movimientos. Empieza ingresando fondos.</p>
              </div>
            ) : (
              <ul className="px-list">
                {recent.map((m) => (
                  <li key={m.entry_id}>
                    <span
                      className={`px-icon-chip${m.account === 'debt' ? ' is-credit' : m.direction === 'out' ? ' is-out' : ''}`}
                      aria-hidden="true"
                    >
                      <Icon name={m.direction === 'in' ? 'in' : 'out'} />
                    </span>
                    <div className="px-grow">
                      <p className="px-title">{m.description}</p>
                      <p className="px-sub">{shortDate(m.created_at)}</p>
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
            <p style={{ marginTop: 10 }}>
              <a href="/personal/movimientos">Ver todos los movimientos</a>
            </p>
          </section>
        </div>
      </div>

      {/* Descubrimiento comercial: aparte del dinero; solo comercios publicados. */}
      <section className="px-section px-discover" aria-labelledby="px-discover">
        <div className="px-discover-head">
          <div>
            <h2 id="px-discover" className="px-eyebrow">
              Descubre dónde comprar
            </h2>
            <p className="px-muted" style={{ margin: 0 }}>
              Comercios que publicaron su perfil en Fluvia.
            </p>
          </div>
          <a className="pb-more" href="/donde-comprar">
            Ver todos <Icon name="arrow-right" size={16} />
          </a>
        </div>
        {discover.kind === 'ok' && discover.data.data.length > 0 ? (
          <CardRail label="Comercios publicados">
            {discover.data.data.slice(0, 8).map((e) => (
              <li key={e.slug}>
                <MerchantCard entry={e} />
              </li>
            ))}
            {CATEGORIES.slice(0, 4).map((c) => (
              <li key={c.slug}>
                <PhotoCard
                  href={`/donde-comprar?categoria=${c.slug}`}
                  photo={c.photo}
                  alt={c.alt}
                  title={c.label}
                  text={c.blurb}
                />
              </li>
            ))}
          </CardRail>
        ) : discover.kind === 'ok' ? (
          <div className="px-empty">
            <p>Aún no hay comercios publicados.</p>
          </div>
        ) : (
          <div className="px-empty" role="status">
            <p>No pudimos cargar el directorio ahora. Tu dinero no se ve afectado.</p>
          </div>
        )}
      </section>
    </main>
  );
}
