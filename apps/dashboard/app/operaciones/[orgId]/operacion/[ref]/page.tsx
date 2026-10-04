import { notFound } from 'next/navigation';
import { OpsAction } from '../../../lib/ops-action';
import { readOps } from '../../../lib/server';
import { CASE_TYPE, Failed, St, money, when } from '../../../lib/ui';

export const dynamic = 'force-dynamic';

/** `GET /v1/programs/:org/journeys/:ref` (proyección de Operaciones). */
interface OpsJourney {
  journey_ref: string;
  sale_id: string;
  channel: string;
  order_number: number | null;
  created_at: string;
  merchant: { name: string; market: string | null };
  currency: string;
  total: string;
  payment: {
    state: string;
    outcome: string;
    intent_id: string | null;
    amount_refunded: string;
    method: string | null;
    attempts: Array<{
      id: string;
      provider_ref: string | null;
      number: number;
      status: string;
      updated_at: string;
    }>;
  };
  refunds: Array<{ id: string; amount: string; status: string; created_at: string }>;
  fulfillment: { kind: string; status: string; buyer_name?: string } | null;
  uncertain: Array<{
    kind: 'payment' | 'refund';
    subject_id: string;
    status: string;
    since: string;
    last_verification: { at: string; verdict: string; by: string } | null;
    next_step: string;
    resolvers: string[];
    issuer_record?: string;
  }>;
  issuer: {
    authorization_id: string;
    status: string;
    amount: string;
    wallet_amount: string;
    credit_amount: string;
    refunded: string;
    installments_count: number | null;
    consumer_id: string;
    network_ref: string;
  } | null;
  ledger: Array<{
    side: 'merchant' | 'program';
    tx_id: string;
    key: string;
    reason: string;
    at: string;
  }>;
  cases: Array<{ id: string; type: string; status: string; summary: string; created_at: string }>;
  verified_at: string;
}

const CHANNEL: Record<string, string> = {
  shop: 'Tienda en línea',
  pos: 'Venta en caja',
  restaurant: 'Restaurante',
  in_person: 'Cobro presencial',
  payment_link: 'Enlace de cobro',
};
const OUTCOME: Record<string, string> = {
  approved: 'Cobrado',
  pending: 'Sin confirmar',
  declined: 'Último intento rechazado',
  unpaid: 'Sin cobro',
  cancelled: 'Anulado',
  partially_refunded: 'Devolución parcial',
  refunded: 'Devuelto',
};
const VERDICT: Record<string, string> = {
  approved: 'aprobó',
  declined: 'rechazó',
  pending: 'aún sin decisión',
  unknown: 'no la conoce',
  no_response: 'no respondió',
};
const BY: Record<string, string> = {
  automatic: 'automática',
  merchant_user: 'pedida por el comercio',
  operator_user: 'pedida por Operaciones',
};
const short = (id: string) => `••••${id.slice(-4)}`;

/**
 * Un caso visto por Operaciones: el pedido y el cobro del comercio junto a la
 * autorización del emisor, con los asientos de ambos lados. Tres zonas que no
 * se mezclan:
 *  - CONSULTA: lo que dicen hoy las fuentes (solo lectura).
 *  - PROPUESTA: un caso abierto con la decisión que se propone (no ejecuta nada).
 *  - DECISIÓN EJECUTADA: lo que aplicó una verificación del proveedor.
 * Ninguna acción de esta pantalla mueve dinero por sí misma.
 */
