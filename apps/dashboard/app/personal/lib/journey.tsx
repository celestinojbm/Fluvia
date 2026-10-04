import { Icon } from '../../lib/icons';
import { dateTime } from './format';
import { Money } from './shop-ui';

/**
 * La operación completa vista por el cliente (`GET /v1/personal/journeys/:ref`).
 * Todos los estados vienen del servidor (fuentes canónicas del comercio y del
 * emisor); esta pantalla solo los nombra.
 */
export interface Journey {
  journey_ref: string;
  channel: 'shop' | 'pos' | 'restaurant' | 'in_person' | 'payment_link';
  order_number: number | null;
  created_at: string;
  merchant: { name: string; slug: string | null; market: string | null };
  currency: string;
  total: string;
  lines: Array<{
    name: string;
    variant_label: string | null;
    quantity: number;
    unit_price: string;
    line_total: string;
  }>;
  payment: {
    state: string;
    outcome: string;
    intent_id: string | null;
    amount_refunded: string;
    method: 'fluvia_card' | 'external_card' | null;
    attempts: Array<{ number: number; status: string; created_at: string; updated_at: string }>;
  };
  refunds: Array<{
    id: string;
    amount: string;
    status: string;
    created_at: string;
    resolved_at: string | null;
  }>;
  uncertain: Array<{
    kind: 'payment' | 'refund';
    status: 'uncertain' | 'in_progress';
    since: string;
    last_verification: { at: string; verdict: string; by: string } | null;
    next_step: string;
  }>;
  issuer: {
    authorization_id: string;
    status: string;
    amount: string;
    wallet_amount: string;
    credit_amount: string;
    captured: string;
    refunded: string;
    installments_count: number | null;
    decline_code: string | null;
  } | null;
  verified_at: string;
}

/** Devolución: lo que significa cada estado canónico para el cliente. */
export const REFUND_STATUS: Record<string, { label: string; tone: string; text: string }> = {
  created: {
    label: 'En curso',
    tone: 'warn',
    text: 'El comercio la inició. Todavía no se ha movido dinero.',
  },
  processing: {
    label: 'En curso',
    tone: 'warn',
    text: 'Se está procesando con la red. No la des por hecha hasta verla confirmada.',
  },
  indeterminate: {
    label: 'Sin confirmar',
    tone: 'warn',
    text: 'La red no respondió. Se verifica antes de darla por hecha o por fallida.',
  },
  succeeded: { label: 'Devuelta', tone: 'ok', text: 'Confirmada por la red.' },
  failed: {
    label: 'No se pudo devolver',
    tone: 'bad',
    text: 'La red la rechazó. El pago sigue como estaba; habla con la tienda.',
  },
  canceled: {
    label: 'No procesada',
    tone: 'neutral',
    text: 'El comercio no tenía fondos liquidados para devolver. No se movió dinero.',
  },
};

const VERDICT: Record<string, string> = {
  approved: 'la red confirmó el cobro',
  declined: 'la red lo rechazó',
  pending: 'la red aún no decide',
  unknown: 'la red no tiene registro',
  no_response: 'la red no respondió',
};

/**
 * Motivo del rechazo del emisor, para la propia clienta: todos los códigos
 * describen el estado de SU tarjeta o cuenta (ninguno es una señal de riesgo).
 * Un código desconocido no inventa motivo: queda el texto genérico.
 */
export const DECLINE_REASON: Record<string, string> = {
  card_limit_exceeded: 'Superaba el límite por compra o diario que fijaste en tu tarjeta.',
  insufficient_funds: 'No había saldo ni crédito suficiente en ese momento.',
  credit_limit_exceeded: 'El importe superaba tu crédito disponible.',
  card_blocked: 'La tarjeta está bloqueada.',
  card_closed: 'La tarjeta ya no está en uso.',
  card_inactive: 'La tarjeta aún no está activada.',
  consumer_inactive: 'Tu cuenta no está activa; escribe a soporte.',
  currency_not_supported: 'La tarjeta no opera en la moneda del pedido.',
  amount_above_code_limit: 'El importe superaba el máximo del código de pago.',
  invalid_payment_code: 'El código de pago ya no era válido.',
};

