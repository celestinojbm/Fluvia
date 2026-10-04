import { formatAmount } from '../../lib/money-format';

export const money = (minor: string | number | bigint, currency: string) =>
  formatAmount(minor, currency, 'es', { code: true });

const DT = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});
export const when = (iso: string) => `${DT.format(new Date(iso))} UTC`;

const TONES: Record<string, string> = {
  active: 'ok',
  approved: 'ok',
  captured: 'ok',
  completed: 'ok',
  confirmed: 'ok',
  applied: 'ok',
  paid: 'ok',
  resolved: 'ok',
  executed: 'ok',
  delivered: 'ok',
  manual_review: 'warn',
  partially_captured: 'info',
  processing: 'info',
  pending: 'warn',
  proposed: 'warn',
  acknowledged: 'info',
  open: 'warn',
  inactive: 'warn',
  frozen: 'warn',
  suspended: 'bad',
  blocked: 'bad',
  declined: 'bad',
  rejected: 'bad',
  failed: 'bad',
  overdue: 'bad',
  unmatched: 'bad',
  indeterminate: 'warn',
  draft: 'info',
  succeeded: 'ok',
  payment_in_progress: 'warn',
  awaiting_payment: 'info',
  partially_refunded: 'info',
  refunded: 'neutral',
  created: 'info',
  ready: 'info',
  preparing: 'info',
};
const LABELS: Record<string, string> = {
  active: 'Activa',
  approved: 'Aprobada',
  captured: 'Capturada',
  completed: 'Completada',
  confirmed: 'Confirmado',
  applied: 'Aplicado',
  paid: 'Pagado',
  resolved: 'Resuelto',
  executed: 'Ejecutada',
  delivered: 'Entregada',
  manual_review: 'En revisión',
  partially_captured: 'Captura parcial',
  processing: 'En curso',
  pending: 'Pendiente',
  proposed: 'Propuesta',
  acknowledged: 'En trabajo',
  open: 'Abierto',
  inactive: 'Por activar',
  frozen: 'Congelada',
  suspended: 'Suspendido',
  blocked: 'Bloqueada',
  declined: 'Rechazada',
  rejected: 'Rechazada',
  failed: 'Fallida',
  overdue: 'Vencida',
  unmatched: 'Sin objeto',
  indeterminate: 'Incierto',
  draft: 'Borrador',
  retired: 'Retirada',
  reversed: 'Liberada',
  expired: 'Vencida',
  replaced: 'Reemplazada',
  closed: 'Cerrada',
  requested: 'Solicitada',
  ignored_out_of_order: 'Tardío (sin efecto)',
  received: 'Recibido',
  scheduled: 'Pendiente',
  partially_paid: 'Pago parcial',
  cancelled: 'Anulada',
  produced: 'Fabricada',
  shipped: 'En camino',
  returned: 'Devuelta',
  succeeded: 'Confirmado',
  payment_in_progress: 'Sin confirmar',
  awaiting_payment: 'Sin cobro',
  partially_refunded: 'Devolución parcial',
  refunded: 'Devuelto',
  created: 'Iniciada',
  canceled: 'No procesada',
  ready: 'Listo',
  preparing: 'En preparación',
};

export function St({ s }: { s: string }) {
  return <span className={`ox-status ox-${TONES[s] ?? 'neutral'}`}>{LABELS[s] ?? s}</span>;
}

export const CASE_TYPE: Record<string, string> = {
  uncertain_withdrawal: 'Retiro incierto',
  uncertain_authorization: 'Autorización incierta',
  uncertain_refund: 'Devolución incierta',
  unmatched_provider_event: 'Evento sin objeto',
  reconciliation_mismatch: 'Descuadre de conciliación',
  overdue_debt: 'Deuda vencida',
  customer_incident: 'Incidencia de cliente',
};

export function Sandbox() {
  return (
    <p className="ox-sandbox">
      Sandbox: clientes y datos sintéticos, proveedores (banco, emisor, red) simulados, política de
      referencia pendiente de validación comercial. Ninguna acción mueve dinero real.
    </p>
  );
}

export function Failed() {
  return (
    <div className="ox-empty" role="alert">
      <p>
        <strong>No se pudo cargar.</strong> El servicio no respondió o tu sesión caducó.
      </p>
      <a className="ox-btn" href="">
        Recargar
      </a>
    </div>
  );
}
