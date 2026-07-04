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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ALL,
  developer: ['org:read', 'members:read', 'merchants:read', 'keys:read', 'keys:manage'],
  finance: ['org:read', 'members:read', 'merchants:read', 'keys:read', 'audit:read'],
  support: ['org:read', 'members:read', 'merchants:read'],
  analyst: ['org:read', 'members:read', 'merchants:read', 'audit:read'],
  read_only: ['org:read', 'members:read', 'merchants:read'],
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
