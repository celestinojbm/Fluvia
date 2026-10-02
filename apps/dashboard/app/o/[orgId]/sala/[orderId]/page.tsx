import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { orgPath, readApi } from '../../../../lib/commerce-api';
import { PageHead, ReadProblem } from '../../../../lib/ui';
import { OrderWorkspace } from '../../../../lib/venue/orden';
import type { Bill, DiningOrder, MenuItem, VenueLayout } from '../../../../lib/venue/api';
import { UUID_RE } from '../../../../lib/pos-contract';
import '../../../../venue.css';

export const dynamic = 'force-dynamic';

export default async function OrderPage({
  params,
}: {
  params: Promise<{ orgId: string; orderId: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId, orderId } = await params;
  if (!UUID_RE.test(orderId)) return <ReadProblem kind="not_found" what="el pedido" />;
  const order = await readApi<DiningOrder>(token, orgPath(orgId, `/dining/orders/${orderId}`));
  if (order.kind !== 'ok') return <ReadProblem kind={order.kind} what="el pedido" />;
  const [menu, layout, bill] = await Promise.all([
    readApi<{ data: MenuItem[] }>(
      token,
      orgPath(orgId, `/venue/branches/${order.data.branch_id}/menu`)
    ),
    readApi<VenueLayout>(token, orgPath(orgId, '/venue')),
    readApi<Bill>(token, orgPath(orgId, `/dining/orders/${orderId}/bill`)),
  ]);
  const tables =
    layout.kind === 'ok'
      ? (layout.data.branches.find((b) => b.id === order.data.branch_id)?.tables ?? [])
      : [];
  return (
    <section className="fx-page" aria-labelledby="order-title">
      <PageHead
        id="order-title"
        title={`Pedido #${order.data.number}`}
        crumb={{ href: `/o/${orgId}/sala`, label: 'Sala' }}
      />
      <OrderWorkspace
        orgId={orgId}
        initialOrder={order.data}
        menu={menu.kind === 'ok' ? menu.data.data : []}
        tables={tables}
        initialBill={bill.kind === 'ok' ? bill.data : null}
      />
    </section>
  );
}
