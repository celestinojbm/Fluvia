import { currencyLabel } from '../../../lib/fx';
import { Equivalence } from '../../../lib/fx-ui';
import { Icon } from '../../../lib/icons';
import { shortDate } from '../../lib/format';
import { readPersonal } from '../../lib/server';
import { ErrorPanel } from '../../lib/panels';
import { Money, ScreenHead } from '../../lib/shop-ui';
import type { Balance, Installment, Me } from '../../lib/types';
import type { ShopOrder } from '../../lib/shop-types';

export const dynamic = 'force-dynamic';

interface Capability {
  key: string;
  label: string;
  status: 'sandbox' | 'operational' | 'pending_provider' | 'not_offered';
  simulated: boolean;
  live_dependency: string;
}

const CAP_STATUS: Record<Capability['status'], string> = {
  sandbox: 'Simulado (sandbox)',
  operational: 'Operativo',
  pending_provider: 'Pendiente de socio',
  not_offered: 'No ofrecido',
};

/**
 * Detalle de saldos. Cinco cifras que NUNCA se suman entre sí:
 *  1. saldo propio disponible (tu dinero, se puede gastar);
 *  2. garantía (tu dinero, bloqueado como respaldo);
 *  3. crédito: límite aprobado y disponible (no es tu dinero);
 *  4. deuda usada y próximos vencimientos;
 *  5. pendiente o sin confirmar (retenido por operaciones en curso).
 * Una cuenta por moneda REAL; la moneda de visualización solo añade una
 * equivalencia marcada como tal.
 */
