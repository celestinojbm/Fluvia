import { Icon } from '../../../lib/icons';
import { readPersonal } from '../../lib/server';
import { ErrorPanel } from '../../lib/panels';
import { PayScreen } from '../../lib/pay-actions';
import { ScreenHead } from '../../lib/shop-ui';
import type { Card, Me } from '../../lib/types';

export const dynamic = 'force-dynamic';

/** Pagar como CLIENTE. Cobrar (comercio o independiente) vive en el panel del comercio. */
export default async function PagarPage() {
  const [r, me] = await Promise.all([
    readPersonal<{ data: Card[] }>('/cards'),
    readPersonal<Me>('/me'),
  ]);
  if (r.kind !== 'ok') return <ErrorPanel />;
  const counts =
    me.kind === 'ok'
      ? ((me.data.policy as unknown as { installment_counts?: number[] }).installment_counts ?? [])
      : [];
  const cards = r.data.data
    .filter((c) => c.status === 'active')
    .map((c) => ({ id: c.id, last4: c.last4, currency: c.currency }));
  return (
    <main aria-labelledby="pm-pay-home">
      <ScreenHead title="Pagar" id="pm-pay-home" />
      <PayScreen cards={cards} installments={counts.find((n) => n > 1) ?? null} />
      <section className="pm-section" aria-labelledby="pm-pay-notes">
        <h2 id="pm-pay-notes" className="sr-only">
          Otras formas
        </h2>
        <div className="pm-card">
          <p style={{ margin: '0 0 8px' }}>
            <Icon name="building" /> <strong>¿Vas a cobrar?</strong> Cobrar como comercio o como
            independiente se hace desde el panel del comercio («Cobrar»), no desde esta app.
          </p>
          <p className="pm-muted" style={{ margin: 0 }}>
            Pagar acercando el teléfono (NFC) no está disponible: requiere un proveedor certificado
            y un dispositivo compatible. Por ahora, código o QR.
          </p>
        </div>
      </section>
    </main>
  );
}
