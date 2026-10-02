import { OpsAction } from '../../../lib/ops-action';
import { readOps } from '../../../lib/server';
import type { CaseRow, ConsumerRow } from '../../../lib/types';
import { CASE_TYPE, Failed, Sandbox, St, money, when } from '../../../lib/ui';

export const dynamic = 'force-dynamic';

interface Detail {
  consumer: ConsumerRow;
  balances: {
    currency: string;
    available: string;
    held: string;
    collateral: string;
    debt: string;
    credit: {
      approved_limit: string;
      utilized: string;
      reserved: string;
      available: string;
      status: string;
    } | null;
  }[];
  lines: {
    id: string;
    currency: string;
    status: string;
    approved_limit: string;
    utilized: string;
    reserved: string;
    available: string;
    multiplier_bps: number;
    risk_tier: string;
    collateral: string;
    required_collateral: string;
    releasable_collateral: string;
  }[];
  cards: {
    id: string;
    currency: string;
    form: string;
    status: string;
    last4: string | null;
    blocked_by: string | null;
    funding_mode: string;
    shipment: { status: string; city: string } | null;
  }[];
  applications: {
    id: string;
    currency: string;
    requested_limit: string;
    status: string;
    risk_tier: string;
    approved_limit: string | null;
    decision: { reasons: { code: string; message: string }[] };
    created_at: string;
  }[];
  plans: {
    id: string;
    currency: string;
    principal: string;
    down_payment: string;
    merchant_name: string;
    status: string;
    outstanding: string;
    installments: {
      seq: number;
      amount: string;
      outstanding: string;
      due_date: string;
      status: string;
    }[];
  }[];
  authorizations: {
    id: string;
    currency: string;
    amount: string;
    status: string;
    decline_code: string | null;
    wallet_amount: string;
    credit_amount: string;
    merchant_name: string;
    created_at: string;
  }[];
  cases: CaseRow[];
  audit: {
    id: string;
    action: string;
    actor_type: string;
    actor_id: string | null;
    result: string;
    reason: string | null;
    created_at: string;
  }[];
  transfers: {
    id: string;
    kind: string;
    direction: string;
    currency: string;
    amount: string;
    status: string;
    destination_masked: string | null;
    created_at: string;
  }[];
  fundings: {
    id: string;
    currency: string;
    amount: string;
    status: string;
    provider_ref: string;
    reference: string;
    created_at: string;
  }[];
}

