import { VerifyJourney } from './journey-verify';
import { formatAmount } from './money-format';
import { Callout, ShortId, Status, dateTime } from './ui';

/** `GET /v1/organizations/:org/journeys/:ref` (proyección del comercio). */
export interface MerchantJourney {
  journey_ref: string;
  sale_id: string;
  channel: 'shop' | 'pos' | 'restaurant' | 'in_person' | 'payment_link';
  currency: string;
  total: string;
  payment: {
    state: string;
    outcome: string;
    intent_id: string | null;
    amount_refunded: string;
    method: 'fluvia_card' | 'external_card' | null;
    attempts: Array<{
      id: string;
      provider_ref: string | null;
      number: number;
      status: string;
      updated_at: string;
    }>;
  };
  refunds: Array<{
    id: string;
    amount: string;
    status: string;
    created_at: string;
    resolved_at: string | null;
  }>;
  fulfillment: {
    kind: 'pickup' | 'delivery';
    status: string;
    return_requested_at: string | null;
    return_reason: string | null;
    buyer_name?: string;
  } | null;
  uncertain: Array<{
    kind: 'payment' | 'refund';
    subject_id: string;
    status: string;
    since: string;
    last_verification: { at: string; verdict: string; by: string } | null;
    next_step: string;
  }>;
  ledger: Array<{ side: 'merchant'; tx_id: string; key: string; reason: string; at: string }>;
  verified_at: string;
}

const CHANNEL: Record<MerchantJourney['channel'], string> = {
  shop: 'Tienda en línea (Fluvia Tiendas)',
  pos: 'Venta en caja',
  restaurant: 'Restaurante',
  in_person: 'Cobro presencial',
  payment_link: 'Enlace de cobro',
};
const ATTEMPT: Record<string, { tone: 'ok' | 'warn' | 'bad' | 'neutral'; label: string }> = {
  succeeded: { tone: 'ok', label: 'Aprobado' },
  failed: { tone: 'bad', label: 'Rechazado' },
  indeterminate: { tone: 'warn', label: 'Sin confirmar' },
  submitting: { tone: 'warn', label: 'Enviando' },
  submitted: { tone: 'warn', label: 'Enviado' },
  created: { tone: 'neutral', label: 'Creado' },
  requires_action: { tone: 'warn', label: 'Requiere acción' },
  expired: { tone: 'neutral', label: 'Vencido' },
};
const REFUND: Record<string, { tone: 'ok' | 'warn' | 'bad' | 'neutral'; label: string }> = {
  created: { tone: 'warn', label: 'Iniciada' },
  processing: { tone: 'warn', label: 'En curso' },
  indeterminate: { tone: 'warn', label: 'Sin confirmar' },
  succeeded: { tone: 'ok', label: 'Devuelta' },
  failed: { tone: 'bad', label: 'Rechazada por la red' },
  canceled: { tone: 'neutral', label: 'No procesada (sin fondos liquidados)' },
};
const FULFILL: Record<string, string> = {
  received: 'Recibido',
  preparing: 'En preparación',
  ready: 'Listo',
  shipped: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Anulado',
};
const VERDICT: Record<string, string> = {
  approved: 'la red lo confirmó',
  declined: 'la red lo rechazó',
  pending: 'la red aún no decide',
  unknown: 'la red no lo conoce',
  no_response: 'la red no respondió',
};

/**
 * La venta como OPERACIÓN completa (mismo hecho que ven el cliente y
 * Operaciones): canal, comprador y entrega si es de la tienda, método,
 * intentos, devoluciones, asientos propios e inciertos con «Verificar».
 */