export function methodLabel(j: Pick<Journey, 'payment' | 'issuer'>): string {
  if (j.payment.method === 'external_card') return 'Otra tarjeta (checkout de la tienda)';
  if (j.payment.method === 'fluvia_card') {
    return j.issuer?.installments_count && BigInt(j.issuer.credit_amount) > 0n
      ? `Tarjeta Fluvia · ${j.issuer.installments_count} ${j.issuer.installments_count === 1 ? 'cuota' : 'cuotas'}`
      : 'Tarjeta Fluvia · saldo propio';
  }
  return 'Sin pago todavía';
}

/**
 * Pago, devoluciones e inciertos de la operación. El cliente ve su reparto
 * (saldo propio / crédito); nunca se suman garantía ni crédito al saldo.
 */
export function JourneyPanel({ j }: { j: Journey }) {
  const cur = j.currency;
  return (
    <section className="pm-card pm-journey" aria-labelledby="pm-journey-title">
      <div className="pm-journey-head">
        <h2 id="pm-journey-title">Pago y devoluciones</h2>
        <span className="pm-tag is-sim" title="Dinero simulado: ningún banco ni red real">
          Sandbox
        </span>
      </div>

      {j.uncertain.map((u, i) => (
        <div key={i} className="pm-banner is-warn" role="status">
          <Icon name="clock" />
          <p>
            <strong>
              {u.kind === 'payment' ? 'Pago sin confirmar' : 'Devolución sin confirmar'}
            </strong>
            {u.next_step}{' '}
            <span className="pm-muted">
              {u.last_verification
                ? `Última verificación: ${dateTime(u.last_verification.at)} (${VERDICT[u.last_verification.verdict] ?? u.last_verification.verdict}).`
                : 'Aún no se ha verificado.'}
            </span>
          </p>
        </div>
      ))}

      <dl className="pm-totals">
        <div>
          <dt>Método</dt>
          <dd>{methodLabel(j)}</dd>
        </div>
        {j.issuer && j.issuer.status !== 'declined' ? (
          <>
            <div>
              <dt>De tu saldo propio</dt>
              <dd>
                <Money minor={j.issuer.wallet_amount} currency={cur} />
              </dd>
            </div>
            {BigInt(j.issuer.credit_amount) > 0n ? (
              <div className="is-credit">
                <dt>Con tu crédito (deuda)</dt>
                <dd>
                  <Money minor={j.issuer.credit_amount} currency={cur} />
                </dd>
              </div>
            ) : null}
          </>
        ) : null}
        {BigInt(j.payment.amount_refunded) > 0n ? (
          <div>
            <dt>Devuelto (confirmado)</dt>
            <dd>
              <Money minor={j.payment.amount_refunded} currency={cur} />
            </dd>
          </div>
        ) : null}
      </dl>

      {j.refunds.length ? (
        <ul className="pm-lines" aria-label="Devoluciones">
          {j.refunds.map((r) => {
            const st = REFUND_STATUS[r.status] ?? { label: r.status, tone: 'neutral', text: '' };
            return (
              <li key={r.id} className="pm-line">
                <div className="pm-line-body">
                  <p className="pm-line-name">
                    Devolución · <span className={`pm-state is-${st.tone}`}>{st.label}</span>
                  </p>
                  <p className="pm-muted">
                    {st.text} {dateTime(r.resolved_at ?? r.created_at)}
                  </p>
                </div>
                <span style={{ fontWeight: 800 }}>
                  <Money minor={r.amount} currency={cur} />
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <p className="pm-journey-foot">
        Leído del servidor {dateTime(j.verified_at)} · Ref. ••••{j.journey_ref.slice(-4)}
      </p>
    </section>
  );
}
