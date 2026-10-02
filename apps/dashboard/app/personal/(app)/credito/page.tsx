import { Icon } from '../../../lib/icons';
import { dateTime, money, Status } from '../../lib/format';
import { ErrorPanel } from '../../lib/panels';
import { readPersonal } from '../../lib/server';
import type { Application, Balance, Line } from '../../lib/types';
import { CollateralForms, ApplyForm } from './credit-forms';

export const dynamic = 'force-dynamic';

interface CreditView {
  lines: Line[];
  applications: Application[];
  policy: {
    code: string;
    version: number;
    synthetic: boolean;
    pending_commercial_validation: boolean;
    params: {
      max_multiplier_bps: number;
      tiers: { tier: string; multiplier_bps: number | null }[];
      down_payment_bps: number;
      interest_bps: number;
      grace_days: number;
    };
  };
}

const APP_STATUS = {
  approved: { label: 'Aprobada', tone: 'ok' },
  rejected: { label: 'No aprobada', tone: 'bad' },
  manual_review: { label: 'En revisión', tone: 'warn' },
} as const;

export default async function Credito() {
  const [credit, balances] = await Promise.all([
    readPersonal<CreditView>('/credit'),
    readPersonal<{ data: Balance[] }>('/wallet/balances'),
  ]);
  if (credit.kind !== 'ok' || balances.kind !== 'ok') return <ErrorPanel />;
  const { lines, applications, policy } = credit.data;
  const p = policy.params;
  return (
    <main aria-labelledby="px-credit-page">
      <div className="px-head">
        <div>
          <p className="px-eyebrow">Crédito y garantía</p>
          <h1 id="px-credit-page">Tu crédito</h1>
        </div>
      </div>

      <section className="px-card" aria-labelledby="px-how">
        <h2 id="px-how" style={{ marginTop: 0, fontSize: '1rem' }}>
          Cómo funciona
        </h2>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
          <li>
            Bloqueas una <strong>garantía</strong> con tu dinero propio. Sigue siendo tuyo: no es un
            pago ni una inicial.
          </li>
          <li>
            Pides un límite. La política decide según tu perfil y tu historial en Fluvia; con
            garantía, el límite puede llegar hasta {p.max_multiplier_bps / 10_000}× la garantía como
            máximo (no es automático).
          </li>
          <li>
            Compras en cuotas: pagas una inicial con tu saldo y el resto según el calendario que
            aceptas.
          </li>
          <li>Puedes liberar la garantía que no respalde lo que debes o tienes reservado.</li>
        </ol>
        <p className="px-alert px-alert-warn" style={{ marginTop: 12 }}>
          Política de prueba «{policy.code}» v{policy.version}:{' '}
          {policy.synthetic ? 'datos y reglas sintéticas' : ''}. Interés {p.interest_bps / 100}%,
          inicial {p.down_payment_bps / 100}%, gracia {p.grace_days} días.{' '}
          {policy.pending_commercial_validation
            ? 'Pendiente de validación comercial: no son condiciones ofrecidas al público.'
            : ''}
        </p>
      </section>

      {lines.map((l) => (
        <section key={l.id} className="px-credit" aria-labelledby={`line-${l.id}`}>
          <h2 id={`line-${l.id}`}>
            <Icon name="shield" /> Línea en {l.currency} · nivel {l.risk_tier} · ×
            {l.multiplier_bps / 10_000}
          </h2>
          <p className="px-credit-amount">{money(l.available, l.currency)}</p>
          <p className="px-muted" style={{ margin: 0 }}>
            disponible {l.status !== 'active' ? '· línea congelada por Fluvia' : ''}
          </p>
          <dl>
            <div>
              <dt>Límite aprobado</dt>
              <dd>{money(l.approved_limit, l.currency)}</dd>
            </div>
            <div>
              <dt>Usado (deuda)</dt>
              <dd>{money(l.utilized, l.currency)}</dd>
            </div>
            <div>
              <dt>Reservado</dt>
              <dd>{money(l.reserved, l.currency)}</dd>
            </div>
            <div>
              <dt>Garantía bloqueada</dt>
              <dd>{money(l.collateral, l.currency)}</dd>
            </div>
            <div>
              <dt>Garantía comprometida</dt>
              <dd>{money(l.required_collateral, l.currency)}</dd>
            </div>
            <div>
              <dt>Puedes liberar</dt>
              <dd>{money(l.releasable_collateral, l.currency)}</dd>
            </div>
          </dl>
        </section>
      ))}

      <div className="px-home px-section">
        <CollateralForms balances={balances.data.data} />
        <ApplyForm currencies={balances.data.data.map((b) => b.currency)} />
      </div>

      <section className="px-section" aria-labelledby="px-apps">
        <h2 id="px-apps">Solicitudes</h2>
        {applications.length === 0 ? (
          <div className="px-empty">
            <p>Aún no has pedido crédito.</p>
          </div>
        ) : (
          <ul className="px-list">
            {applications.map((a) => (
              <li key={a.id} style={{ alignItems: 'flex-start' }}>
                <div className="px-grow">
                  <p className="px-title">
                    {money(a.requested_limit, a.currency)} solicitado
                    {a.approved_limit ? ` · ${money(a.approved_limit, a.currency)} aprobado` : ''}
                  </p>
                  <p className="px-sub">
                    {dateTime(a.created_at)} · nivel {a.risk_tier} · política{' '}
                    {a.decision.policy.code} v{a.decision.policy.version}
                  </p>
                  <ul
                    style={{
                      margin: '6px 0 0',
                      paddingLeft: 18,
                      fontSize: '0.86rem',
                      color: 'var(--fl-ink-2)',
                    }}
                  >
                    {a.decision.reasons.map((r) => (
                      <li key={r.code}>{r.message}</li>
                    ))}
                  </ul>
                </div>
                <Status {...APP_STATUS[a.status]} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
