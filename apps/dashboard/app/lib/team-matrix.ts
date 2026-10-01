/**
 * Espejo de lectura de `ROLE_PERMISSIONS` (@fluvia/identity) para explicar al
 * comercio qué puede hacer cada rol. Es DOCUMENTACIÓN en pantalla: el API es
 * quien autoriza. Un test comprueba la paridad con la matriz real.
 */
export const ROLE_ORDER = [
  'owner',
  'admin',
  'finance',
  'developer',
  'support',
  'analyst',
  'read_only',
] as const;

export const ROLE_PERMISSIONS_MIRROR: Record<(typeof ROLE_ORDER)[number], readonly string[]> = {
  owner: [
    'org:read',
    'members:read',
    'merchants:read',
    'merchants:write',
    'keys:read',
    'keys:manage',
    'audit:read',
    'payments:read',
    'webhooks:manage',
    'reconciliation:manage',
  ],
  admin: [
    'org:read',
    'members:read',
    'merchants:read',
    'merchants:write',
    'keys:read',
    'keys:manage',
    'audit:read',
    'payments:read',
    'webhooks:manage',
    'reconciliation:manage',
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
  developer: [
    'org:read',
    'members:read',
    'merchants:read',
    'keys:read',
    'keys:manage',
    'payments:read',
    'webhooks:manage',
  ],
  support: ['org:read', 'members:read', 'merchants:read', 'payments:read'],
  analyst: ['org:read', 'members:read', 'merchants:read', 'audit:read', 'payments:read'],
  read_only: ['org:read', 'members:read', 'merchants:read', 'payments:read'],
};

/** Capacidades de producto ↔ permiso que las protege en el servidor. */
export const CAPABILITIES: Array<{ label: string; permission: string }> = [
  { label: 'Ver ventas, pagos, caja y catálogo', permission: 'payments:read' },
  { label: 'Vender, cobrar, devolver y gestionar clientes', permission: 'reconciliation:manage' },
  { label: 'Editar catálogo y comercios', permission: 'merchants:write' },
  { label: 'Ver auditoría', permission: 'audit:read' },
  { label: 'Gestionar API keys', permission: 'keys:manage' },
  { label: 'Gestionar webhooks', permission: 'webhooks:manage' },
];
