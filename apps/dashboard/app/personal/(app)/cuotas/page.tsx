import {
  INSTALLMENT_STATUS,
  DECLINE_TEXT,
  PURCHASE_STATUS,
  dateTime,
  money,
  shortDate,
  Status,
} from '../../lib/format';
import { ErrorPanel } from '../../lib/panels';
import { readPersonal } from '../../lib/server';
import type { Authorization, Plan } from '../../lib/types';
import { RepayForm } from './repay-form';

export const dynamic = 'force-dynamic';

const PLAN_STATUS = {
  active: { label: 'En curso', tone: 'credit' },
  paid: { label: 'Terminado', tone: 'ok' },
  cancelled: { label: 'Anulado por devolución', tone: 'neutral' },
} as const;

export default async function Cuotas() {
  const [plans, purchases] = await Promise.all([
    readPersonal<{ data: Plan[] }>('/credit/plans'),
    readPersonal<{ data: Authorization[] }>('/purchases'),
  ]);
  if (plans.kind !== 'ok' || purchases.kind !== 'ok') return <ErrorPanel />;
  const active = plans.data.data.filter((p) => p.status === 'active');
  const done = plans.data.data.filter((p) => p.status !== 'active');
  const owed = new Map<string, bigint>();
  for (const p of active)
    owed.set(p.currency, (owed.get(p.currency) ?? 0n) + BigInt(p.outstanding));

  return (
    <main aria-labelledby="px-cuotas">
      <div className="px-head">
        <div>
          <p className="px-eyebrow">Compras y cuotas</p>
          <h1 id="px-cuotas">Tus cuotas</h1>
        </div>
      </div>

      {owed.size > 0 ? (
        <section className="px-credit" aria-labelledby="px-owed" style={{ marginTop: 0 }}>
          <h2 id="px-owed">Te queda por pagar</h2>
          {[...owed.entries()].map(([ccy, v]) => (
            <p key={ccy} className="px-credit-amount">
              {money(v.toString(), ccy)}
            </p>
          ))}
          <RepayForm
            currencies={[...owed.keys()]}
            plans={active.map((p) => ({
              id: p.id,
              label: `${p.merchant_name} · ${money(p.outstanding, p.currency)}`,
              currency: p.currency,
            }))}
          />
        </section>
      ) : (
        <div className="px-empty">
          <p>No tienes cuotas pendientes.</p>
          <a className="px-btn" href="/personal/tarjetas?accion=pagar">
            Pagar en cuotas en un comercio
          </a>
        </div>
      )}

      {active.length > 0 ? (
        <section className="px-section" aria-labelledby="px-active">
          <h2 id="px-active">Planes en curso</h2>
          {active.map((p) => (
            <PlanCard key={p.id} plan={p} />
          ))}
        </section>
      ) : null}

      <section className="px-section" aria-labelledby="px-purch">
        <h2 id="px-purch">Compras</h2>
        {purchases.data.data.length === 0 ? (
          <div className="px-empty">
            <p>Aún no has comprado con tu tarjeta.</p>
          </div>
        ) : (
          <ul className="px-list">
            {purchases.data.data.map((a) => {
              const refunded = BigInt(a.refunded_wallet) + BigInt(a.refunded_credit);
              return (
                <li key={a.id}>
                  <div className="px-grow">
                    <p className="px-title">{a.merchant_name}</p>
                    <p className="px-sub">
                      {dateTime(a.created_at)}
                      {BigInt(a.credit_amount) > 0n
                        ? ` · ${money(a.wallet_amount, a.currency)} con saldo + ${money(a.credit_amount, a.currency)} con crédito`
                        : ''}
                      {refunded > 0n ? ` · devuelto ${money(refunded.toString(), a.currency)}` : ''}
                      {a.decline_code ? ` · ${DECLINE_TEXT[a.decline_code] ?? ''}` : ''}
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
              );
            })}
          </ul>
        )}
      </section>

      {done.length > 0 ? (
        <section className="px-section" aria-labelledby="px-done">
          <h2 id="px-done">Planes terminados</h2>
          {done.map((p) => (
            <PlanCard key={p.id} plan={p} />
          ))}
        </section>
      ) : null}
    </main>
  );
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <article className="px-plan" aria-labelledby={`plan-${plan.id}`}>
      <header>
        <div>
          <h3 id={`plan-${plan.id}`}>{plan.merchant_name}</h3>
          <p className="px-muted" style={{ margin: 0 }}>
            {shortDate(plan.created_at)} · financiado {money(plan.principal, plan.currency)}
            {BigInt(plan.down_payment) > 0n
              ? ` · inicial ${money(plan.down_payment, plan.currency)}`
              : ''}{' '}
            · interés {plan.interest_bps / 100}%
          </p>
        </div>
        <Status {...PLAN_STATUS[plan.status]} />
      </header>
      <ol className="px-steps">
        {plan.installments.map((i) => (
          <li key={i.id}>
            Cuota {i.seq} · {shortDate(i.due_date)}
            <strong>
              {money(
                i.status === 'paid' || i.status === 'cancelled' ? i.amount : i.outstanding,
                plan.currency
              )}
            </strong>
            <Status {...INSTALLMENT_STATUS[i.status]!} />
          </li>
        ))}
      </ol>
    </article>
  );
}
