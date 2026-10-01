import type { Locale } from './messages';

/**
 * Textos del resumen de compra y de «Pagar en cuotas» (SIMULACIÓN). Cada
 * pantalla repite que no hay financiación real: el comprador no debe creer
 * que contrató un crédito.
 */
export interface InstallmentsMessages {
  summaryTitle: string;
  receiptTitle: string;
  receiptNote: string;
  print: string;
  orderNumber: (n: number) => string;
  product: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  total: string;
  optionTitle: string;
  optionSim: string;
  optionOpen: string;
  optionClose: string;
  countLegend: string;
  countOption: (n: number, days: number) => string;
  quoteLoading: string;
  quoteError: string;
  initial: string;
  installment: (n: number) => string;
  due: (date: string) => string;
  conditions: (version: string) => string;
  scenarioLegend: string;
  scenarioApprove: string;
  scenarioDecline: string;
  scenarioPending: string;
  accept: string;
  acceptRequired: string;
  confirm: string;
  confirming: string;
  uncertain: string;
  notAllowed: string;
  planTitle: string;
  planApproved: string;
  planDeclined: string;
  planPending: string;
  planNotPaid: string;
  planLink: string;
  cardBlocked: string;
  statusScheduled: string;
  statusPaid: string;
  statusOverdue: string;
  backToCheckout: string;
  noPlan: string;
  eventsTitle: string;
  event: Record<string, string>;
}

export const INSTALLMENTS_MESSAGES: Record<Locale, InstallmentsMessages> = {
  es: {
    summaryTitle: 'Resumen de tu compra',
    receiptTitle: 'Comprobante de compra',
    receiptNote: 'Comprobante operativo del sandbox. No es una factura.',
    print: 'Imprimir comprobante',
    orderNumber: (n) => `Compra #${n}`,
    product: 'Producto',
    qty: 'Cant.',
    unitPrice: 'Precio',
    lineTotal: 'Importe',
    total: 'Total',
    optionTitle: 'Pagar en cuotas',
    optionSim:
      'Simulación: no hay financiación ni crédito real, ni intereses, ni cobros futuros. Sirve para probar la experiencia.',
    optionOpen: 'Ver opción de cuotas',
    optionClose: 'Ocultar cuotas',
    countLegend: 'Número de cuotas (parámetros de demostración)',
    countOption: (n, d) => `${n} cuotas, cada ${d} días`,
    quoteLoading: 'Calculando calendario…',
    quoteError: 'No pudimos calcular el calendario. Reintenta.',
    initial: 'Importe inicial (hoy)',
    installment: (n) => `Cuota ${n}`,
    due: (d) => `vence ${d}`,
    conditions: (v) =>
      `Condiciones de demostración ${v}: 0 % de interés, sin comisiones, sin mora. Las fechas son informativas.`,
    scenarioLegend: 'Escenario de prueba del proveedor simulado',
    scenarioApprove: 'Aprobado',
    scenarioDecline: 'Rechazado',
    scenarioPending: 'Pendiente de revisión',
    accept:
      'Entiendo que es una simulación y acepto el calendario y las condiciones de demostración.',
    acceptRequired: 'Debes aceptar explícitamente para continuar.',
    confirm: 'Confirmar plan en cuotas',
    confirming: 'Confirmando…',
    uncertain:
      'No pudimos confirmar si el plan se registró. No lo repitas a ciegas: consulta el estado.',
    notAllowed:
      'Esta compra ya no admite un plan de cuotas (tiene un pago en curso o ya cuenta con un plan).',
    planTitle: 'Tu plan de cuotas (simulación)',
    planApproved: 'Plan aprobado por el proveedor simulado.',
    planDeclined: 'El proveedor simulado rechazó el plan. Puedes pagar con otro método.',
    planPending: 'Plan pendiente de revisión por el proveedor simulado.',
    planNotPaid:
      'Importante: la compra no queda pagada por este plan. Es una simulación que no mueve dinero.',
    planLink: 'Consultar mi plan',
    cardBlocked:
      'Mientras el plan esté pendiente o aprobado, esta compra no se puede pagar con otro método.',
    statusScheduled: 'Programada',
    statusPaid: 'Pagada (simulada)',
    statusOverdue: 'Vencida (simulada)',
    backToCheckout: 'Volver al pago',
    noPlan: 'Esta compra no tiene un plan de cuotas.',
    eventsTitle: 'Historial',
    event: {
      plan_requested: 'Confirmaste el plan',
      plan_approved: 'Proveedor simulado: aprobado',
      plan_declined: 'Proveedor simulado: rechazado',
      installment_paid_simulated: 'Cuota pagada (simulada)',
      installment_overdue_simulated: 'Cuota vencida (simulada)',
    },
  },
  en: {
    summaryTitle: 'Your purchase',
    receiptTitle: 'Purchase receipt',
    receiptNote: 'Sandbox operational receipt. Not an invoice.',
    print: 'Print receipt',
    orderNumber: (n) => `Purchase #${n}`,
    product: 'Item',
    qty: 'Qty',
    unitPrice: 'Price',
    lineTotal: 'Amount',
    total: 'Total',
    optionTitle: 'Pay in installments',
    optionSim:
      'Simulation: no real financing or credit, no interest, no future charges. It is for testing the experience.',
    optionOpen: 'See installment option',
    optionClose: 'Hide installments',
    countLegend: 'Number of installments (demo parameters)',
    countOption: (n, d) => `${n} installments, every ${d} days`,
    quoteLoading: 'Calculating schedule…',
    quoteError: 'We could not calculate the schedule. Retry.',
    initial: 'Initial amount (today)',
    installment: (n) => `Installment ${n}`,
    due: (d) => `due ${d}`,
    conditions: (v) =>
      `Demo terms ${v}: 0% interest, no fees, no late charges. Dates are informational.`,
    scenarioLegend: 'Simulated provider test scenario',
    scenarioApprove: 'Approved',
    scenarioDecline: 'Declined',
    scenarioPending: 'Pending review',
    accept: 'I understand this is a simulation and accept the schedule and demo terms.',
    acceptRequired: 'You must explicitly accept to continue.',
    confirm: 'Confirm installment plan',
    confirming: 'Confirming…',
    uncertain:
      'We could not confirm whether the plan was recorded. Do not repeat it blindly: check.',
    notAllowed:
      'This purchase no longer accepts an installment plan (a payment is in progress or a plan exists).',
    planTitle: 'Your installment plan (simulation)',
    planApproved: 'Plan approved by the simulated provider.',
    planDeclined: 'The simulated provider declined the plan. You can pay with another method.',
    planPending: 'Plan pending review by the simulated provider.',
    planNotPaid:
      'Important: this plan does not pay the purchase. It is a simulation; no money moves.',
    planLink: 'View my plan',
    cardBlocked: 'While the plan is pending or approved, this purchase cannot be paid another way.',
    statusScheduled: 'Scheduled',
    statusPaid: 'Paid (simulated)',
    statusOverdue: 'Overdue (simulated)',
    backToCheckout: 'Back to payment',
    noPlan: 'This purchase has no installment plan.',
    eventsTitle: 'History',
    event: {
      plan_requested: 'You confirmed the plan',
      plan_approved: 'Simulated provider: approved',
      plan_declined: 'Simulated provider: declined',
      installment_paid_simulated: 'Installment paid (simulated)',
      installment_overdue_simulated: 'Installment overdue (simulated)',
    },
  },
};
