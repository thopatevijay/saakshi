/**
 * The role × capability matrix — one definition, three consumers.
 *
 * The API enforces it, the web shell renders from it, and `docs/rbac.md` is generated against it.
 * Three hand-maintained copies of "who may delete a camera" would drift, and the drift would be
 * invisible: the UI would keep hiding a button the server had started allowing, or worse, keep
 * showing one the server refuses. **The server is always authoritative** — client-side gating is a
 * courtesy that stops users walking into a 403, never a security boundary.
 */
import { z } from 'zod';

export const UserRole = z.enum(['admin', 'supervisor', 'operator', 'auditor']);
export type UserRole = z.infer<typeof UserRole>;

export const userRoles = UserRole.options;

/**
 * What a role may *do*, independent of which screen exposes it.
 *
 * Capabilities rather than routes, because a capability survives a redesign: moving the export
 * button from the registry to a reports page must not change who is allowed to press it.
 */
export const CAPABILITIES = [
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
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The matrix. Every cell is a decision somebody will eventually be asked to justify in an audit, so
 * each role carries the reason it has the list it has.
 */
export const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  /** Full control: registry, onboarding, retention policy. The only role that may delete. */
  admin: [
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
  ],
  /** Approves exports and escalations; may onboard cameras but never decommission one. */
  supervisor: [
    'registry:read',
    'registry:write',
    'registry:import',
    'trust:read',
    'video:view',
    'trace:run',
    'alerts:view',
    'alerts:acknowledge',
    'audit:read',
    'audit:export',
    'sizing:use',
  ],
  /** The control-room seat: watch, verify, acknowledge. Read-only on the registry. */
  operator: [
    'registry:read',
    'trust:read',
    'video:view',
    'trace:run',
    'alerts:view',
    'alerts:acknowledge',
    'sizing:use',
  ],
  /**
   * Read-only across the audit chain, by design. An auditor who can change the thing being audited
   * is not an auditor. Deliberately **no** `video:view` and **no** `trace:run`: the audit function
   * examines what was done, not the footage itself, and granting live video would widen the
   * surveillance surface for no audit purpose.
   */
  auditor: ['registry:read', 'trust:read', 'audit:read', 'audit:export'],
};

export function can(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function canAll(role: UserRole, capabilities: readonly Capability[]): boolean {
  return capabilities.every((capability) => can(role, capability));
}

/** A navigation destination and the capability that unlocks it. */
export interface NavItem {
  href: string;
  label: string;
  /** Required to see the item at all. Absent means every authenticated role sees it. */
  capability?: Capability;
}

/** The left nav, in the order the ticket specifies. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/registry', label: 'Registry', capability: 'registry:read' },
  { href: '/video-wall', label: 'Video Wall', capability: 'video:view' },
  { href: '/trace', label: 'Trace', capability: 'trace:run' },
  { href: '/alerts', label: 'Alerts', capability: 'alerts:view' },
  { href: '/audit', label: 'Audit', capability: 'audit:read' },
  { href: '/sizing', label: 'Sizing', capability: 'sizing:use' },
];

/**
 * Route prefix → capability, for the server-side guard.
 *
 * A direct URL must be refused by the same table the nav renders from. Anything not listed here is
 * reachable by any authenticated user.
 */
export const ROUTE_CAPABILITIES: readonly { prefix: string; capability: Capability }[] = [
  { prefix: '/registry', capability: 'registry:read' },
  { prefix: '/video-wall', capability: 'video:view' },
  { prefix: '/trace', capability: 'trace:run' },
  { prefix: '/alerts', capability: 'alerts:view' },
  { prefix: '/audit', capability: 'audit:read' },
  { prefix: '/sizing', capability: 'sizing:use' },
];

/** The capability a path requires, or `undefined` when it is open to any signed-in role. */
export function capabilityForPath(pathname: string): Capability | undefined {
  return ROUTE_CAPABILITIES.find(
    (route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`),
  )?.capability;
}

export function navFor(role: UserRole): NavItem[] {
  return NAV_ITEMS.filter((item) => item.capability === undefined || can(role, item.capability));
}
