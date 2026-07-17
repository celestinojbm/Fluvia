export {
  createOrganizationWithOwner,
  createOrganizationForUser,
  OrganizationOnboardingService,
  type CreatedOrganization,
  type OnboardingOrganizationResult,
} from './platform.js';
export {
  IdentityService,
  merchantCreationLockKey,
  type OrganizationDto,
  type MerchantDto,
  type MemberDto,
  type MerchantOnboardingResult,
} from './tenant-service.js';
export { CustomerService, type CustomerDto } from './customers.js';
export {
  CreateOrganizationSchema,
  CreateOrganizationForUserSchema,
  CreateMerchantSchema,
  UpdateMerchantSchema,
  CreateCustomerSchema,
  UpdateCustomerSchema,
  ResourceMetadataSchema,
  SLUG_RE,
  type CreateOrganizationInput,
  type CreateOrganizationForUserInput,
  type CreateMerchantInput,
  type UpdateMerchantInput,
  type CreateCustomerInput,
  type UpdateCustomerInput,
} from './schemas.js';
export {
  IdentityError,
  OrganizationSlugTakenError,
  EmailTakenError,
  MerchantNameTakenError,
  OrganizationNotFoundError,
  MerchantNotFoundError,
  CustomerNotFoundError,
  OnboardingAlreadyCompletedError,
  MerchantOnboardingAlreadyCompletedError,
  OnboardingUserNotFoundError,
  OnboardingEmailNotVerifiedError,
} from './errors.js';
export {
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  assertPermission,
  InsufficientPermissionError,
  type Role,
  type Permission,
} from './rbac.js';
export {
  ApiKeyService,
  API_KEY_SCOPES,
  CreateApiKeySchema,
  DEV_API_KEY_HMAC_SECRET_HEX,
  hashApiKeySecret,
  hmacApiKeySecret,
  apiKeyPepperFingerprint,
  parseApiKeyHmacSecret,
  ApiKeyNotFoundError,
  InvalidApiKeyError,
  InsufficientScopeError,
  LiveKeysDisabledError,
  type ApiKeyScope,
  type CreateApiKeyInput,
  type CreatedApiKey,
  type ApiKeyDto,
} from './api-keys.js';
export {
  inspectApiKeyPepper,
  backfillApiKeyPepperFp,
  type ApiKeyPepperStatus,
} from './rotate-api-key-pepper.js';