export function MerchantJourneyPanels({
  j,
  orgId,
  canVerify,
}: {
  j: MerchantJourney;
  orgId: string;
  canVerify: boolean;
}) {
  const o = `/o/${orgId}`;
  return (
    <>
      {j.uncertain.length ? (
        <Callout tone="warn" title="Desenlace sin verificar" role="status">
          {j.uncertain.map((u) => (
            <p key={u.subject_id}>
              {u.kind === 'payment' ? 'Cobro' : 'Devolución'} <ShortId id={u.subject_id} /> sin
              confirmar desde {dateTime(u.since)}.{' '}
              {u.last_verification
                ? `Última verificación ${dateTime(u.last_verification.at)}: ${VERDICT[u.last_verification.verdict] ?? u.last_verification.verdict}.`
                : 'Todavía no se ha verificado.'}{' '}
              {u.next_step}
            </p>
          ))}
          {canVerify ? <VerifyJourney orgId={orgId} journeyRef={j.journey_ref} /> : null}
        </Callout>
      ) : null}

      <section className="fx-panel" aria-labelledby="op-title">
        <header>
          <h2 id="op-title">Operación</h2>
          <span className="fx-hint">Mismo caso que ven el cliente y Operaciones</span>
        </header>
        <div className="fx-panel-body">
          <dl className="fx-dl">
            <dt>Canal</dt>
            <dd>{CHANNEL[j.channel]}</dd>
            {j.fulfillment?.buyer_name ? (
              <>
                <dt>Comprador</dt>
                <dd>{j.fulfillment.buyer_name} · cliente de Fluvia Personal</dd>
              </>
            ) : null}
            {j.fulfillment ? (
              <>
                <dt>{j.fulfillment.kind === 'pickup' ? 'Retiro' : 'Entrega'}</dt>
                <dd>
                  {FULFILL[j.fulfillment.status] ?? j.fulfillment.status} ·{' '}
                  <a href={`${o}/tienda`}>Gestionar en Tienda en línea</a>
                </dd>
              </>
            ) : null}
            {j.fulfillment?.return_requested_at ? (
              <>
                <dt>Devolución pedida</dt>
                <dd>
                  {dateTime(j.fulfillment.return_requested_at)} · «{j.fulfillment.return_reason}»
                </dd>
              </>
            ) : null}
            <dt>Método</dt>
            <dd>
              {j.payment.method === 'fluvia_card'
                ? 'Tarjeta Fluvia (red Fluvia, sandbox)'
                : j.payment.method === 'external_card'
                  ? 'Otra tarjeta (proveedor simulado)'
                  : 'Sin cobro todavía'}
            </dd>
          </dl>

          {j.payment.attempts.length ? (
            <table className="fx-table fx-table-compact" style={{ marginTop: 12 }}>
              <caption className="fx-hint fx-caption-start">Intentos de cobro</caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Referencia</th>
                  <th scope="col">Actualizado</th>
                </tr>
              </thead>
              <tbody>
                {j.payment.attempts.map((a) => {
                  const st = ATTEMPT[a.status] ?? { tone: 'neutral' as const, label: a.status };
                  return (
                    <tr key={a.id}>
                      <td>{a.number}</td>
                      <td>
                        <Status tone={st.tone} code={a.status}>
                          {st.label}
                        </Status>
                      </td>
                      <td>{a.provider_ref ? <ShortId id={a.provider_ref} /> : '—'}</td>
                      <td>{dateTime(a.updated_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}

          {j.refunds.length ? (
            <table className="fx-table fx-table-compact" style={{ marginTop: 12 }}>
              <caption className="fx-hint fx-caption-start">Devoluciones</caption>
              <thead>
                <tr>
                  <th scope="col">Importe</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {j.refunds.map((r) => {
                  const st = REFUND[r.status] ?? { tone: 'neutral' as const, label: r.status };
                  return (
                    <tr key={r.id}>
                      <td>{formatAmount(r.amount, j.currency, 'es')}</td>
                      <td>
                        <Status tone={st.tone} code={r.status}>
                          {st.label}
                        </Status>
                      </td>
                      <td>{dateTime(r.resolved_at ?? r.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}

          <details className="fx-details" style={{ marginTop: 12 }}>
            <summary>Asientos del ledger ({j.ledger.length})</summary>
            <ul className="fx-feed">
              {j.ledger.map((l) => (
                <li key={l.tx_id}>
                  <span>{l.reason}</span>
                  <code>
                    {l.key.replace(
                      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
                      (x) => `••••${x.slice(-4)}`
                    )}
                  </code>
                </li>
              ))}
            </ul>
          </details>
          <p className="fx-hint" style={{ marginTop: 8 }}>
            Leído {dateTime(j.verified_at)}. Ningún estado se marca a mano.
          </p>
        </div>
      </section>
    </>
  );
}
