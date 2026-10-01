import { CustomerForm } from '../../../../lib/customer-form';
import { orgContext } from '../../../../lib/org-context';
import { PageHead, SELL_ROLES } from '../../../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function NewCustomerPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { role } = await orgContext(orgId);
  return (
    <main className="fx-page" aria-labelledby="nc-title">
      <PageHead
        id="nc-title"
        title="Nuevo cliente"
        crumb={{ href: `/o/${orgId}/customers`, label: 'Clientes' }}
      />
      <section className="fx-panel" style={{ maxWidth: '40rem' }}>
        <div className="fx-panel-body">
          <CustomerForm orgId={orgId} canEdit={role !== undefined && SELL_ROLES.has(role)} />
        </div>
      </section>
    </main>
  );
}
