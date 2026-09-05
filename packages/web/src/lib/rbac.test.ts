/**
 * RBAC tests.
 *
 * The matrix is shared by the API, the nav and `docs/rbac.md`, so these assertions are the thing
 * that stops the three drifting apart. Each one is a permission decision somebody could be asked to
 * justify in an audit.
 */
import { describe, expect, it } from 'vitest';
import {
  ROLE_CAPABILITIES,
  can,
  capabilityForPath,
  navFor,
  userRoles,
  type Capability,
} from '@saakshi/shared';

describe('the capability matrix', () => {
  it('covers all four seeded roles', () => {
    expect(Object.keys(ROLE_CAPABILITIES).sort()).toEqual([
      'admin',
      'auditor',
      'operator',
      'supervisor',
    ]);
    expect(userRoles).toHaveLength(4);
  });

  it('every role can read the registry — it is the shared surface', () => {
    for (const role of userRoles) expect(can(role, 'registry:read')).toBe(true);
  });

  it('only admin may delete, matching the API D1-02 shipped', () => {
    // D1-02: "read = all four roles; create/update/import = admin+supervisor; delete = admin only."
    expect(can('admin', 'registry:delete')).toBe(true);
    for (const role of ['supervisor', 'operator', 'auditor'] as const) {
      expect(can(role, 'registry:delete')).toBe(false);
    }
  });

  it('admin and supervisor may write; operator and auditor may not', () => {
    expect(can('admin', 'registry:write')).toBe(true);
    expect(can('supervisor', 'registry:write')).toBe(true);
    expect(can('operator', 'registry:write')).toBe(false);
    expect(can('auditor', 'registry:write')).toBe(false);
  });

  it('the operator is read-only on the registry but runs the control room', () => {
    expect(can('operator', 'registry:read')).toBe(true);
    expect(can('operator', 'registry:write')).toBe(false);
    expect(can('operator', 'alerts:acknowledge')).toBe(true);
    expect(can('operator', 'video:view')).toBe(true);
  });

  it('the auditor sees the audit chain and nothing that would widen surveillance', () => {
    // An auditor who can change what is audited is not an auditor — and the audit function examines
    // what was done, not the footage, so live video would widen the surveillance surface for no
    // audit purpose.
    expect(can('auditor', 'audit:read')).toBe(true);
    expect(can('auditor', 'audit:export')).toBe(true);
    expect(can('auditor', 'registry:write')).toBe(false);
    expect(can('auditor', 'video:view')).toBe(false);
    expect(can('auditor', 'trace:run')).toBe(false);
    expect(can('auditor', 'alerts:acknowledge')).toBe(false);
  });

  it('no role is granted a capability that does not exist', () => {
    const known = new Set<string>([
      'registry:read',
      'registry:write',
      'registry:delete',
      'registry:import',
      'trust:read',
      'video:view',
      'trace:run',
      'alerts:view',
      'alerts:acknowledge',
      'audit:read',
      'audit:export',
      'sizing:use',
    ]);
    for (const role of userRoles) {
      for (const capability of ROLE_CAPABILITIES[role]) expect(known.has(capability)).toBe(true);
    }
  });
});

describe('the nav is rendered from the matrix', () => {
  it('the auditor sees Audit but not Video Wall, Trace or Alerts', () => {
    const labels = navFor('auditor').map((item) => item.label);
    expect(labels).toContain('Audit');
    expect(labels).toContain('Registry');
    // D3-05. "How long does this footage last" exposes no footage, and an auditor needs to be able
    // to ask it — the answer is a registry fact, not a surveillance capability.
    expect(labels).toContain('Evidence');
    expect(labels).not.toContain('Video Wall');
    expect(labels).not.toContain('Trace');
    expect(labels).not.toContain('Alerts');
  });

  it('the operator sees the control-room screens', () => {
    const labels = navFor('operator').map((item) => item.label);
    expect(labels).toEqual(['Registry', 'Video Wall', 'Trace', 'Alerts', 'Evidence', 'Sizing']);
  });

  it('admin and supervisor see everything', () => {
    expect(navFor('admin')).toHaveLength(7);
    expect(navFor('supervisor')).toHaveLength(7);
  });
});

describe('route → capability, for the server-side guard', () => {
  it.each([
    ['/registry', 'registry:read'],
    ['/registry/cam01', 'registry:read'],
    ['/video-wall', 'video:view'],
    ['/trace', 'trace:run'],
    ['/alerts', 'alerts:view'],
    ['/audit', 'audit:read'],
    ['/evidence', 'registry:read'],
    ['/sizing', 'sizing:use'],
  ] as [string, Capability][])('%s requires %s', (path, capability) => {
    expect(capabilityForPath(path)).toBe(capability);
  });

  it('an unlisted path is open to any signed-in role', () => {
    expect(capabilityForPath('/')).toBeUndefined();
    expect(capabilityForPath('/forbidden')).toBeUndefined();
  });

  it('a prefix match does not leak across sibling routes', () => {
    // `/registry-archive` must not inherit `/registry`'s capability by string prefix alone.
    expect(capabilityForPath('/registry-archive')).toBeUndefined();
  });

  it('every nav destination has a matching route guard', () => {
    // Otherwise a role could reach by URL what the nav declines to show it.
    for (const item of navFor('admin')) {
      expect(capabilityForPath(item.href)).toBe(item.capability);
    }
  });
});
