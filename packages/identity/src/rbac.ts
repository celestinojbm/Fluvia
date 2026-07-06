import { IdentityError } from './errors.js';

/**
 * RBAC declarativo (F1-04c). La matriz es la fuente de verdad y se publica
 * en docs/security/access-control.md; los tests recorren la matriz completa.
 */

export const ROLES = [
  'owner',
  'admin',
  'developer',
  'finance',
  'support',
  'analyst',
  'read_only',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org:read',
  'members:read',
  'merchants:read',
  'merchants:write',
  'keys:read',
  'keys:manage',
  'audit:read',
  // F3-09b: lectura del plano de operación (dashboard) — intents, refunds,
  // checkout sessions, payment links y la cola de webhooks. Dato de tenant de
  // solo lectura, así que lo tiene todo rol (todos ya tienen org:read).
  'payments:read',
  // F3-09b-iii: acción de operación sobre webhooks (reenvío de eventos `dead`)
  // por SESIÓN. Espeja el scope de API key homónimo en el plano de sesión; solo
  // roles que gestionan la integración (owner/admin/developer).
  'webhooks:manage',
  // F4-03c: operación de conciliación por SESIÓN — trabajar casos (ack/resolve)
  // y AUTORIZAR ajustes monetarios (proponer/aprobar/rechazar). El four-eyes
  // (aprobador != proponente) se exige por identidad, no por permiso. Solo roles
  // que gobiernan el dinero/conciliación (owner/admin/finance).
  'reconciliation:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ALL,
  developer: [
    'org:read',
    'members:read',
    'merchants:read',
    'keys:read',
    'keys:manage',
    'payments:read',
    'webhooks:manage',
  ],
  finance: [
    'org:read',
    'members:read',
    'merchants:read',
    'keys:read',
    'audit:read',
    'payments:read',
    'reconciliation:manage',
  ],
  support: ['org:read', 'members:read', 'merchants:read', 'payments:read'],
  analyst: ['org:read', 'members:read', 'merchants:read', 'audit:read', 'payments:read'],
  read_only: ['org:read', 'members:read', 'merchants:read', 'payments:read'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export class InsufficientPermissionError extends IdentityError {
  constructor(readonly permission: Permission) {
    super(`Current role lacks the required permission: ${permission}`);
  }
}

export function assertPermission(role: Role, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new InsufficientPermissionError(permission);
  }
}
