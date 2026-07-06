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
  },
};

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
