/**
 * F1-08 — Taxonomia de errores del API (V4 §25, cierra AUD-P2-009).
 *
 * Contrato:
 *  - Sobre estable: { error: { type, code, message, details?, request_id } }.
 *  - `code` es legible por maquina y sale de ESTE catalogo cerrado; `type` es
 *    su categoria. `message` es el texto PUBLICO del catalogo — el message
 *    interno de los errores de dominio va SOLO a logs (AUD-P2-009: jamas se
 *    filtra detalle interno al cliente).
 *  - `details` solo existe donde el catalogo lo declara (hoy: validacion).
 *
 * Versionado (contract test contra test/golden/error-catalog.v1.json):
 *  - ADITIVO (codigo nuevo): permitido dentro de la misma version; se
 *    actualiza el golden en el mismo PR.
 *  - BREAKING (cambiar/eliminar code, status, type de un codigo existente):
 *    exige bump de ERROR_CATALOG_VERSION + nota de deprecacion en
 *    docs/architecture/api-errors.md. El golden lo hace imposible de hacer
 *    por accidente.
 */

export const ERROR_CATALOG_VERSION = 1;

export const ERROR_CATEGORIES = [
  'validation_error',
  'authentication_error',
  'authorization_error',
  'not_found_error',
  'conflict_error',
  'unprocessable_error',
  'locked_error',
  'rate_limit_error',
  'internal_error',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface ErrorCatalogEntry {
  status: number;
  type: ErrorCategory;
  /** Mensaje PUBLICO y estable; sin datos internos. */
  message: string;
  /** true si la respuesta puede llevar `details` estructurados. */
  hasDetails?: boolean;
}

export const ERROR_CATALOG = {
  // --- validacion / forma del request ---
  validation_error: {
    status: 400,
    type: 'validation_error',
    message: 'Invalid request payload',
    hasDetails: true,
  },
  invalid_json: {
    status: 400,
    type: 'validation_error',
    message: 'Request body is not valid JSON',
  },
  bad_request: {
    status: 400,
    type: 'validation_error',
    message: 'The request could not be processed',
  },
  payload_too_large: {
    status: 413,
    type: 'validation_error',
    message: 'Request body exceeds the size limit',
  },
  unsupported_media_type: {
    status: 415,
    type: 'validation_error',
    message: 'Unsupported content type',
  },
  invalid_verification_token: {
    status: 400,
    type: 'validation_error',
    message: 'The verification token is invalid, expired or already used',
  },
  reversal_note_required: {
    status: 400,
    type: 'validation_error',
    message: 'Reversals require an explicit, non-empty note',
  },
  idempotency_key_required: {
    status: 400,
    type: 'validation_error',
    message: 'The Idempotency-Key header is required and must be 1-255 printable characters',
  },
  // --- autenticacion ---
  invalid_credentials: {
    status: 401,
    type: 'authentication_error',
    message: 'Invalid email or password',
  },
  invalid_session: {
    status: 401,
    type: 'authentication_error',
    message: 'The session is invalid, expired or revoked',
  },
  invalid_api_key: {
    status: 401,
    type: 'authentication_error',
    message: 'The API key is invalid or revoked',
  },
  invalid_signature: {
    status: 401,
    type: 'authentication_error',
    message: 'The webhook signature is invalid or stale',
  },
  invalid_mfa_code: {
    status: 401,
    type: 'authentication_error',
    message: 'The MFA code is invalid',
  },
  invalid_mfa_challenge: {
    status: 401,
    type: 'authentication_error',
    message: 'The MFA challenge is invalid, expired or already used',
  },
  // --- autorizacion ---
  email_not_verified: {
    status: 403,
    type: 'authorization_error',
    message: 'Email address must be verified before logging in',
  },
  insufficient_permissions: {
    status: 403,
    type: 'authorization_error',
    message: 'Your role does not allow this action',
  },
  insufficient_scope: {
    status: 403,
    type: 'authorization_error',
    message: 'The API key lacks the required scope',
  },
  live_keys_disabled: {
    status: 403,
    type: 'authorization_error',
    message: 'Live API keys are not available yet',
  },
  mfa_step_up_required: {
    status: 403,
    type: 'authorization_error',
    message:
      'This action requires recent re-authentication: call /v1/auth/mfa/step-up (MFA) or /v1/auth/step-up/password (no MFA)',
  },
  // --- no encontrado (anti-enumeracion: cross-tenant es indistinguible) ---
  not_found: {
    status: 404,
    type: 'not_found_error',
    message: 'Resource not found',
  },
  // --- conflictos de estado ---
  email_taken: {
    status: 409,
    type: 'conflict_error',
    message: 'An account with this email already exists',
  },
  merchant_name_taken: {
    status: 409,
    type: 'conflict_error',
    message: 'A merchant with this name already exists in the organization',
  },
  organization_slug_taken: {
    status: 409,
    type: 'conflict_error',
    message: 'This organization slug is already in use',
  },
  insufficient_balance: {
    status: 409,
    type: 'conflict_error',
    message: 'The operation would leave a protected balance negative',
  },
  idempotency_conflict: {
    status: 409,
    type: 'conflict_error',
    message: 'This idempotency key was already used with a different request',
  },
  already_reversed: {
    status: 409,
    type: 'conflict_error',
    message: 'This transaction has already been reversed',
  },
  cannot_reverse_reversal: {
    status: 409,
    type: 'conflict_error',
    message: 'A reversal cannot be reversed; post a new forward transaction',
  },
  processing_in_flight: {
    status: 409,
    type: 'conflict_error',
    message: 'A request with this idempotency key is still being processed; retry shortly',
  },
  invalid_state_transition: {
    status: 409,
    type: 'conflict_error',
    message: 'The resource is not in a state that allows this operation',
  },
  four_eyes_required: {
    status: 409,
    type: 'conflict_error',
    message: 'This action requires approval by a second, distinct authorized user',
  },
  idempotency_key_reuse: {
    status: 422,
    type: 'unprocessable_error',
    message: 'This idempotency key was already used with a different payload',
  },
  refund_amount_exceeds_remaining: {
    status: 422,
    type: 'unprocessable_error',
    message: 'The refund amount exceeds the remaining refundable amount for this payment',
  },
  payout_amount_exceeds_balance: {
    status: 422,
    type: 'unprocessable_error',
    message: "The payout amount exceeds the merchant's available balance",
  },
  // TM-06 (pci-scope.md §3): Fluvia jamas acepta datos primarios de tarjeta.
  card_data_not_allowed: {
    status: 422,
    type: 'unprocessable_error',
    message:
      'The request appears to contain primary card data (PAN/CVV). Fluvia never accepts raw card data; use provider tokenization (tok_...)',
  },
  mfa_already_enabled: {
    status: 409,
    type: 'conflict_error',
    message: 'MFA is already enabled for this account',
  },
  mfa_not_enabled: {
    status: 409,
    type: 'conflict_error',
    message: 'MFA is not enabled (or not pending activation) for this account',
  },
  // --- bloqueos / limites ---
  account_locked: {
    status: 423,
    type: 'locked_error',
    message: 'The account is temporarily locked after repeated failed logins',
  },
  rate_limited: {
    // Reservado: el rate limiting llega con F1-04b (AUD-P1-006).
    status: 429,
    type: 'rate_limit_error',
    message: 'Too many requests; retry later',
  },
  // --- interno ---
  internal_error: {
    status: 500,
    type: 'internal_error',
    message: 'Internal server error',
  },
} as const satisfies Record<string, ErrorCatalogEntry>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

/** Mapa nombre-de-clase-de-error-de-dominio -> codigo del catalogo. */
export const DOMAIN_ERROR_CODES: Record<string, ErrorCode> = {
  // auth (F1-04a)
  EmailTakenError: 'email_taken',
  InvalidCredentialsError: 'invalid_credentials',
  EmailNotVerifiedError: 'email_not_verified',
  AccountLockedError: 'account_locked',
  InvalidSessionError: 'invalid_session',
  InvalidVerificationTokenError: 'invalid_verification_token',
  // identidad / RBAC / API keys (F1-03, F1-04c). Los not-found cross-tenant
  // son indistinguibles de los inexistentes por diseño (anti-enumeracion).
  OrganizationNotFoundError: 'not_found',
  MerchantNotFoundError: 'not_found',
  CustomerNotFoundError: 'not_found',
  ApiKeyNotFoundError: 'not_found',
  MerchantNameTakenError: 'merchant_name_taken',
  OrganizationSlugTakenError: 'organization_slug_taken',
  InsufficientPermissionError: 'insufficient_permissions',
  InvalidApiKeyError: 'invalid_api_key',
  InsufficientScopeError: 'insufficient_scope',
  LiveKeysDisabledError: 'live_keys_disabled',
  // ledger (F2)
  InsufficientBalanceError: 'insufficient_balance',
  IdempotencyConflictError: 'idempotency_conflict',
  TransactionNotFoundError: 'not_found',
  TransactionAlreadyReversedError: 'already_reversed',
  CannotReverseReversalError: 'cannot_reverse_reversal',
  ReversalNoteRequiredError: 'reversal_note_required',
  // inbox (F2-12; el endpoint HTTP llega en F3)
  InvalidWebhookSignatureError: 'invalid_signature',
  PayloadTooLargeError: 'payload_too_large',
  // capa de idempotencia API (F2-09)
  IdempotencyKeyRequiredError: 'idempotency_key_required',
  ProcessingInFlightError: 'processing_in_flight',
  IdempotencyKeyReuseError: 'idempotency_key_reuse',
  // pagos F3-01/F3-02
  PaymentIntentNotFoundError: 'not_found',
  // refunds F3-08
  RefundNotFoundError: 'not_found',
  RefundAmountExceedsRemainingError: 'refund_amount_exceeds_remaining',
  // payouts F4-07
  PayoutNotFoundError: 'not_found',
  InsufficientPayoutBalanceError: 'payout_amount_exceeds_balance',
  // disputas F4-08
  DisputeNotFoundError: 'not_found',
  // checkout sessions F3-05b
  CheckoutSessionNotFoundError: 'not_found',
  CheckoutSessionInvalidCustomerError: 'validation_error',
  // payment links F3-06
  PaymentLinkNotFoundError: 'not_found',
  PaymentLinkInvalidMerchantError: 'validation_error',
  // webhooks salientes F3-07
  WebhookEndpointNotFoundError: 'not_found',
  InvalidWebhookTopicError: 'validation_error',
  UnsafeWebhookUrlError: 'validation_error',
  // webhooks: cola + reenvío F3-09a
  WebhookEventNotFoundError: 'not_found',
  WebhookEventNotDeadError: 'invalid_state_transition',
  // conciliación F4-01b
  SettlementReportNotFoundError: 'not_found',
  ReportAlreadyReconciledError: 'invalid_state_transition',
  // casos operativos F4-03a
  OperationalCaseNotFoundError: 'not_found',
  InvalidCaseTransitionError: 'invalid_state_transition',
  // ajustes con four-eyes F4-03b/F4-03c
  CaseAdjustmentNotFoundError: 'not_found',
  InvalidAdjustmentTransitionError: 'invalid_state_transition',
  CaseAdjustmentExistsError: 'invalid_state_transition',
  SelfApprovalError: 'four_eyes_required',
  InvalidStateTransitionError: 'invalid_state_transition',
  UnknownCurrencyError: 'validation_error',
  InvalidAmountError: 'validation_error',
  // MFA + step-up + rate limiting (F1-04b)
  InvalidMfaCodeError: 'invalid_mfa_code',
  InvalidMfaChallengeError: 'invalid_mfa_challenge',
  MfaAlreadyEnabledError: 'mfa_already_enabled',
  MfaNotEnabledError: 'mfa_not_enabled',
  StepUpRequiredError: 'mfa_step_up_required',
  RateLimitedError: 'rate_limited',
};

export interface PublicErrorBody {
  error: {
    type: ErrorCategory;
    code: ErrorCode;
    message: string;
    details?: unknown;
    request_id: string;
  };
}

/** Construye el sobre publico desde el catalogo (unica via de salida). */
export function errorBody(code: ErrorCode, requestId: string, details?: unknown): PublicErrorBody {
  const entry: ErrorCatalogEntry = ERROR_CATALOG[code];
  return {
    error: {
      type: entry.type,
      code,
      message: entry.message,
      ...(entry.hasDetails && details !== undefined ? { details } : {}),
      request_id: requestId,
    },
  };
}
