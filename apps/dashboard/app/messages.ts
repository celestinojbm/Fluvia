/**
 * i18n mínimo (es/en) sin dependencias, como en `apps/checkout`. El locale llega
 * por `?lang=` (default es — Colombia).
 */

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export function normalizeLocale(raw: string | null | undefined): Locale {
  return raw === 'en' ? 'en' : 'es';
}

interface Messages {
  appTitle: string;
  loginTitle: string;
  emailLabel: string;
  passwordLabel: string;
  signIn: string;
  signingIn: string;
  loginError: string;
  mfaUnsupported: string;
  orgsTitle: string;
  noOrgs: string;
  open: string;
  dashboardTitle: string;
  signOut: string;
  empty: string;
  sectionIntents: string;
  sectionRefunds: string;
  sectionSessions: string;
  sectionLinks: string;
  sectionWebhooks: string;
  colId: string;
  colStatus: string;
  colAmount: string;
  colCreated: string;
  colTopic: string;
  colAttempts: string;
  colAction: string;
  resend: string;
  resending: string;
  resendError: string;
  resent: string;
  reconciliation: string;
  reconTitle: string;
  reconEmpty: string;
  colProvider: string;
  colPeriod: string;
  colReport: string;
  reconMatched: string;
  reconAmountMismatch: string;
  reconMissingLedger: string;
  reconMissingProvider: string;
  colRef: string;
  colLedger: string;
  colProviderAmount: string;
  backToDashboard: string;
  sandboxNotice: string;
  // casos operativos + ajustes (F4-03c-ii)
  cases: string;
  casesTitle: string;
  casesEmpty: string;
  colCase: string;
  colType: string;
  colSeverity: string;
  sevLow: string;
  sevMedium: string;
  sevHigh: string;
  sevCritical: string;
  caseDetail: string;
  fldDiscrepancy: string;
  fldProviderRef: string;
  fldReport: string;
  fldAssignee: string;
  fldResolution: string;
  filterAll: string;
  filterOpen: string;
  filterAcknowledged: string;
  filterResolved: string;
  adjustmentsTitle: string;
  noAdjustments: string;
  colDirection: string;
  colReason: string;
  colProposedBy: string;
  dirDebit: string;
  dirCredit: string;
  acknowledge: string;
  acknowledging: string;
  resolveAction: string;
  resolving: string;
  resolutionLabel: string;
  proposeTitle: string;
  amountLabel: string;
  amountHint: string;
  currencyLabel: string;
  directionLabel: string;
  reasonLabel: string;
  propose: string;
  proposing: string;
  approve: string;
  approving: string;
  reject: string;
  rejecting: string;
  rejectReasonLabel: string;
  fourEyesHint: string;
  fourEyesError: string;
  actionError: string;
  documentalNote: string;
  liveAdjustmentNote: string;
  requiredField: string;
}

