import { Icon, type IconName } from '../../../lib/icons';
import { readPersonal } from '../../lib/server';
import { ErrorPanel } from '../../lib/panels';
import { DECLINE_TEXT, PURCHASE_STATUS, Status, shortDate } from '../../lib/format';
import { Money, ScreenHead } from '../../lib/shop-ui';
import { OUTCOME, type ShopOrder } from '../../lib/shop-types';
import type { Authorization, Balance, Funding, Installment, Transfer } from '../../lib/types';

export const dynamic = 'force-dynamic';

type Filter = 'todo' | 'pedidos' | 'tarjeta' | 'cuotas' | 'dinero';
const FILTERS: Array<[Filter, string]> = [
  ['todo', 'Todo'],
  ['pedidos', 'Pedidos'],
  ['tarjeta', 'Compras con tarjeta'],
  ['cuotas', 'Cuotas'],
  ['dinero', 'Ingresos y envíos'],
];

const MONTH = new Intl.DateTimeFormat('es-VE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Agrupa por mes (orden ya aplicado) para que la lista larga tenga anclas de fecha. */
function byMonth(list: Item[]): Array<readonly [string, Item[]]> {
  const out: Array<readonly [string, Item[]]> = [];
  for (const i of list) {
    const d = new Date(i.at.length === 10 ? `${i.at}T00:00:00Z` : i.at);
    const raw = Number.isNaN(d.getTime()) ? 'Sin fecha' : MONTH.format(d);
    const label = raw.charAt(0).toUpperCase() + raw.slice(1);
    const last = out[out.length - 1];
    if (last && last[0] === label) last[1].push(i);
    else out.push([label, [i]] as const);
  }
  return out;
}

interface Item {
  key: string;
  kind: Filter;
  group: 'attention' | 'upcoming' | 'done';
  at: string;
  icon: IconName;
  title: string;
  sub: string;
  href?: string;
  amount: { minor: string; currency: string; sign?: '+' | '−' };
  status: { tone: string; label: string };
}

const TRANSFER: Record<Transfer['status'], { tone: string; label: string; open: boolean }> = {
  processing: { tone: 'warn', label: 'En proceso', open: true },
  indeterminate: { tone: 'warn', label: 'Sin confirmar', open: true },
  completed: { tone: 'ok', label: 'Completado', open: false },
  failed: { tone: 'bad', label: 'Falló', open: false },
};
const FUNDING: Record<Funding['status'], { tone: string; label: string; open: boolean }> = {
  pending: { tone: 'warn', label: 'Esperando al banco', open: true },
  confirmed: { tone: 'ok', label: 'Acreditado', open: false },
  failed: { tone: 'bad', label: 'No acreditado', open: false },
};

/**
 * Actividad: lo pendiente primero (incluye autorizaciones, pagos inciertos y
 * devoluciones en proceso, que NUNCA se muestran como completados), luego
 * próximas cuotas y lo completado, por fecha. Cada fila lleva a su detalle.
 */
export default async function ActividadPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string }>;
}) {
  const sp = await searchParams;
  const filter = (FILTERS.find(([f]) => f === sp.filtro)?.[0] ?? 'todo') as Filter;
  const [orders, purchases, overview, fundings, transfers] = await Promise.all([
    readPersonal<{ data: ShopOrder[] }>('/shop/orders'),
    readPersonal<{ data: Authorization[] }>('/purchases'),
    readPersonal<{
      balances: Balance[];
      upcoming: (Installment & { currency: string; merchant_name: string })[];
    }>('/overview'),
    readPersonal<{ data: Funding[] }>('/wallet/fundings'),
    readPersonal<{ data: Transfer[] }>('/wallet/transfers'),
  ]);
  if (overview.kind !== 'ok') return <ErrorPanel />;
  const items: Item[] = [];

  for (const o of orders.kind === 'ok' ? orders.data.data : []) {
    const out = OUTCOME[o.outcome];
    const open =
      o.outcome === 'unpaid' ||
      o.outcome === 'declined' ||
      o.outcome === 'pending' ||
      Boolean(o.return_requested_at && o.outcome !== 'refunded') ||
      (o.outcome === 'approved' && o.fulfillment_status !== 'delivered');
    items.push({
      key: `o-${o.order_id}`,
      kind: 'pedidos',
      group: open ? 'attention' : 'done',
      at: o.created_at,
      icon: 'bag',
      title: `${o.shop_name} · pedido #${o.number}`,
      sub:
        o.return_requested_at && o.outcome !== 'refunded'
          ? 'Devolución solicitada'
          : o.outcome === 'approved'
            ? o.fulfillment_status === 'delivered'
              ? 'Entregado'
              : 'Pagado · en preparación o por entregar'
            : out.label,
      href: `/personal/pedidos/${o.order_id}`,
      amount: { minor: o.total, currency: o.currency },
      status: { tone: out.tone, label: out.label },
    });
  }
  // Una operación, una fila: la compra con tarjeta de un pedido de Tiendas ya
  // está en la fila del pedido (mismo `journey_ref`, decidido por la API).
  const orderIds = new Set((orders.kind === 'ok' ? orders.data.data : []).map((o) => o.order_id));
  for (const a of purchases.kind === 'ok' ? purchases.data.data : []) {
    if (a.journey_ref && orderIds.has(a.journey_ref)) continue;
    const st = PURCHASE_STATUS[a.status] ?? { tone: 'neutral', label: a.status };
    const refunded = BigInt(a.refunded_wallet) + BigInt(a.refunded_credit) > 0n;
    items.push({
      key: `p-${a.id}`,
      kind: 'tarjeta',
      // Autorizada = retenida, NO cobrada: va en «Requiere atención».
      group: a.status === 'approved' || a.status === 'partially_captured' ? 'attention' : 'done',
      at: a.created_at,
      icon: 'card',
      title: a.merchant_name,
      sub:
        a.status === 'declined'
          ? `Rechazada · ${DECLINE_TEXT[a.decline_code ?? ''] ?? 'sin cobro'}`
          : a.installments_count
            ? `En ${a.installments_count} cuotas${refunded ? ' · con devolución' : ''}`
            : `Con saldo propio${refunded ? ' · con devolución' : ''}`,
      href: `/personal/actividad/compra/${a.id}`,
      amount: { minor: a.amount, currency: a.currency, sign: '−' },
      status: st,
    });
  }
  for (const i of overview.data.upcoming) {
    items.push({
      key: `i-${i.id}`,
      kind: 'cuotas',
      group: i.status === 'overdue' ? 'attention' : 'upcoming',
      at: i.due_date,
      icon: 'calendar',
      title: `Cuota ${i.seq} · ${i.merchant_name}`,
      sub: `Vence ${shortDate(i.due_date)}`,
      href: '/personal/cuotas',
      amount: { minor: i.outstanding, currency: i.currency },
      status:
        i.status === 'overdue'
          ? { tone: 'bad', label: 'Vencida' }
          : { tone: 'info', label: 'Pendiente' },
    });
  }
  for (const f of fundings.kind === 'ok' ? fundings.data.data : []) {
    const st = FUNDING[f.status];
    items.push({
      key: `f-${f.id}`,
      kind: 'dinero',
      group: st.open ? 'attention' : 'done',
      at: f.created_at,
      icon: 'in',
      title: 'Ingreso de fondos',
      sub: f.reference ? `Ref. ${f.reference}` : 'Ingreso',
      href: '/personal/movimientos',
      amount: { minor: f.amount, currency: f.currency, sign: '+' },
      status: st,
    });
  }
  for (const t of transfers.kind === 'ok' ? transfers.data.data : []) {
    const st = TRANSFER[t.status];
    items.push({
      key: `t-${t.id}`,
      kind: 'dinero',
      group: st.open ? 'attention' : 'done',
      at: t.created_at,
      icon: t.direction === 'in' ? 'in' : t.kind === 'withdrawal' ? 'out' : 'send',
      title:
        t.kind === 'withdrawal' ? 'Retiro' : t.direction === 'in' ? 'Dinero recibido' : 'Envío',
      sub: t.destination_masked ?? t.note ?? '',
      href: '/personal/movimientos',
      amount: { minor: t.amount, currency: t.currency, sign: t.direction === 'in' ? '+' : '−' },
      status: st,
    });
  }

  const shown = items.filter((i) => filter === 'todo' || i.kind === filter);
  const groups: Array<[Item['group'], string]> = [
    ['attention', 'Requiere tu atención'],
    ['upcoming', 'Próximas cuotas'],
    ['done', 'Completadas'],
  ];

  return (
    <main aria-labelledby="pm-activity-title">
      <ScreenHead title="Actividad" id="pm-activity-title" />
      <nav className="pm-chips" aria-label="Filtrar actividad">
        {FILTERS.map(([f, label]) => (
          <a
            key={f}
            className="pm-chip"
            href={f === 'todo' ? '/personal/actividad' : `/personal/actividad?filtro=${f}`}
            aria-current={filter === f ? 'true' : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      {shown.length === 0 ? (
        <div className="pm-card" style={{ marginTop: 16 }}>
          <p style={{ margin: 0 }}>No hay actividad con este filtro.</p>
        </div>
      ) : (
        groups.map(([g, label]) => {
          const list = shown
            .filter((i) => i.group === g)
            .sort((a, b) =>
              g === 'upcoming' ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at)
            );
          if (!list.length) return null;
          return (
            <section key={g} aria-labelledby={`pm-g-${g}`}>
              <h2 id={`pm-g-${g}`} className="pm-group-label">
                {label}
              </h2>
              {(g === 'done' ? byMonth(list) : [[null, list] as const]).map(([month, rows]) => (
                <div key={month ?? g}>
                  {month ? <h3 className="pm-month-label">{month}</h3> : null}
                  <ul className="pm-list">
                    {rows.map((i) => {
                      const body = (
                        <>
                          <span className="pm-row-ico" aria-hidden="true">
                            <Icon name={i.icon} />
                          </span>
                          <span className="pm-row-body">
                            <p className="pm-row-title">{i.title}</p>
                            <p className="pm-row-sub">
                              {shortDate(i.at)} · {i.sub}
                            </p>
                          </span>
                          <span className="pm-row-end">
                            <span className="pm-amount">
                              {i.amount.sign ?? ''}
                              <Money minor={i.amount.minor} currency={i.amount.currency} />
                            </span>
                            <Status tone={i.status.tone} label={i.status.label} />
                          </span>
                        </>
                      );
                      return (
                        <li key={i.key}>
                          {i.href ? (
                            <a className="pm-row" href={i.href}>
                              {body}
                            </a>
                          ) : (
                            <div className="pm-row">{body}</div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </section>
          );
        })
      )}
      <p style={{ marginTop: 24 }}>
        <a href="/personal/movimientos">Extracto contable del saldo (wallet)</a>
        {' · '}
        <a href="/personal/cuotas">Calendario de cuotas</a>
      </p>
    </main>
  );
}
