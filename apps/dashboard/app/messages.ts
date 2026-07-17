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
  payouts: string;
  payoutsTitle: string;
  payoutsEmpty: string;
  colPayout: string;
  colMerchant: string;
  payoutReason: string;
  payoutFailureCode: string;
  payoutIndeterminateHint: string;
  disputes: string;
  disputesTitle: string;
  disputesEmpty: string;
  colDispute: string;
  disputeReason: string;
  disputeProviderRef: string;
  disputeHeldHint: string;
  disputeRespond: string;
  disputeResponding: string;
  disputeEvidenceHint: string;
  disputeEvidenceSubmitted: string;
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
  // panel admin: comercios (F4-04a)
  merchants: string;
  merchantsTitle: string;
  merchantsEmpty: string;
  merchantsNoMatch: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchAction: string;
  searchClear: string;
  colName: string;
  colCountry: string;
  colCurrency: string;
  merchantActive: string;
  merchantFrozen: string;
  // panel admin: eventos de auditoría (F4-04b)
  events: string;
  eventsTitle: string;
  eventsEmpty: string;
  colWhen: string;
  colActor: string;
  colResource: string;
  colResult: string;
  colRisk: string;
  resultSuccess: string;
  resultFailure: string;
  olderEvents: string;
  // superficie de pagos (F6.5A) — solo lectura por sesión
  payments: string;
  paymentsTitle: string;
  paymentsEmpty: string;
  paymentDetailTitle: string;
  fldCaptureMethod: string;
  fldCaptured: string;
  fldRefunded: string;
  fldFailureCode: string;
  timelineTitle: string;
  tlPaymentCreated: string;
  tlSessionCreated: string;
  tlSessionCompleted: string;
  tlRefundCreated: string;
  relatedRefunds: string;
  relatedSessions: string;
  refundCreateUnavailable: string;
  refundsTitle: string;
  refundsEmpty: string;
  refundDetailTitle: string;
  colPayment: string;
  sessionsTitle: string;
  sessionsEmpty: string;
  sessionDetailTitle: string;
  fldCustomer: string;
  fldExpires: string;
  fldCompletedAt: string;
  fldCheckoutUrl: string;
  linksTitle: string;
  linksEmpty: string;
  linkDetailTitle: string;
  fldDescription: string;
  fldDisabledAt: string;
  copyUrl: string;
  copied: string;
  copyError: string;
  // acciones de escritura por sesión (F6.5A-bis)
  createRefundTitle: string;
  createRefundAction: string;
  refundAmountHint: string;
  confirmRefundText: string;
  amountFullRemaining: string;
  refundCreated: string;
  refundCreateNoRole: string;
  createLinkTitle: string;
  createLinkAction: string;
  confirmLinkText: string;
  linkCreated: string;
  linkCreateNoRole: string;
  confirmAction: string;
  cancelAction: string;
  creating: string;
  refreshList: string;
  // superficie de desarrollador (F6.5B): webhook events + API keys
  webhooks: string;
  webhookEventsTitle: string;
  webhookEventsEmpty: string;
  webhookEventDetailTitle: string;
  colEvent: string;
  colEndpoint: string;
  fldTopic: string;
  fldNextAttempt: string;
  fldDeliveredAt: string;
  fldLastError: string;
  fldResentFrom: string;
  payloadTitle: string;
  attemptsTitle: string;
  attemptsEmpty: string;
  colAttempt: string;
  colStatusCode: string;
  colLatency: string;
  colResolvedIp: string;
  colError: string;
  apiKeys: string;
  apiKeysTitle: string;
  apiKeysEmpty: string;
  colLabel: string;
  colPrefix: string;
  colScopes: string;
  colEnvironment: string;
  colLastUsed: string;
  colRevoked: string;
  keyActive: string;
  keyRevoked: string;
  apiKeysReadOnlyNote: string;
  secretNeverShownNote: string;
  // webhook endpoints (F6.5B1)
  webhookEndpoints: string;
  webhookEndpointsTitle: string;
  webhookEndpointsEmpty: string;
  webhookEndpointDetailTitle: string;
  colUrl: string;
  colEvents: string;
  fldDescription2: string;
  createEndpointTitle: string;
  createEndpointAction: string;
  endpointUrlLabel: string;
  endpointUrlHint: string;
  endpointEventsLabel: string;
  endpointEventsHint: string;
  rotateAction: string;
  rotateConfirm: string;
  disableAction: string;
  disableConfirm: string;
  disabledOk: string;
  endpointCreated: string;
  viewRelatedEvents: string;
  endpointManageNoRole: string;
  allEvents: string;
  // secret reveal once (F6.5B1, reusable)
  secretOnceTitle: string;
  secretOnceWarning: string;
  secretOnceDismiss: string;
  // API key create/revoke + step-up (F6.5B2)
  createApiKeyTitle: string;
  createApiKeyAction: string;
  apiKeyLabelField: string;
  apiKeyScopesField: string;
  apiKeyScopesHint: string;
  apiKeyEnvNote: string;
  apiKeyCreated: string;
  revokeAction: string;
  revokeConfirm: string;
  keyRevokedOk: string;
  keysManageNoRole: string;
  selectAtLeastOneScope: string;
  stepUpTitle: string;
  stepUpPrompt: string;
  stepUpPasswordLabel: string;
  stepUpSubmit: string;
  stepUpVerifying: string;
  stepUpWrongPassword: string;
  stepUpLocked: string;
  stepUpMfaRequired: string;
  stepUpCancel: string;
  // signup sandbox (F6.5C1)
  signupTitle: string;
  signupLink: string;
  backToLogin: string;
  confirmPasswordLabel: string;
  createAccount: string;
  creatingAccount: string;
  signupSandboxVerification: string;
  signupNoRealEmail: string;
  signupPasswordMismatch: string;
  signupEmailTaken: string;
  signupInvalidInput: string;
  signupGenericError: string;
  signupSuccess: string;
  // usuario sin organización (F6.5C1)
  noOrgCtaTitle: string;
  noOrgCtaBody: string;
  noOrgCtaAction: string;
  // wizard de onboarding (F6.5C2)
  onboardingTitle: string;
  onboardingIntro: string;
  onboardingStepOrg: string;
  onboardingStepMerchant: string;
  orgNameLabel: string;
  orgSlugLabel: string;
  orgSlugHint: string;
  continueAction: string;
  creatingOrgAction: string;
  onboardingOrgRecovered: string;
  onboardingSlugTaken: string;
  onboardingAlreadyCompleted: string;
  merchantNameLabel: string;
  merchantCountryLabel: string;
  merchantCountryHint: string;
  merchantCurrencyLabel: string;
  finishAction: string;
  creatingMerchantAction: string;
  retryAction: string;
  merchantOnboardingAlreadyCompleted: string;
  onboardingMerchantRetryHint: string;
  onboardingInvalidInput: string;
  onboardingGenericError: string;
  onboardingDone: string;
  goToDashboard: string;
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
    payouts: 'Payouts',
    payoutsTitle: 'Payouts (salidas de dinero)',
    payoutsEmpty: 'Sin payouts.',
    colPayout: 'Payout',
    colMerchant: 'Comercio',
    payoutReason: 'Motivo',
    payoutFailureCode: 'Código de fallo',
    payoutIndeterminateHint:
      'Desenlace del banco desconocido: fondos retenidos en tránsito, a la espera de resolución verificada.',
    disputes: 'Disputas',
    disputesTitle: 'Disputas (contracargos)',
    disputesEmpty: 'Sin disputas.',
    colDispute: 'Disputa',
    disputeReason: 'Motivo',
    disputeProviderRef: 'Ref. del banco',
    disputeHeldHint:
      'Fondos apartados de la reserva del comercio mientras el banco resuelve la disputa.',
    disputeRespond: 'Responder con evidencia',
    disputeResponding: 'Respondiendo…',
    disputeEvidenceHint:
      'Marca que el comercio respondió con evidencia (open → en revisión). No decide el desenlace: won/lost llega solo por el banco antes de que venza el plazo.',
    disputeEvidenceSubmitted: 'Evidencia enviada — en revisión por el banco.',
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
    merchants: 'Comercios',
    merchantsTitle: 'Comercios',
    merchantsEmpty: 'No hay comercios en esta organización.',
    merchantsNoMatch: 'Ningún comercio coincide con la búsqueda.',
    searchLabel: 'Buscar comercios',
    searchPlaceholder: 'Nombre, ID, país o moneda',
    searchAction: 'Buscar',
    searchClear: 'Limpiar',
    colName: 'Nombre',
    colCountry: 'País',
    colCurrency: 'Moneda',
    merchantActive: 'Activo',
    merchantFrozen: 'Congelado',
    events: 'Eventos',
    eventsTitle: 'Eventos de auditoría',
    eventsEmpty: 'Sin eventos de auditoría.',
    colWhen: 'Fecha y hora',
    colActor: 'Actor',
    colResource: 'Recurso',
    colResult: 'Resultado',
    colRisk: 'Riesgo',
    resultSuccess: 'Éxito',
    resultFailure: 'Fallo',
    olderEvents: 'Ver más antiguos →',
    payments: 'Pagos',
    paymentsTitle: 'Pagos (payment intents)',
    paymentsEmpty: 'Sin pagos.',
    paymentDetailTitle: 'Detalle del pago',
    fldCaptureMethod: 'Método de captura',
    fldCaptured: 'Capturado',
    fldRefunded: 'Reembolsado',
    fldFailureCode: 'Código de fallo',
    timelineTitle: 'Línea de tiempo',
    tlPaymentCreated: 'Pago creado',
    tlSessionCreated: 'Sesión de checkout creada',
    tlSessionCompleted: 'Sesión de checkout completada',
    tlRefundCreated: 'Reembolso creado',
    relatedRefunds: 'Reembolsos de este pago',
    relatedSessions: 'Sesiones de checkout de este pago',
    refundCreateUnavailable:
      'Los reembolsos se crean desde el detalle del pago (rol owner/admin/finance).',
    refundsTitle: 'Reembolsos',
    refundsEmpty: 'Sin reembolsos.',
    refundDetailTitle: 'Detalle del reembolso',
    colPayment: 'Pago',
    sessionsTitle: 'Sesiones de checkout',
    sessionsEmpty: 'Sin sesiones de checkout.',
    sessionDetailTitle: 'Detalle de la sesión',
    fldCustomer: 'Cliente',
    fldExpires: 'Expira',
    fldCompletedAt: 'Completada',
    fldCheckoutUrl: 'URL de pago (sandbox)',
    linksTitle: 'Payment links',
    linksEmpty: 'Sin payment links.',
    linkDetailTitle: 'Detalle del payment link',
    fldDescription: 'Descripción',
    fldDisabledAt: 'Deshabilitado',
    copyUrl: 'Copiar URL',
    copied: 'Copiada ✓',
    copyError: 'No se pudo copiar.',
    createRefundTitle: 'Crear reembolso',
    createRefundAction: 'Crear reembolso',
    refundAmountHint:
      'En unidades menores (COP no tiene decimales). Déjalo vacío para reembolsar todo lo restante.',
    confirmRefundText: '¿Confirmar el reembolso por',
    amountFullRemaining: 'todo lo restante?',
    refundCreated: 'Reembolso creado ✓',
    refundCreateNoRole: 'Tu rol no permite crear reembolsos (requiere owner/admin/finance).',
    createLinkTitle: 'Crear payment link',
    createLinkAction: 'Crear link',
    confirmLinkText: '¿Confirmar la creación del payment link por',
    linkCreated: 'Payment link creado ✓',
    linkCreateNoRole: 'Tu rol no permite crear payment links (requiere owner/admin/finance).',
    confirmAction: 'Confirmar',
    cancelAction: 'Cancelar',
    creating: 'Creando…',
    refreshList: 'Actualizar lista',
    webhooks: 'Webhooks',
    webhookEventsTitle: 'Eventos de webhook',
    webhookEventsEmpty: 'Sin eventos de webhook.',
    webhookEventDetailTitle: 'Detalle del evento de webhook',
    colEvent: 'Evento',
    colEndpoint: 'Endpoint',
    fldTopic: 'Topic',
    fldNextAttempt: 'Próximo intento',
    fldDeliveredAt: 'Entregado',
    fldLastError: 'Último error',
    fldResentFrom: 'Reenviado desde',
    payloadTitle: 'Payload',
    attemptsTitle: 'Intentos de entrega',
    attemptsEmpty: 'Sin intentos registrados.',
    colAttempt: 'Intento',
    colStatusCode: 'Código HTTP',
    colLatency: 'Latencia (ms)',
    colResolvedIp: 'IP resuelta',
    colError: 'Error',
    apiKeys: 'API keys',
    apiKeysTitle: 'API keys',
    apiKeysEmpty: 'Sin API keys.',
    colLabel: 'Etiqueta',
    colPrefix: 'Prefijo',
    colScopes: 'Scopes',
    colEnvironment: 'Entorno',
    colLastUsed: 'Último uso',
    colRevoked: 'Revocada',
    keyActive: 'Activa',
    keyRevoked: 'Revocada',
    apiKeysReadOnlyNote:
      'Vista de solo lectura: crear/revocar una API key exige re-autenticación reciente (step-up MFA), aún no disponible desde el panel.',
    secretNeverShownNote:
      'El secreto de una API key jamás se muestra aquí: solo viaja una vez al crearla, por la integración.',
    webhookEndpoints: 'Endpoints',
    webhookEndpointsTitle: 'Endpoints de webhook',
    webhookEndpointsEmpty: 'Sin endpoints de webhook.',
    webhookEndpointDetailTitle: 'Detalle del endpoint',
    colUrl: 'URL',
    colEvents: 'Eventos',
    fldDescription2: 'Descripción',
    createEndpointTitle: 'Crear endpoint',
    createEndpointAction: 'Crear endpoint',
    endpointUrlLabel: 'URL de destino',
    endpointUrlHint: 'HTTPS de tu servidor que recibirá los eventos (sandbox).',
    endpointEventsLabel: 'Eventos (separados por coma; vacío = todos)',
    endpointEventsHint: 'Ej.: payment_intent.succeeded, refund.succeeded',
    rotateAction: 'Rotar secreto',
    rotateConfirm: '¿Rotar el secreto? El anterior seguirá firmando durante la ventana de gracia.',
    disableAction: 'Desactivar',
    disableConfirm: '¿Desactivar este endpoint? Dejará de recibir eventos.',
    disabledOk: 'Endpoint desactivado ✓',
    endpointCreated: 'Endpoint creado ✓',
    viewRelatedEvents: 'Ver eventos de webhook',
    endpointManageNoRole: 'Tu rol no permite gestionar endpoints (requiere owner/admin/developer).',
    allEvents: 'Todos los eventos',
    secretOnceTitle: 'Secreto de firma',
    secretOnceWarning: 'Copia este secreto ahora — no se volverá a mostrar.',
    secretOnceDismiss: 'Ya lo copié',
    createApiKeyTitle: 'Crear API key',
    createApiKeyAction: 'Crear API key',
    apiKeyLabelField: 'Etiqueta',
    apiKeyScopesField: 'Scopes',
    apiKeyScopesHint: 'Selecciona al menos uno. El API valida los permitidos.',
    apiKeyEnvNote: 'Entorno: test (sandbox). Las keys live no están disponibles.',
    apiKeyCreated: 'API key creada ✓',
    revokeAction: 'Revocar',
    revokeConfirm: '¿Revocar esta API key? Dejará de funcionar de inmediato.',
    keyRevokedOk: 'API key revocada ✓',
    keysManageNoRole:
      'Tu rol no permite crear ni revocar API keys (requiere owner/admin/developer).',
    selectAtLeastOneScope: 'Selecciona al menos un scope.',
    stepUpTitle: 'Confirma tu identidad',
    stepUpPrompt: 'Esta acción sensible requiere re-autenticación reciente. Ingresa tu contraseña.',
    stepUpPasswordLabel: 'Contraseña',
    stepUpSubmit: 'Confirmar',
    stepUpVerifying: 'Verificando…',
    stepUpWrongPassword: 'Contraseña incorrecta.',
    stepUpLocked: 'Demasiados intentos: la cuenta quedó bloqueada temporalmente.',
    stepUpMfaRequired:
      'Esta cuenta requiere un segundo factor para completar esta acción. El flujo de MFA step-up aún no está disponible en este dashboard sandbox.',
    stepUpCancel: 'Cancelar',
    signupTitle: 'Crear cuenta',
    signupLink: '¿No tienes cuenta? Crear cuenta',
    backToLogin: '← Volver a iniciar sesión',
    confirmPasswordLabel: 'Confirmar contraseña',
    createAccount: 'Crear cuenta',
    creatingAccount: 'Creando cuenta…',
    signupSandboxVerification: 'Verificación de email simulada — SANDBOX',
    signupNoRealEmail:
      'No se envía ningún correo real: tu email queda verificado automáticamente en este sandbox.',
    signupPasswordMismatch: 'Las contraseñas no coinciden.',
    signupEmailTaken: 'Ya existe una cuenta con este correo.',
    signupInvalidInput:
      'Datos inválidos: revisa el correo y usa una contraseña de al menos 10 caracteres.',
    signupGenericError: 'No se pudo crear la cuenta. Inténtalo de nuevo.',
    signupSuccess: 'Cuenta creada ✓ — redirigiendo a iniciar sesión…',
    noOrgCtaTitle: 'Tu cuenta está lista',
    noOrgCtaBody:
      'Aún no perteneces a ninguna organización. El siguiente paso es crear tu organización con el onboarding sandbox.',
    noOrgCtaAction: 'Crear tu organización →',
    onboardingTitle: 'Onboarding — crea tu organización',
    onboardingIntro:
      'Este es el onboarding del sandbox: configura tu organización y tu primer comercio con dinero simulado. No se mueve dinero real ni se contacta ningún proveedor.',
    onboardingStepOrg: 'Paso 1 de 2 — Organización',
    onboardingStepMerchant: 'Paso 2 de 2 — Comercio',
    orgNameLabel: 'Nombre de la organización',
    orgSlugLabel: 'Slug (identificador en URLs)',
    orgSlugHint: 'Minúsculas, números y guiones. Ej.: mi-empresa',
    continueAction: 'Continuar',
    creatingOrgAction: 'Creando organización…',
    onboardingOrgRecovered: 'Organización recuperada ✓ — continúa con tu comercio.',
    onboardingSlugTaken: 'Ese slug ya está en uso. Elige otro.',
    onboardingAlreadyCompleted:
      'Tu organización ya fue creada con otros datos: el onboarding ya está completado.',
    merchantNameLabel: 'Nombre del comercio',
    merchantCountryLabel: 'País (código ISO de 2 letras)',
    merchantCountryHint: 'Ej.: CO',
    merchantCurrencyLabel: 'Moneda predeterminada',
    finishAction: 'Finalizar',
    creatingMerchantAction: 'Creando comercio…',
    retryAction: 'Reintentar',
    merchantOnboardingAlreadyCompleted:
      'El comercio inicial de esta organización ya fue creado con otros datos. Gestiona comercios adicionales desde el panel.',
    onboardingMerchantRetryHint:
      'Si el paso falla a medias, reintenta: el estado real del backend gobierna la recuperación y no se duplican datos.',
    onboardingInvalidInput: 'Datos inválidos: revisa los campos del formulario.',
    onboardingGenericError: 'No se pudo completar el paso. Reintenta.',
    onboardingDone: 'Todo listo ✓ — abriendo el panel…',
    goToDashboard: 'Ir al panel',
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
    payouts: 'Payouts',
    payoutsTitle: 'Payouts (money out)',
    payoutsEmpty: 'No payouts.',
    colPayout: 'Payout',
    colMerchant: 'Merchant',
    payoutReason: 'Reason',
    payoutFailureCode: 'Failure code',
    payoutIndeterminateHint:
      'Bank outcome unknown: funds held in transit, awaiting verified resolution.',
    disputes: 'Disputes',
    disputesTitle: 'Disputes (chargebacks)',
    disputesEmpty: 'No disputes.',
    colDispute: 'Dispute',
    disputeReason: 'Reason',
    disputeProviderRef: 'Bank ref',
    disputeHeldHint:
      "Funds set aside from the merchant's reserve while the bank resolves the dispute.",
    disputeRespond: 'Respond with evidence',
    disputeResponding: 'Responding…',
    disputeEvidenceHint:
      'Marks that the merchant responded with evidence (open → under review). It does not decide the outcome: won/lost comes only from the bank before the deadline.',
    disputeEvidenceSubmitted: 'Evidence submitted — under review by the bank.',
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
    merchants: 'Merchants',
    merchantsTitle: 'Merchants',
    merchantsEmpty: 'No merchants in this organization.',
    merchantsNoMatch: 'No merchant matches the search.',
    searchLabel: 'Search merchants',
    searchPlaceholder: 'Name, ID, country or currency',
    searchAction: 'Search',
    searchClear: 'Clear',
    colName: 'Name',
    colCountry: 'Country',
    colCurrency: 'Currency',
    merchantActive: 'Active',
    merchantFrozen: 'Frozen',
    events: 'Events',
    eventsTitle: 'Audit events',
    eventsEmpty: 'No audit events.',
    colWhen: 'Timestamp',
    colActor: 'Actor',
    colResource: 'Resource',
    colResult: 'Result',
    colRisk: 'Risk',
    resultSuccess: 'Success',
    resultFailure: 'Failure',
    olderEvents: 'Older →',
    payments: 'Payments',
    paymentsTitle: 'Payments (payment intents)',
    paymentsEmpty: 'No payments.',
    paymentDetailTitle: 'Payment detail',
    fldCaptureMethod: 'Capture method',
    fldCaptured: 'Captured',
    fldRefunded: 'Refunded',
    fldFailureCode: 'Failure code',
    timelineTitle: 'Timeline',
    tlPaymentCreated: 'Payment created',
    tlSessionCreated: 'Checkout session created',
    tlSessionCompleted: 'Checkout session completed',
    tlRefundCreated: 'Refund created',
    relatedRefunds: 'Refunds for this payment',
    relatedSessions: 'Checkout sessions for this payment',
    refundCreateUnavailable:
      'Refunds are created from the payment detail (owner/admin/finance role).',
    refundsTitle: 'Refunds',
    refundsEmpty: 'No refunds.',
    refundDetailTitle: 'Refund detail',
    colPayment: 'Payment',
    sessionsTitle: 'Checkout sessions',
    sessionsEmpty: 'No checkout sessions.',
    sessionDetailTitle: 'Session detail',
    fldCustomer: 'Customer',
    fldExpires: 'Expires',
    fldCompletedAt: 'Completed',
    fldCheckoutUrl: 'Payment URL (sandbox)',
    linksTitle: 'Payment links',
    linksEmpty: 'No payment links.',
    linkDetailTitle: 'Payment link detail',
    fldDescription: 'Description',
    fldDisabledAt: 'Disabled',
    copyUrl: 'Copy URL',
    copied: 'Copied ✓',
    copyError: 'Could not copy.',
    createRefundTitle: 'Create refund',
    createRefundAction: 'Create refund',
    refundAmountHint: 'In minor units (COP has no decimals). Leave empty to refund all remaining.',
    confirmRefundText: 'Confirm the refund for',
    amountFullRemaining: 'all remaining?',
    refundCreated: 'Refund created ✓',
    refundCreateNoRole: 'Your role cannot create refunds (requires owner/admin/finance).',
    createLinkTitle: 'Create payment link',
    createLinkAction: 'Create link',
    confirmLinkText: 'Confirm creating the payment link for',
    linkCreated: 'Payment link created ✓',
    linkCreateNoRole: 'Your role cannot create payment links (requires owner/admin/finance).',
    confirmAction: 'Confirm',
    cancelAction: 'Cancel',
    creating: 'Creating…',
    refreshList: 'Refresh list',
    webhooks: 'Webhooks',
    webhookEventsTitle: 'Webhook events',
    webhookEventsEmpty: 'No webhook events.',
    webhookEventDetailTitle: 'Webhook event detail',
    colEvent: 'Event',
    colEndpoint: 'Endpoint',
    fldTopic: 'Topic',
    fldNextAttempt: 'Next attempt',
    fldDeliveredAt: 'Delivered',
    fldLastError: 'Last error',
    fldResentFrom: 'Resent from',
    payloadTitle: 'Payload',
    attemptsTitle: 'Delivery attempts',
    attemptsEmpty: 'No attempts recorded.',
    colAttempt: 'Attempt',
    colStatusCode: 'HTTP code',
    colLatency: 'Latency (ms)',
    colResolvedIp: 'Resolved IP',
    colError: 'Error',
    apiKeys: 'API keys',
    apiKeysTitle: 'API keys',
    apiKeysEmpty: 'No API keys.',
    colLabel: 'Label',
    colPrefix: 'Prefix',
    colScopes: 'Scopes',
    colEnvironment: 'Environment',
    colLastUsed: 'Last used',
    colRevoked: 'Revoked',
    keyActive: 'Active',
    keyRevoked: 'Revoked',
    apiKeysReadOnlyNote:
      'Read-only view: creating/revoking an API key requires recent re-authentication (MFA step-up), not available from the panel yet.',
    secretNeverShownNote:
      'An API key secret is never shown here: it only travels once at creation, via the integration.',
    webhookEndpoints: 'Endpoints',
    webhookEndpointsTitle: 'Webhook endpoints',
    webhookEndpointsEmpty: 'No webhook endpoints.',
    webhookEndpointDetailTitle: 'Endpoint detail',
    colUrl: 'URL',
    colEvents: 'Events',
    fldDescription2: 'Description',
    createEndpointTitle: 'Create endpoint',
    createEndpointAction: 'Create endpoint',
    endpointUrlLabel: 'Destination URL',
    endpointUrlHint: 'HTTPS on your server that will receive events (sandbox).',
    endpointEventsLabel: 'Events (comma-separated; empty = all)',
    endpointEventsHint: 'e.g. payment_intent.succeeded, refund.succeeded',
    rotateAction: 'Rotate secret',
    rotateConfirm: 'Rotate the secret? The old one keeps signing during the grace window.',
    disableAction: 'Disable',
    disableConfirm: 'Disable this endpoint? It will stop receiving events.',
    disabledOk: 'Endpoint disabled ✓',
    endpointCreated: 'Endpoint created ✓',
    viewRelatedEvents: 'View webhook events',
    endpointManageNoRole: 'Your role cannot manage endpoints (requires owner/admin/developer).',
    allEvents: 'All events',
    secretOnceTitle: 'Signing secret',
    secretOnceWarning: 'Copy this secret now — it will not be shown again.',
    secretOnceDismiss: 'I copied it',
    createApiKeyTitle: 'Create API key',
    createApiKeyAction: 'Create API key',
    apiKeyLabelField: 'Label',
    apiKeyScopesField: 'Scopes',
    apiKeyScopesHint: 'Select at least one. The API validates the allowed set.',
    apiKeyEnvNote: 'Environment: test (sandbox). Live keys are not available.',
    apiKeyCreated: 'API key created ✓',
    revokeAction: 'Revoke',
    revokeConfirm: 'Revoke this API key? It will stop working immediately.',
    keyRevokedOk: 'API key revoked ✓',
    keysManageNoRole:
      'Your role cannot create or revoke API keys (requires owner/admin/developer).',
    selectAtLeastOneScope: 'Select at least one scope.',
    stepUpTitle: 'Confirm your identity',
    stepUpPrompt: 'This sensitive action requires recent re-authentication. Enter your password.',
    stepUpPasswordLabel: 'Password',
    stepUpSubmit: 'Confirm',
    stepUpVerifying: 'Verifying…',
    stepUpWrongPassword: 'Incorrect password.',
    stepUpLocked: 'Too many attempts: the account is temporarily locked.',
    stepUpMfaRequired:
      'This account requires a second factor to complete this action. The MFA step-up flow is not available in this sandbox dashboard yet.',
    stepUpCancel: 'Cancel',
    signupTitle: 'Create account',
    signupLink: "Don't have an account? Create one",
    backToLogin: '← Back to sign in',
    confirmPasswordLabel: 'Confirm password',
    createAccount: 'Create account',
    creatingAccount: 'Creating account…',
    signupSandboxVerification: 'Email verification simulated — SANDBOX',
    signupNoRealEmail:
      'No real email is sent: your email is verified automatically in this sandbox.',
    signupPasswordMismatch: 'Passwords do not match.',
    signupEmailTaken: 'An account with this email already exists.',
    signupInvalidInput:
      'Invalid input: check the email and use a password of at least 10 characters.',
    signupGenericError: 'Could not create the account. Try again.',
    signupSuccess: 'Account created ✓ — redirecting to sign in…',
    noOrgCtaTitle: 'Your account is ready',
    noOrgCtaBody:
      'You do not belong to any organization yet. The next step is creating your organization with the sandbox onboarding.',
    noOrgCtaAction: 'Create your organization →',
    onboardingTitle: 'Onboarding — create your organization',
    onboardingIntro:
      'This is the sandbox onboarding: set up your organization and your first merchant with simulated money. No real money moves and no provider is contacted.',
    onboardingStepOrg: 'Step 1 of 2 — Organization',
    onboardingStepMerchant: 'Step 2 of 2 — Merchant',
    orgNameLabel: 'Organization name',
    orgSlugLabel: 'Slug (URL identifier)',
    orgSlugHint: 'Lowercase letters, digits and hyphens. E.g. my-company',
    continueAction: 'Continue',
    creatingOrgAction: 'Creating organization…',
    onboardingOrgRecovered: 'Organization recovered ✓ — continue with your merchant.',
    onboardingSlugTaken: 'That slug is already in use. Pick another one.',
    onboardingAlreadyCompleted:
      'Your organization was already created with different data: onboarding is already completed.',
    merchantNameLabel: 'Merchant name',
    merchantCountryLabel: 'Country (2-letter ISO code)',
    merchantCountryHint: 'E.g. CO',
    merchantCurrencyLabel: 'Default currency',
    finishAction: 'Finish',
    creatingMerchantAction: 'Creating merchant…',
    retryAction: 'Retry',
    merchantOnboardingAlreadyCompleted:
      'The initial merchant for this organization was already created with different data. Manage additional merchants from the dashboard.',
    onboardingMerchantRetryHint:
      'If the step fails halfway, retry: the real backend state governs recovery and no data is duplicated.',
    onboardingInvalidInput: 'Invalid input: review the form fields.',
    onboardingGenericError: 'Could not complete the step. Retry.',
    onboardingDone: 'All set ✓ — opening the dashboard…',
    goToDashboard: 'Go to dashboard',
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