export default async function Cliente360({
  params,
}: {
  params: Promise<{ orgId: string; id: string }>;
}) {
  const { orgId, id } = await params;
  const r = await readOps<Detail>(orgId, `/consumers/${id}`);
  if (r.kind !== 'ok') return <Failed />;
  const d = r.data;
  const c = d.consumer;
  return (
    <main aria-labelledby="ox-360">
      <Sandbox />
      <header className="ox-identity">
        <div>
          <p className="ox-eyebrow">Cliente</p>
          <h1 id="ox-360">{c.display_name}</h1>
          <p className="ox-muted" style={{ margin: 0 }}>
            {c.email} · <span className="ox-mono">{c.id}</span>
          </p>
        </div>
        <St s={c.status} />
        <span className="ox-muted">Perfil sintético {c.synthetic_risk_profile}</span>
        <span className="ox-muted">Alta {when(c.created_at)}</span>
      </header>
      <ul className="ox-anchors" aria-label="Secciones">
        {[
          ['saldos', 'Saldos'],
          ['credito', 'Crédito'],
          ['tarjetas', 'Tarjetas'],
          ['compras', 'Compras y cuotas'],
          ['wallet', 'Ingresos y retiros'],
          ['casos', 'Casos'],
          ['auditoria', 'Auditoría'],
        ].map(([h, l]) => (
          <li key={h}>
            <a href={`#${h}`}>{l}</a>
          </li>
        ))}
      </ul>

      <div className="ox-360 ox-section">
        <div>
          <section id="saldos" aria-labelledby="ox-bal">
            <h2 id="ox-bal" className="ox-eyebrow">
              Saldos (ledger)
            </h2>
            <div
              className="ox-table-wrap"
              tabIndex={0}
              role="group"
              aria-label="Tabla (desplazable con teclado)"
            >
              <table className="ox-table is-stack">
                <thead>
                  <tr>
                    <th>Moneda</th>
                    <th className="ox-num">Disponible</th>
                    <th className="ox-num">Retenido</th>
                    <th className="ox-num">Garantía</th>
                    <th className="ox-num">Deuda</th>
                    <th className="ox-num">Crédito disponible</th>
                  </tr>
                </thead>
                <tbody>
                  {d.balances.map((b) => (
                    <tr key={b.currency}>
                      <td data-label="Moneda">{b.currency}</td>
                      <td data-label="Disponible" className="ox-num">
                        {money(b.available, b.currency)}
                      </td>
                      <td data-label="Retenido" className="ox-num">
                        {money(b.held, b.currency)}
                      </td>
                      <td data-label="Garantía" className="ox-num">
                        {money(b.collateral, b.currency)}
                      </td>
                      <td data-label="Deuda" className="ox-num ox-credit">
                        {money(b.debt, b.currency)}
                      </td>
                      <td data-label="Crédito disponible" className="ox-num">
                        {b.credit ? money(b.credit.available, b.currency) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id="credito" className="ox-section" aria-labelledby="ox-cred">
            <h2 id="ox-cred">Líneas de crédito</h2>
            {d.lines.length === 0 ? (
              <div className="ox-empty">Sin línea de crédito.</div>
            ) : (
              d.lines.map((l) => (
                <div key={l.id} style={{ marginBottom: 12 }}>
                  <dl className="ox-kv">
                    <div>
                      <dt>Línea {l.currency}</dt>
                      <dd>
                        <St s={l.status} /> · nivel {l.risk_tier} · ×{l.multiplier_bps / 10_000}
                      </dd>
                    </div>
                    <div>
                      <dt>Límite</dt>
                      <dd>{money(l.approved_limit, l.currency)}</dd>
                    </div>
                    <div>
                      <dt>Usado</dt>
                      <dd className="ox-credit">{money(l.utilized, l.currency)}</dd>
                    </div>
                    <div>
                      <dt>Reservado</dt>
                      <dd>{money(l.reserved, l.currency)}</dd>
                    </div>
                    <div>
                      <dt>Disponible</dt>
                      <dd>{money(l.available, l.currency)}</dd>
                    </div>
                    <div>
                      <dt>Garantía / comprometida</dt>
                      <dd>
                        {money(l.collateral, l.currency)} /{' '}
                        {money(l.required_collateral, l.currency)}
                      </dd>
                    </div>
                  </dl>
                  <div className="ox-row" style={{ marginTop: 8 }}>
                    <OpsAction
                      orgId={orgId}
                      path={`lines/${l.id}/limit`}
                      label="Cambiar límite"
                      fields={[
                        {
                          name: 'new_limit',
                          label: `Nuevo límite (${l.currency})`,
                          type: 'amount',
                        },
                      ]}
                      success="Límite actualizado."
                    />
                    <OpsAction
                      orgId={orgId}
                      path={`lines/${l.id}/status`}
                      label={l.status === 'active' ? 'Congelar línea' : 'Reactivar línea'}
                      tone={l.status === 'active' ? 'danger' : 'default'}
                      extra={{ status: l.status === 'active' ? 'frozen' : 'active' }}
                      success="Estado de la línea actualizado."
                    />
                    <a className="ox-btn" href={`/operaciones/${orgId}/solicitudes?linea=${l.id}`}>
                      Historial de límites
                    </a>
                  </div>
                </div>
              ))
            )}
            {d.applications.length > 0 ? (
              <div
                className="ox-table-wrap"
                tabIndex={0}
                role="group"
                aria-label="Tabla (desplazable con teclado)"
                style={{ marginTop: 12 }}
              >
                <table className="ox-table is-stack">
                  <thead>
                    <tr>
                      <th>Solicitud</th>
                      <th>Estado</th>
                      <th>Explicación</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.applications.map((a) => (
                      <tr key={a.id}>
                        <td data-label="Solicitud">
                          {money(a.requested_limit, a.currency)}
                          <div className="ox-muted">
                            {when(a.created_at)} · nivel {a.risk_tier}
                          </div>
                        </td>
                        <td data-label="Estado">
                          <St s={a.status} />
                          {a.approved_limit ? (
                            <div className="ox-muted">{money(a.approved_limit, a.currency)}</div>
                          ) : null}
                        </td>
                        <td data-label="Explicación">
                          <ul className="ox-reasons">
                            {a.decision.reasons.map((x) => (
                              <li key={x.code}>{x.message}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          <section id="tarjetas" className="ox-section" aria-labelledby="ox-cards">
            <h2 id="ox-cards">Tarjetas</h2>
            {d.cards.length === 0 ? (
              <div className="ox-empty">Sin tarjetas.</div>
            ) : (
              <div
                className="ox-table-wrap"
                tabIndex={0}
                role="group"
                aria-label="Tabla (desplazable con teclado)"
              >
                <table className="ox-table is-stack">
                  <thead>
                    <tr>
                      <th>Tarjeta</th>
                      <th>Estado</th>
                      <th>Envío</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.cards.map((k) => (
                      <tr key={k.id}>
                        <td data-label="Tarjeta">
                          {k.form === 'virtual' ? 'Virtual' : 'Física'} •••• {k.last4 ?? '····'} ·{' '}
                          {k.currency}
                        </td>
                        <td data-label="Estado">
                          <St s={k.status} />
                          {k.blocked_by ? (
                            <div className="ox-muted">
                              por {k.blocked_by === 'operator' ? 'Operaciones' : 'el cliente'}
                            </div>
                          ) : null}
                        </td>
                        <td data-label="Envío">
                          {k.shipment ? <St s={k.shipment.status} /> : '—'}
                        </td>
                        <td data-label="Acciones">
                          <div className="ox-row">
                            {k.status === 'active' || k.status === 'inactive' ? (
                              <OpsAction
                                orgId={orgId}
                                path={`cards/${k.id}/block`}
                                label="Bloquear"
                                tone="danger"
                                success="Tarjeta bloqueada."
                              />
                            ) : null}
                            {k.status === 'blocked' ? (
                              <OpsAction
                                orgId={orgId}
                                path={`cards/${k.id}/unblock`}
                                label="Desbloquear"
                                success="Tarjeta desbloqueada."
                              />
                            ) : null}
                            {k.shipment &&
                            ['requested', 'produced', 'shipped'].includes(k.shipment.status) ? (
                              <OpsAction
                                orgId={orgId}
                                path={`cards/${k.id}/shipment`}
                                label="Avanzar envío"
                                reason={false}
                                extra={{
                                  status:
                                    k.shipment.status === 'requested'
                                      ? 'produced'
                                      : k.shipment.status === 'produced'
                                        ? 'shipped'
                                        : 'delivered',
                                }}
                                success="Envío actualizado."
                              />
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section id="compras" className="ox-section" aria-labelledby="ox-buy">
            <h2 id="ox-buy">Compras y cuotas</h2>
            {d.authorizations.length === 0 ? (
              <div className="ox-empty">Sin compras.</div>
            ) : (
              <div
                className="ox-table-wrap"
                tabIndex={0}
                role="group"
                aria-label="Tabla (desplazable con teclado)"
              >
                <table className="ox-table is-stack">
                  <thead>
                    <tr>
                      <th>Comercio</th>
                      <th>Estado</th>
                      <th className="ox-num">Importe</th>
                      <th className="ox-num">Saldo propio</th>
                      <th className="ox-num">Crédito</th>
                      <th>Fecha</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.authorizations.map((a) => (
                      <tr key={a.id}>
                        <td data-label="Comercio">
                          <a href={`/operaciones/${orgId}/transacciones?id=${a.id}`}>
                            {a.merchant_name}
                          </a>
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
                        <td data-label="Fecha">{when(a.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.plans.map((p) => (
              <div key={p.id} className="ox-kv" style={{ marginTop: 10 }}>
                <div>
                  <dt>Plan · {p.merchant_name}</dt>
                  <dd>
                    <St s={p.status} />
                  </dd>
                </div>
                <div>
                  <dt>Financiado / inicial</dt>
                  <dd>
                    {money(p.principal, p.currency)} / {money(p.down_payment, p.currency)}
                  </dd>
                </div>
                <div>
                  <dt>Pendiente</dt>
                  <dd className="ox-credit">{money(p.outstanding, p.currency)}</dd>
                </div>
                {p.installments.map((i) => (
                  <div key={i.seq}>
                    <dt>
                      Cuota {i.seq} · {i.due_date}
                    </dt>
                    <dd>
                      {money(i.amount, p.currency)} <St s={i.status} />
                    </dd>
                  </div>
                ))}
              </div>
            ))}
          </section>

          <section id="wallet" className="ox-section" aria-labelledby="ox-wal">
            <h2 id="ox-wal">Ingresos y retiros</h2>
            <div
              className="ox-table-wrap"
              tabIndex={0}
              role="group"
              aria-label="Tabla (desplazable con teclado)"
            >
              <table className="ox-table is-stack">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>Estado</th>
                    <th className="ox-num">Importe</th>
                    <th>Referencia</th>
                    <th>Fecha</th>
                    <th>Sandbox</th>
                  </tr>
                </thead>
                <tbody>
                  {d.fundings.map((f) => (
                    <tr key={f.id}>
                      <td data-label="Tipo">Ingreso</td>
                      <td data-label="Estado">
                        <St s={f.status} />
                      </td>
                      <td data-label="Importe" className="ox-num">
                        {money(f.amount, f.currency)}
                      </td>
                      <td data-label="Referencia" className="ox-mono">
                        {f.reference}
                      </td>
                      <td data-label="Fecha">{when(f.created_at)}</td>
                      <td data-label="Sandbox">
                        {f.status === 'pending' ? (
                          <OpsAction
                            orgId={orgId}
                            path="sandbox/provider-events"
                            label="Simular confirmación del banco"
                            reason={false}
                            extra={{
                              source: 'funding',
                              event_type: 'funding.confirmed',
                              payload: {
                                provider_ref: f.provider_ref,
                                amount: f.amount,
                                currency: f.currency,
                              },
                            }}
                            success="Evento del banco simulado e ingerido."
                          />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {d.transfers.map((t) => (
                    <tr key={t.id}>
                      <td data-label="Tipo">
                        {t.kind === 'withdrawal'
                          ? `Retiro ${t.destination_masked ?? ''}`
                          : t.direction === 'in'
                            ? 'Transferencia recibida'
                            : 'Transferencia enviada'}
                      </td>
                      <td data-label="Estado">
                        <St s={t.status} />
                      </td>
                      <td data-label="Importe" className="ox-num">
                        {money(t.amount, t.currency)}
                      </td>
                      <td data-label="Referencia" className="ox-mono">
                        {t.id.slice(0, 8)}
                      </td>
                      <td data-label="Fecha">{when(t.created_at)}</td>
                      <td data-label="Sandbox">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id="casos" className="ox-section" aria-labelledby="ox-cs">
            <h2 id="ox-cs">Casos</h2>
            {d.cases.length === 0 ? (
              <div className="ox-empty">Sin casos.</div>
            ) : (
              <ul className="ox-reasons" style={{ fontSize: '0.88rem' }}>
                {d.cases.map((x) => (
                  <li key={x.id}>
                    <a href={`/operaciones/${orgId}/casos?id=${x.id}`}>
                      {CASE_TYPE[x.case_type] ?? x.case_type}
                    </a>{' '}
                    · <St s={x.status} /> · {x.summary}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section id="auditoria" className="ox-section" aria-labelledby="ox-aud">
            <h2 id="ox-aud">Auditoría</h2>
            <div
              className="ox-table-wrap"
              tabIndex={0}
              role="group"
              aria-label="Tabla (desplazable con teclado)"
            >
              <table className="ox-table is-stack">
                <thead>
                  <tr>
                    <th>Acción</th>
                    <th>Actor</th>
                    <th>Resultado</th>
                    <th>Motivo</th>
                    <th>Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {d.audit.map((a) => (
                    <tr key={a.id}>
                      <td data-label="Acción" className="ox-mono">
                        {a.action}
                      </td>
                      <td data-label="Actor">
                        {a.actor_type === 'consumer'
                          ? 'Cliente'
                          : a.actor_type === 'user'
                            ? 'Operador'
                            : 'Sistema'}
                      </td>
                      <td data-label="Resultado">
                        <St s={a.result === 'success' ? 'applied' : 'failed'} />
                      </td>
                      <td data-label="Motivo">{a.reason ?? '—'}</td>
                      <td data-label="Fecha">{when(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="ox-actions-pane" aria-labelledby="ox-acts">
          <h2 id="ox-acts">Acciones</h2>
          <p className="ox-muted" style={{ margin: 0 }}>
            Las acciones sensibles piden tu contraseña (step-up) y quedan auditadas con el motivo.
          </p>
          {c.status === 'active' ? (
            <OpsAction
              orgId={orgId}
              path={`consumers/${id}/status`}
              label="Suspender cliente"
              tone="danger"
              extra={{ status: 'suspended' }}
              success="Cliente suspendido."
            />
          ) : (
            <OpsAction
              orgId={orgId}
              path={`consumers/${id}/status`}
              label="Reactivar cliente"
              extra={{ status: 'active' }}
              success="Cliente reactivado."
            />
          )}
          <OpsAction
            orgId={orgId}
            path={`consumers/${id}/collateral-applications`}
            label="Proponer aplicar garantía a deuda vencida"
            fields={[
              {
                name: 'currency',
                label: 'Moneda',
                type: 'select',
                options: d.balances.map((b) => ({ value: b.currency, label: b.currency })),
              },
              { name: 'amount', label: 'Importe', type: 'amount' },
            ]}
            success="Propuesta creada: otra persona debe aprobarla en Política y aprobaciones."
          />
          <OpsAction
            orgId={orgId}
            path="cases"
            label="Abrir incidencia"
            reason={false}
            extra={{ consumer_id: id, subject_type: 'consumer', subject_id: id }}
            fields={[{ name: 'summary', label: 'Qué pasó', type: 'textarea' }]}
            success="Incidencia abierta."
          />
        </aside>
      </div>
    </main>
  );
}