export default async function BalancesPage() {
  const [ov, me, orders, caps] = await Promise.all([
    readPersonal<{
      balances: Balance[];
      upcoming: (Installment & { currency: string; merchant_name: string })[];
    }>('/overview'),
    readPersonal<Me>('/me'),
    readPersonal<{ data: ShopOrder[] }>('/shop/orders'),
    readPersonal<{ market: string; data: Capability[] }>('/capabilities?market=VE'),
  ]);
  if (ov.kind !== 'ok') return <ErrorPanel />;
  const policy = me.kind === 'ok' ? me.data.policy : null;
  const pending = (orders.kind === 'ok' ? orders.data.data : []).filter(
    (o) => o.outcome === 'pending'
  );
  const tiers = (policy?.tiers ?? []).filter((t) => t.multiplier_bps !== null);
  const capsById = new Map((caps.kind === 'ok' ? caps.data.data : []).map((c) => [c.key, c]));

  return (
    <main aria-labelledby="pm-bal-title">
      <ScreenHead title="Tus saldos" id="pm-bal-title" back="/personal" backLabel="Inicio" />
      <p className="pm-banner is-sim" role="note">
        <Icon name="flag" />
        <span>
          <strong>Sandbox: todas las cifras son simuladas.</strong>
          Ningún banco custodia este dinero y no hay crédito real concedido.
        </span>
      </p>

      {ov.data.balances.map((b) => {
        const c = b.credit;
        const upcoming = ov.data.upcoming.filter((u) => u.currency === b.currency);
        const pendingHere = pending.filter((o) => o.currency === b.currency);
        return (
          <section key={b.currency} className="pm-ledger" aria-labelledby={`pm-acc-${b.currency}`}>
            <header className="pm-ledger-head">
              <h2 id={`pm-acc-${b.currency}`}>Cuenta en {currencyLabel(b.currency)}</h2>
              <span className="pm-tag">{b.currency}</span>
            </header>

            <div className="pm-ledger-grid">
              <article className="pm-ledger-cell is-own">
                <h3>Saldo propio disponible</h3>
                <p className="pm-ledger-amount">
                  <Money minor={b.available} currency={b.currency} />
                </p>
                <Equivalence minor={b.available} currency={b.currency} />
                <p className="pm-ledger-note">
                  Tu dinero. Es lo único que puedes gastar sin deuda.
                </p>
              </article>

              <article className="pm-ledger-cell">
                <h3>Garantía bloqueada</h3>
                <p className="pm-ledger-amount">
                  <Money minor={b.collateral} currency={b.currency} />
                </p>
                <p className="pm-ledger-note">
                  Tu dinero, inmovilizado como respaldo de tu línea. No se gasta ni se suma al
                  disponible.
                </p>
                <a href="/personal/credito">Gestionar garantía</a>
              </article>

              <article className="pm-ledger-cell is-credit">
                <h3>Crédito</h3>
                {c ? (
                  <dl className="pm-totals">
                    <div>
                      <dt>Límite aprobado</dt>
                      <dd>
                        <Money minor={c.approved_limit} currency={b.currency} />
                      </dd>
                    </div>
                    <div>
                      <dt>Disponible</dt>
                      <dd>
                        <Money minor={c.available} currency={b.currency} />
                      </dd>
                    </div>
                    {BigInt(c.reserved) > 0n ? (
                      <div>
                        <dt>Reservado por compras en curso</dt>
                        <dd>
                          <Money minor={c.reserved} currency={b.currency} />
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                ) : (
                  <p className="pm-ledger-amount is-empty">Sin línea</p>
                )}
                <p className="pm-ledger-note">
                  No es tu dinero: lo que uses es deuda y se paga en cuotas.
                </p>
              </article>

              <article className="pm-ledger-cell is-debt">
                <h3>Deuda y vencimientos</h3>
                <p className="pm-ledger-amount">
                  <Money minor={b.debt} currency={b.currency} />
                </p>
                {upcoming.length ? (
                  <ul className="pm-ledger-list" aria-label="Próximos vencimientos">
                    {upcoming.slice(0, 3).map((u) => (
                      <li key={u.id}>
                        <span>
                          {shortDate(u.due_date)} · {u.merchant_name}
                          {u.status === 'overdue' ? ' · vencida' : ''}
                        </span>
                        <Money minor={u.outstanding} currency={b.currency} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="pm-ledger-note">Sin cuotas por vencer.</p>
                )}
                <a href="/personal/cuotas">Ver cuotas</a>
              </article>

              <article className="pm-ledger-cell is-pending">
                <h3>Pendiente o sin confirmar</h3>
                <p className="pm-ledger-amount">
                  <Money minor={b.held} currency={b.currency} />
                </p>
                <p className="pm-ledger-note">
                  Retenido por compras o retiros en curso. No está gastado ni disponible hasta que
                  la red confirme.
                </p>
                {pendingHere.length ? (
                  <ul className="pm-ledger-list" aria-label="Pagos sin confirmar">
                    {pendingHere.map((o) => (
                      <li key={o.order_id}>
                        <a href={`/personal/pedidos/${o.order_id}`}>
                          {o.shop_name} · #{o.number} · en confirmación
                        </a>
                        <Money minor={o.total} currency={o.currency} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            </div>
          </section>
        );
      })}

      {policy && tiers.length ? (
        <section className="pm-card" aria-labelledby="pm-bal-policy">
          <h2 id="pm-bal-policy">Cómo se calcula un límite (referencia)</h2>
          <p style={{ marginTop: 0 }}>
            Con la política vigente
            {policy.synthetic ? ' (sintética, de prueba)' : ''}
            {policy.pending_commercial_validation ? ', pendiente de validación comercial' : ''}, por
            cada <strong>100</strong> que aportas como garantía, el límite{' '}
            <strong>puede llegar</strong> hasta:
          </p>
          <ul className="pm-ledger-list">
            {tiers.map((t) => (
              <li key={t.tier}>
                <span>Nivel {t.tier}</span>
                <strong>{Math.round(((t.multiplier_bps ?? 0) / 10_000) * 100)}</strong>
              </li>
            ))}
          </ul>
          <p className="pm-muted" style={{ marginBottom: 0 }}>
            Es un máximo, no una concesión: depende de tu elegibilidad y de una aprobación. Aportar
            100 no te da 400 automáticamente, y la garantía nunca se suma a tu saldo disponible.
          </p>
        </section>
      ) : null}

      {capsById.size ? (
        <section className="pm-card" aria-labelledby="pm-bal-caps">
          <h2 id="pm-bal-caps">Qué es real y qué es simulado</h2>
          <ul className="pm-ledger-list">
            {[
              'pay.wallet',
              'credit.line',
              'card.virtual',
              'card.physical',
              'card.network_acceptance',
              'wallet.usdt',
            ].map((k) => {
              const cap = capsById.get(k);
              if (!cap) return null;
              return (
                <li key={k}>
                  <span>{cap.label}</span>
                  <span className={`pm-tag${cap.simulated ? ' is-sim' : ''}`}>
                    {CAP_STATUS[cap.status]}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