export default async function OperacionPage({
  params,
}: {
  params: Promise<{ orgId: string; ref: string }>;
}) {
  const { orgId, ref } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(ref)) notFound();
  const r = await readOps<OpsJourney>(orgId, `/journeys/${ref}`);
  if (r.kind === 'not_found') notFound();
  if (r.kind !== 'ok') return <Failed />;
  const j = r.data;
  const executed = j.payment.attempts.filter(
    (a) => a.status === 'succeeded' || a.status === 'failed'
  );
  return (
    <main aria-labelledby="ox-op">
      <div className="ox-head">
        <div>
          <p className="ox-eyebrow">
            Operación · {CHANNEL[j.channel] ?? j.channel} · mercado {j.merchant.market ?? '—'}
          </p>
          <h1 id="ox-op">
            {j.merchant.name}
            {j.order_number ? ` · pedido #${j.order_number}` : ''}
          </h1>
          <p className="ox-muted">
            {money(j.total, j.currency)} · {when(j.created_at)} · referencia {short(j.journey_ref)}
          </p>
        </div>
        <span
          className={`ox-status ox-${j.payment.outcome === 'approved' ? 'ok' : j.payment.outcome === 'pending' ? 'warn' : 'neutral'}`}
        >
          {OUTCOME[j.payment.outcome] ?? j.payment.outcome}
        </span>
      </div>

      {j.uncertain.length ? (
        <section className="ox-op-alert" aria-labelledby="ox-op-unc" role="status">
          <h2 id="ox-op-unc">Desenlace sin verificar</h2>
          {j.uncertain.map((u) => (
            <p key={u.subject_id}>
              <strong>
                {u.kind === 'payment' ? 'Cobro' : 'Devolución'} {short(u.subject_id)}
              </strong>{' '}
              sin respuesta verificada desde {when(u.since)}. {u.next_step} Pueden resolverlo: la
              verificación automática, el comercio (conciliación) u Operaciones (con step-up).
            </p>
          ))}
        </section>
      ) : null}

      <div className="ox-op-grid">
        <section className="ox-op-col" aria-labelledby="ox-op-q">
          <h2 id="ox-op-q">
            <span className="ox-op-step">1</span> Consulta
          </h2>
          <p className="ox-muted">Lo que dicen ahora las fuentes. Solo lectura.</p>
          <dl className="ox-kv">
            <dt>Cobro del comercio</dt>
            <dd>
              <St s={j.payment.state} /> {j.payment.intent_id ? short(j.payment.intent_id) : ''}
            </dd>
            <dt>Método</dt>
            <dd>
              {j.payment.method === 'fluvia_card'
                ? 'Tarjeta Fluvia (red Fluvia simulada)'
                : j.payment.method === 'external_card'
                  ? 'Otra tarjeta (proveedor simulado)'
                  : '—'}
            </dd>
            {j.issuer ? (
              <>
                <dt>Autorización del emisor</dt>
                <dd>
                  <St s={j.issuer.status} /> {short(j.issuer.authorization_id)}
                </dd>
                <dt>Saldo propio / crédito</dt>
                <dd>
                  {money(j.issuer.wallet_amount, j.currency)} /{' '}
                  <span className="ox-credit">{money(j.issuer.credit_amount, j.currency)}</span>
                  {j.issuer.installments_count ? ` · ${j.issuer.installments_count} cuotas` : ''}
                </dd>
                <dt>Cliente</dt>
                <dd>
                  <a href={`/operaciones/${orgId}/clientes/${j.issuer.consumer_id}`}>
                    Ficha {short(j.issuer.consumer_id)}
                  </a>
                </dd>
              </>
            ) : null}
            {j.fulfillment ? (
              <>
                <dt>Entrega</dt>
                <dd>
                  {j.fulfillment.kind === 'pickup' ? 'Retiro' : 'Envío'} ·{' '}
                  <St s={j.fulfillment.status} />
                </dd>
              </>
            ) : null}
          </dl>
          {j.uncertain.some((u) => u.issuer_record) ? (
            <table className="ox-table">
              <caption className="ox-muted">Comercio frente a emisor</caption>
              <thead>
                <tr>
                  <th>Intento</th>
                  <th>Comercio</th>
                  <th>Emisor</th>
                  <th>Última verificación</th>
                </tr>
              </thead>
              <tbody>
                {j.uncertain
                  .filter((u) => u.kind === 'payment')
                  .map((u) => (
                    <tr key={u.subject_id}>
                      <td className="ox-mono">{short(u.subject_id)}</td>
                      <td>
                        <St s="indeterminate" />
                      </td>
                      <td>
                        {u.issuer_record === 'no_record' ? (
                          'Sin registro'
                        ) : (
                          <St s={u.issuer_record ?? ''} />
                        )}
                      </td>
                      <td>
                        {u.last_verification
                          ? `${when(u.last_verification.at)} · la red ${VERDICT[u.last_verification.verdict] ?? u.last_verification.verdict} (${BY[u.last_verification.by] ?? u.last_verification.by})`
                          : 'Nunca'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : null}
        </section>

        <section className="ox-op-col" aria-labelledby="ox-op-p">
          <h2 id="ox-op-p">
            <span className="ox-op-step">2</span> Propuesta
          </h2>
          <p className="ox-muted">
            Deja escrita la decisión que propones. Abre un caso; no ejecuta nada.
          </p>
          {j.cases.length ? (
            <ul className="ox-op-list">
              {j.cases.map((c) => (
                <li key={c.id}>
                  <a href={`/operaciones/${orgId}/casos?id=${c.id}`}>
                    {CASE_TYPE[c.type] ?? c.type}
                  </a>{' '}
                  <St s={c.status} />
                  <br />
                  <span className="ox-muted">{c.summary}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ox-muted">Sin casos abiertos sobre esta operación.</p>
          )}
          {j.issuer ? (
            <OpsAction
              orgId={orgId}
              path="cases"
              label="Proponer una decisión"
              reason={false}
              fields={[
                {
                  name: 'summary',
                  label: 'Propuesta (qué y por qué)',
                  type: 'textarea',
                  required: true,
                  placeholder: 'p. ej. Esperar la verificación; si la red confirma, entregar.',
                },
              ]}
              extra={{
                consumer_id: j.issuer.consumer_id,
                subject_type: 'card_authorization',
                subject_id: j.issuer.authorization_id,
              }}
              success="Propuesta registrada como caso."
            />
          ) : null}
        </section>

        <section className="ox-op-col" aria-labelledby="ox-op-x">
          <h2 id="ox-op-x">
            <span className="ox-op-step">3</span> Decisión ejecutada
          </h2>
          <p className="ox-muted">
            Solo una respuesta verificada del proveedor cierra un incierto, por la vía canónica.
          </p>
          <ul className="ox-op-list">
            {executed.map((a) => (
              <li key={a.id}>
                Intento {a.number} · <St s={a.status} /> · {when(a.updated_at)}
              </li>
            ))}
            {j.refunds.map((x) => (
              <li key={x.id}>
                Devolución {money(x.amount, j.currency)} · <St s={x.status} />
              </li>
            ))}
            {!executed.length && !j.refunds.length ? (
              <li className="ox-muted">Nada ejecutado todavía.</li>
            ) : null}
          </ul>
          {j.uncertain.length ? (
            <OpsAction
              orgId={orgId}
              path={`journeys/${j.journey_ref}/verify`}
              label="Verificar con la red"
              reason={false}
              tone="primary"
              confirm="Se consultará al proveedor y se aplicará SOLO lo que responda. ¿Continuar?"
              success="Consulta hecha. Recargando con el resultado verificado."
            />
          ) : null}
        </section>
      </div>

      <section className="ox-section" aria-labelledby="ox-op-ledger">
        <h2 id="ox-op-ledger">Asientos del ledger</h2>
        <p className="ox-muted">
          Clave idempotente de cada asiento: comercio (<code>attempt:</code>, <code>refund:</code>)
          y programa (<code>auth:</code>). Se leen; no se escriben desde aquí.
        </p>
        <div
          className="ox-table-wrap"
          tabIndex={0}
          role="group"
          aria-label="Asientos (desplazable)"
        >
          <table className="ox-table">
            <thead>
              <tr>
                <th>Lado</th>
                <th>Motivo</th>
                <th>Clave</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {j.ledger.map((l) => (
                <tr key={`${l.side}-${l.tx_id}`}>
                  <td>{l.side === 'merchant' ? 'Comercio' : 'Programa'}</td>
                  <td>{l.reason}</td>
                  <td className="ox-mono">
                    {l.key.replace(
                      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
                      (x) => short(x)
                    )}
                  </td>
                  <td>{when(l.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="ox-muted">Leído {when(j.verified_at)}.</p>
      </section>
    </main>
  );
}
