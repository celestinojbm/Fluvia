import { describe, expect, it } from 'vitest';
import {
  InsufficientPermissionError,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  assertPermission,
  hasPermission,
} from '../src/index.js';

/**
 * Matriz esperada COMPLETA — duplicada a proposito respecto a la
 * implementacion: un cambio accidental en ROLE_PERMISSIONS rompe este test.
 */
const EXPECTED: Record<string, Record<string, boolean>> = {
  owner: {
    'org:read': true,
    'members:read': true,
    'merchants:read': true,
    'merchants:write': true,
    'keys:read': true,
    'keys:manage': true,
  },
  admin: {
    'org:read': true,
    'members:read': true,
    'merchants:read': true,
    'merchants:write': true,
    'keys:read': true,
    'keys:manage': true,
  },
  developer: {
    'org:read': true,
    'members:read': true,
    'merchants:read': true,
    'merchants:write': false,
    'keys:read': true,
    'keys:manage': true,
  },
  finance: {
    'org:read': true,
    'members:read': true,
    'merchants:read': true,
    'merchants:write': false,
    'keys:read': true,
    'keys:manage': false,
  },
  support: {
    'org:read': true,
    'members:read': true,
    'merchants:read': true,
    'merchants:write': false,
    'keys:read': false,
    'keys:manage': false,
  },
  analyst: {
    'org:read': true,
    'members:read': true,
    'merchants:read': true,
    'merchants:write': false,
    'keys:read': false,
    'keys:manage': false,
  },
  read_only: {
    'org:read': true,
    'members:read': true,
    'merchants:read': true,
    'merchants:write': false,
    'keys:read': false,
    'keys:manage': false,
  },
};

describe('RBAC matrix (F1-04c)', () => {
  it('covers every role and every permission exactly', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) {
      expect(Object.keys(EXPECTED[role]!).sort()).toEqual([...PERMISSIONS].sort());
    }
  });

  it('hasPermission matches the expected matrix cell by cell', () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS) {
        expect(hasPermission(role, permission), `${role} × ${permission}`).toBe(
          EXPECTED[role]![permission]
        );
      }
    }
  });

  it('assertPermission throws InsufficientPermissionError on denial', () => {
    expect(() => assertPermission('read_only', 'merchants:write')).toThrow(
      InsufficientPermissionError
    );
    expect(() => assertPermission('owner', 'merchants:write')).not.toThrow();
  });

  it('every role has at least read access and no role escapes the catalog', () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
      for (const p of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(p);
      }
    }
  });
});
