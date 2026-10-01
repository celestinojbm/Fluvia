import { readOps } from '../../lib/server';
import { Failed, St, money, when } from '../../lib/ui';

export const dynamic = 'force-dynamic';

interface Auth {
  id: string;
  consumer_id: string;
  currency: string;
  amount: string;
  status: string;
  decline_code: string | null;
  wallet_amount: string;
  credit_amount: string;
  captured_wallet: string;
  captured_credit: string;
  refunded_wallet: string;
  refunded_credit: string;
  outstanding: string;
  merchant_name: string;
  source: string;
  network_ref: string;
  created_at: string;
  events?: {
    id: string;
    kind: string;
    amount: string;
    wallet_part: string;
    credit_part: string;
    idempotency_key: string;
    created_at: string;
  }[];
}

export default async function Transacciones({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ estado?: string; id?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const r = await readOps<{ data: Auth[] }>(
    orgId,
    `/authorizations${sp.estado ? `?status=${sp.estado}` : ''}`
  );
  if (r.kind !== 'ok') return <Failed />;
  const detail = sp.id
    ? await readOps<{
        authorization: Auth;
        plans: { id: string; status: string; outstanding: string; currency: string }[];
      }>(orgId, `/authorizations/${sp.id}`)
    : null;
  const base = `/operaciones/${orgId}/transacciones`;
  return (
    <main aria-labelledby="ox-tx">
      <div className="ox-head">
        <div>
          <p className="ox-eyebrow">Transacciones</p>
          <h1 id="ox-tx">Autorizaciones, capturas y devoluciones</h1>
        </div>
      </div>
      {detail && detail.kind === 'ok' ? (
        <section aria-labelledby="ox-txd" style={{ marginBottom: 24 }}>
          <h2 id="ox-txd" className="ox-eyebrow">
            Detalle · {detail.data.authorization.merchant_name}
          </h2>
          <dl className="ox-kv">
            <div>
              <dt>Estado</dt>
              <dd>
                <St s={detail.data.authorization.status} />
              </dd>
            </div>
            <div>
              <dt>Autorizado</dt>
              <dd>{money(detail.data.authorization.amount, detail.data.authorization.currency)}</dd>
            </div>
            <div>
              <dt>Saldo / crédito</dt>
              <dd>
                {money(detail.data.authorization.wallet_amount, detail.data.authorization.currency)}{' '}
                /{' '}
                {money(detail.data.authorization.credit_amount, detail.data.authorization.currency)}
              </dd>
            </div>
            <div>
              <dt>Reservado sin capturar</dt>
              <dd>
                {money(detail.data.authorization.outstanding, detail.data.authorization.currency)}
              </dd>
            </div>
            <div>
              <dt>Referencia de red</dt>
              <dd className="ox-mono">{detail.data.authorization.network_ref}</dd>
            </div>
          </dl>
          <div className="ox-table-wrap" style={{ marginTop: 10 }}>
            <table className="ox-table is-stack">
              <thead>
                <tr>
                  <th>Evento</th>
                  <th className="ox-num">Importe</th>
                  <th className="ox-num">Saldo propio</th>
                  <th className="ox-num">Crédito</th>
                  <th>Clave</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {(detail.data.authorization.events ?? []).map((e) => (
                  <tr key={e.id}>
                    <td data-label="Evento">
                      {e.kind === 'capture'
                        ? 'Captura'
                        : e.kind === 'refund'
                          ? 'Devolución'
                          : e.kind === 'expire'
                            ? 'Expiración'
                            : 'Reverso'}
                    </td>
                    <td data-label="Importe" className="ox-num">
                      {money(e.amount, detail.data.authorization.currency)}
                    </td>
                    <td data-label="Saldo propio" className="ox-num">
                      {money(e.wallet_part, detail.data.authorization.currency)}
                    </td>
                    <td data-label="Crédito" className="ox-num ox-credit">
                      {money(e.credit_part, detail.data.authorization.currency)}
                    </td>
                    <td data-label="Clave" className="ox-mono">
                      {e.idempotency_key}
                    </td>
                    <td data-label="Fecha">{when(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <nav className="ox-filters" aria-label="Estado">
        {[
          ['', 'Todas'],
          ['approved', 'Autorizadas'],
          ['partially_captured', 'Captura parcial'],
          ['captured', 'Capturadas'],
          ['declined', 'Rechazadas'],
          ['reversed', 'Liberadas'],
        ].map(([v, l]) => (
          <a
            key={v}
            href={v ? `${base}?estado=${v}` : base}
            aria-current={(sp.estado ?? '') === v ? 'true' : undefined}
          >
            {l}
          </a>
        ))}
      </nav>
      {r.data.data.length === 0 ? (
        <div className="ox-empty">Sin transacciones en este filtro.</div>
      ) : (
        <div className="ox-table-wrap">
          <table className="ox-table is-stack">
            <thead>
              <tr>
                <th>Comercio</th>
                <th>Estado</th>
                <th className="ox-num">Importe</th>
                <th className="ox-num">Saldo propio</th>
                <th className="ox-num">Crédito</th>
                <th className="ox-num">Devuelto</th>
                <th>Origen</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {r.data.data.map((a) => (
                <tr key={a.id}>
                  <td data-label="Comercio">
                    <a href={`${base}?id=${a.id}`}>{a.merchant_name}</a>
                    <div className="ox-muted">
                      <a href={`/operaciones/${orgId}/clientes/${a.consumer_id}`}>Cliente</a>
                    </div>
                  </td>
                  <td data-label="Estado">
                    <St s={a.status} />
                    {a.decline_code ? <div className="ox-muted">{a.decline_code}</div> : null}
                  </td>
                  <td data-label="Importe" className="ox-num">
                    {money(a.amount, a.currency)}
                  </td>
                  <td data-label="Saldo propio" className="ox-num">
                    {money(a.wallet_amount, a.currency)}
                  </td>
                  <td data-label="Crédito" className="ox-num ox-credit">
                    {money(a.credit_amount, a.currency)}
                  </td>
                  <td data-label="Devuelto" className="ox-num">
                    {money(
                      (BigInt(a.refunded_wallet) + BigInt(a.refunded_credit)).toString(),
                      a.currency
                    )}
                  </td>
                  <td data-label="Origen">
                    {a.source === 'fluvia_checkout' ? 'Comercio Fluvia' : 'Red'}
                  </td>
                  <td data-label="Fecha">{when(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