export const MESSAGES: Record<Locale, Messages> = {
  es: {
    appTitle: 'Fluvia · Operación',
    loginTitle: 'Iniciar sesión',
    emailLabel: 'Correo electrónico',
    passwordLabel: 'Contraseña',
    signIn: 'Entrar',
    signingIn: 'Entrando…',
    loginError: 'Correo o contraseña inválidos.',
    mfaUnsupported: 'Esta cuenta requiere MFA; el dashboard aún no lo soporta.',
    orgsTitle: 'Tus organizaciones',
    noOrgs: 'No perteneces a ninguna organización.',
    open: 'Abrir',
    dashboardTitle: 'Panel de operación',
    signOut: 'Cerrar sesión',
    empty: 'Sin registros.',
    sectionIntents: 'Payment intents',
    sectionRefunds: 'Reembolsos',
    sectionSessions: 'Sesiones de checkout',
    sectionLinks: 'Payment links',
    sectionWebhooks: 'Cola de webhooks',
    colId: 'ID',
    colStatus: 'Estado',
    colAmount: 'Monto',
    colCreated: 'Creado',
    colTopic: 'Topic',
    colAttempts: 'Intentos',
    colAction: 'Acción',
    resend: 'Reenviar',
    resending: 'Reenviando…',
    resendError: 'No se pudo reenviar.',
    resent: 'Reenviado ✓',
    reconciliation: 'Conciliación',
    reconTitle: 'Reportes de liquidación',
    reconEmpty: 'Sin reportes de liquidación.',
    colProvider: 'Proveedor',
    colPeriod: 'Periodo',
    colReport: 'Reporte',
    reconMatched: 'Conciliados',
    reconAmountMismatch: 'Monto no coincide',
    reconMissingLedger: 'Falta en el ledger',
    reconMissingProvider: 'Falta en el proveedor',
    colRef: 'Referencia',
    colLedger: 'Monto ledger',
    colProviderAmount: 'Monto proveedor',
    backToDashboard: '← Volver al panel',
    sandboxNotice: 'Entorno de pruebas — no se mueve dinero real.',
    cases: 'Casos',
    casesTitle: 'Casos operativos',
    casesEmpty: 'Sin casos operativos.',
    colCase: 'Caso',
    colType: 'Tipo',
    colSeverity: 'Severidad',
    sevLow: 'Baja',
    sevMedium: 'Media',
    sevHigh: 'Alta',
    sevCritical: 'Crítica',
    caseDetail: 'Detalle del caso',
    fldDiscrepancy: 'Discrepancia',
    fldProviderRef: 'Referencia del proveedor',
    fldReport: 'Reporte',
    fldAssignee: 'Asignado a',
    fldResolution: 'Resolución',
    filterAll: 'Todos',
    filterOpen: 'Abiertos',
    filterAcknowledged: 'Reconocidos',
    filterResolved: 'Resueltos',
    adjustmentsTitle: 'Ajustes monetarios',
    noAdjustments: 'Sin ajustes.',
    colDirection: 'Dirección',
    colReason: 'Motivo',
    colProposedBy: 'Propuesto por',
    dirDebit: 'Cargar a diferencias',
    dirCredit: 'Abonar a diferencias',
    acknowledge: 'Reconocer',
    acknowledging: 'Reconociendo…',
    resolveAction: 'Resolver (documental)',
    resolving: 'Resolviendo…',
    resolutionLabel: 'Nota de resolución',
    proposeTitle: 'Proponer ajuste',
    amountLabel: 'Monto',
    amountHint: 'En unidades menores (p. ej. centavos; COP no tiene decimales).',
    currencyLabel: 'Moneda',
    directionLabel: 'Dirección',
    reasonLabel: 'Motivo',
    propose: 'Proponer',
    proposing: 'Proponiendo…',
    approve: 'Aprobar',
    approving: 'Aprobando…',
    reject: 'Rechazar',
    rejecting: 'Rechazando…',
    rejectReasonLabel: 'Motivo del rechazo',
    fourEyesHint: 'Requiere aprobación de un segundo usuario distinto (four-eyes).',
    fourEyesError:
      'No puedes aprobar tu propio ajuste: requiere un segundo usuario distinto (four-eyes).',
    actionError: 'No se pudo completar la acción.',
    documentalNote: 'Resolver es documental — no mueve dinero. El ajuste monetario usa four-eyes.',
    liveAdjustmentNote: 'Ya existe un ajuste vivo para este caso.',
    requiredField: 'Requerido.',
  },
  en: {
    appTitle: 'Fluvia · Operations',
    loginTitle: 'Sign in',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    loginError: 'Invalid email or password.',
    mfaUnsupported: 'This account requires MFA; the dashboard does not support it yet.',
    orgsTitle: 'Your organizations',
    noOrgs: 'You do not belong to any organization.',
    open: 'Open',
    dashboardTitle: 'Operations dashboard',
    signOut: 'Sign out',
    empty: 'No records.',
    sectionIntents: 'Payment intents',
    sectionRefunds: 'Refunds',
    sectionSessions: 'Checkout sessions',
    sectionLinks: 'Payment links',
    sectionWebhooks: 'Webhook queue',
    colId: 'ID',
    colStatus: 'Status',
    colAmount: 'Amount',
    colCreated: 'Created',
    colTopic: 'Topic',
    colAttempts: 'Attempts',
    colAction: 'Action',
    resend: 'Resend',
    resending: 'Resending…',
    resendError: 'Could not resend.',
    resent: 'Resent ✓',
    reconciliation: 'Reconciliation',
    reconTitle: 'Settlement reports',
    reconEmpty: 'No settlement reports.',
    colProvider: 'Provider',
    colPeriod: 'Period',
    colReport: 'Report',
    reconMatched: 'Matched',
    reconAmountMismatch: 'Amount mismatch',
    reconMissingLedger: 'Missing in ledger',
    reconMissingProvider: 'Missing at provider',
    colRef: 'Reference',
    colLedger: 'Ledger amount',
    colProviderAmount: 'Provider amount',
    backToDashboard: '← Back to dashboard',
    sandboxNotice: 'Test environment — no real money moves.',
    cases: 'Cases',
    casesTitle: 'Operational cases',
    casesEmpty: 'No operational cases.',
    colCase: 'Case',
    colType: 'Type',
    colSeverity: 'Severity',
    sevLow: 'Low',
    sevMedium: 'Medium',
    sevHigh: 'High',
    sevCritical: 'Critical',
    caseDetail: 'Case detail',
    fldDiscrepancy: 'Discrepancy',
    fldProviderRef: 'Provider reference',
    fldReport: 'Report',
    fldAssignee: 'Assigned to',
    fldResolution: 'Resolution',
    filterAll: 'All',
    filterOpen: 'Open',
    filterAcknowledged: 'Acknowledged',
    filterResolved: 'Resolved',
    adjustmentsTitle: 'Monetary adjustments',
    noAdjustments: 'No adjustments.',
    colDirection: 'Direction',
    colReason: 'Reason',
    colProposedBy: 'Proposed by',
    dirDebit: 'Debit differences',
    dirCredit: 'Credit differences',
    acknowledge: 'Acknowledge',
    acknowledging: 'Acknowledging…',
    resolveAction: 'Resolve (documentary)',
    resolving: 'Resolving…',
    resolutionLabel: 'Resolution note',
    proposeTitle: 'Propose adjustment',
    amountLabel: 'Amount',
    amountHint: 'In minor units (e.g. cents; COP has no decimals).',
    currencyLabel: 'Currency',
    directionLabel: 'Direction',
    reasonLabel: 'Reason',
    propose: 'Propose',
    proposing: 'Proposing…',
    approve: 'Approve',
    approving: 'Approving…',
    reject: 'Reject',
    rejecting: 'Rejecting…',
    rejectReasonLabel: 'Rejection reason',
    fourEyesHint: 'Requires approval by a second, distinct user (four-eyes).',
    fourEyesError:
      'You cannot approve your own adjustment: it requires a second, distinct user (four-eyes).',
    actionError: 'Could not complete the action.',
    documentalNote:
      'Resolving is documentary — it does not move money. Monetary adjustment uses four-eyes.',
    liveAdjustmentNote: 'This case already has an active adjustment.',
    requiredField: 'Required.',
  },
};

/** Formatea un entero en unidades menores con separadores del locale (sin
 * moneda — el snapshot del caso no la lleva). Null → '—'. */
export function formatMinor(amountMinor: number | null, locale: Locale): string {
  if (amountMinor === null) return '—';
  try {
    return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-CO').format(amountMinor);
  } catch {
    return String(amountMinor);
  }
}

const MINOR_UNIT_CURRENCIES = new Set(['COP', 'JPY', 'CLP']); // exponente 0

/** Formatea unidades menores según la moneda y el locale (espeja apps/checkout). */
export function formatAmount(amountMinor: number, currency: string, locale: Locale): string {
  const zeroExponent = MINOR_UNIT_CURRENCIES.has(currency);
  const value = zeroExponent ? amountMinor : amountMinor / 100;
  try {
    return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-CO', {
      style: 'currency',
      currency,
      minimumFractionDigits: zeroExponent ? 0 : 2,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}
