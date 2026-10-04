import { notFound } from 'next/navigation';
import { readPersonal } from '../../../../lib/server';
import { ErrorPanel } from '../../../../lib/panels';
import {
  DECLINE_TEXT,
  INSTALLMENT_STATUS,
  PURCHASE_STATUS,
  Status,
  dateTime,
  shortDate,
} from '../../../../lib/format';
import { Money, ScreenHead } from '../../../../lib/shop-ui';
import type { Authorization, Plan } from '../../../../lib/types';
import { JourneyPanel, type Journey } from '../../../../lib/journey';

export const dynamic = 'force-dynamic';

/** Detalle de una compra con tarjeta Fluvia: autorización, cobro, devoluciones y plan de cuotas. */
export default async function PurchasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [r, jr] = await Promise.all([
    readPersonal<{ authorization: Authorization; plans: Plan[] }>(`/purchases/${id}`),
    readPersonal<Journey>(`/journeys/${id}`),
  ]);
  if (r.kind === 'not_found') notFound();
  if (r.kind !== 'ok') return <ErrorPanel />;
  const a = r.data.authorization;
  const st = PURCHASE_STATUS[a.status] ?? { tone: 'neutral', label: a.status };
  const refunded = BigInt(a.refunded_wallet) + BigInt(a.refunded_credit);
  return (
    <main aria-labelledby="pm-purchase-title">
      <ScreenHead
        title={a.merchant_name}
        id="pm-purchase-title"
        back="/personal/actividad"
        backLabel="Actividad"
      />
      <section className="pm-card">
        <p style={{ margin: 0 }}>
          <Status tone={st.tone} label={st.label} />
        </p>
        <p className="pm-pdp-price" style={{ marginTop: 8 }}>
          <Money minor={a.amount} currency={a.currency} />
        </p>
        <p className="pm-muted">{dateTime(a.created_at)}</p>
        {a.status === 'approved' ? (
          <p className="pm-banner is-warn">
            Autorizada: el importe está retenido, todavía no cobrado. Si el comercio no la cobra, se
            libera.
          </p>
        ) : null}
        {a.status === 'declined' ? (
          <p className="pm-banner is-bad">
            Rechazada: {DECLINE_TEXT[a.decline_code ?? ''] ?? 'no se cobró nada'}.
          </p>
        ) : null}
        <dl className="pm-totals">
          <div>
            <dt>De tu saldo propio</dt>
            <dd>
              <Money minor={a.wallet_amount} currency={a.currency} />
            </dd>
          </div>
          <div>
            <dt>Con crédito</dt>
            <dd>
              <Money minor={a.credit_amount} currency={a.currency} />
            </dd>
          </div>
          {refunded > 0n ? (
            <div>
              <dt>Devuelto</dt>
              <dd>
                <Money minor={refunded.toString()} currency={a.currency} />
              </dd>
            </div>
          ) : null}
        </dl>
      </section>
      {jr.kind === 'ok' ? (
        <>
          {jr.data.lines.length ? (
            <section className="pm-card" aria-labelledby="pm-purchase-lines">
              <h2 id="pm-purchase-lines">
                {jr.data.order_number ? `Pedido #${jr.data.order_number}` : 'Lo que compraste'}
              </h2>
              <ul className="pm-lines">
                {jr.data.lines.map((l, i) => (
                  <li key={i} className="pm-line">
                    <div className="pm-line-body">
                      <p className="pm-line-name">
                        {l.name}
                        {l.variant_label ? ` · ${l.variant_label}` : ''}
                      </p>
                      <p className="pm-muted">
                        {l.quantity} × <Money minor={l.unit_price} currency={jr.data.currency} />
                      </p>
                    </div>
                    <Money minor={l.line_total} currency={jr.data.currency} />
                  </li>
                ))}
              </ul>
              {jr.data.channel === 'shop' ? (
                <a
                  className="pm-cta is-ghost is-block"
                  href={`/personal/pedidos/${jr.data.journey_ref}`}
                  style={{ marginTop: 12 }}
                >
                  Ver el pedido y la entrega
                </a>
              ) : null}
            </section>
          ) : null}
          <JourneyPanel j={jr.data} />
        </>
      ) : null}
      {r.data.plans.map((p) => (
        <section key={p.id} className="pm-card" aria-label="Plan de cuotas">
          <h2>Cuotas</h2>
          <p className="pm-muted" style={{ marginTop: -6 }}>
            Inicial <Money minor={p.down_payment} currency={p.currency} /> · {p.installments_count}{' '}
            cuotas cada {p.interval_days} días · interés{' '}
            {(p.interest_bps / 100).toLocaleString('es-VE')} %
          </p>
          <ul className="pm-lines">
            {p.installments.map((i) => (
              <li key={i.id} className="pm-line">
                <div className="pm-line-body">
                  <p className="pm-line-name">Cuota {i.seq}</p>
                  <p className="pm-muted">Vence {shortDate(i.due_date)}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <Money minor={i.amount} currency={p.currency} />
                  <br />
                  <Status {...INSTALLMENT_STATUS[i.status]!} />
                </div>
              </li>
            ))}
          </ul>
          <a className="pm-cta is-ghost is-block" href="/personal/cuotas" style={{ marginTop: 12 }}>
            Ir a Cuotas
          </a>
        </section>
      ))}
    </main>
  );
}
