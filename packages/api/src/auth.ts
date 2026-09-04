import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
  preHandlerHookHandler,
} from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { users } from '@saakshi/shared/db';
import type { Db } from './db/client.js';

/**
 * Bearer-token auth and the role matrix.
 *
 * There is deliberately **no login route here**. D1-02's nine endpoints do not include one, and
 * D1-07 owns authentication on the web side; this module only verifies a token that something else
 * issued. Tests mint their own with the same `JWT_SECRET`.
 */

export const userRoles = ['admin', 'supervisor', 'operator', 'auditor'] as const;
export type UserRole = (typeof userRoles)[number];

export const Principal = z.object({
  sub: z.uuid(),
  badgeNo: z.string().min(1),
  role: z.enum(userRoles),
  departmentId: z.uuid().nullable().default(null),
});
export type Principal = z.infer<typeof Principal>;

/**
 * The role matrix, spelled out because "who may delete a camera" is a question an auditor will ask
 * and the answer should be readable in one place rather than inferred from decorators.
 *
 * - `operator`   — the control-room seat. Read-only on the registry.
 * - `supervisor` — may create and update cameras, including bulk import and catalogue onboarding.
 * - `admin`      — may additionally delete (soft).
 * - `auditor`    — read-only, by design: an auditor who can change the thing being audited is not
 *                  an auditor.
 */
export const READ_ROLES: readonly UserRole[] = ['admin', 'supervisor', 'operator', 'auditor'];
export const WRITE_ROLES: readonly UserRole[] = ['admin', 'supervisor'];
export const DELETE_ROLES: readonly UserRole[] = ['admin'];

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Verifies the bearer token and attaches the principal. 401 for missing or malformed credentials,
 * which is a different answer from 403 for "authenticated but not permitted" — clients need to be
 * able to tell "log in again" from "you may not do this".
 *
 * When a `db` is supplied the subject is also checked against `users`, and a token for an unknown
 * or deactivated badge is refused. Two reasons this is not optional in a deployment:
 *
 *  - **Security.** A signed token stays cryptographically valid after the officer it belongs to is
 *    deactivated. Without this check, revoking someone's account would not revoke their access.
 *  - **It was returning the wrong status.** `audit_log.actor_id` references `users(id)`, so a
 *    mutation by a non-existent subject failed on the foreign key *inside the handler* and surfaced
 *    as a 500. Caught by the validation gate, where a hand-minted token carried a subject that was
 *    not a seeded user. An unknown principal is an authentication problem and must answer 401.
 */
export function authenticate(db?: Db): preHandlerAsyncHookHandler {
  return async function authenticateHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const raw = await request.jwtVerify();
      const parsed = Principal.safeParse(raw);
      if (!parsed.success) {
        reply.code(401).send({ error: 'unauthorized', message: 'malformed token claims' });
        return;
      }
      if (db !== undefined) {
        const rows = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, parsed.data.sub), eq(users.active, true)))
          .limit(1);
        if (rows.length === 0) {
          reply
            .code(401)
            .send({ error: 'unauthorized', message: 'token subject is not an active user' });
          return;
        }
      }

      request.principal = parsed.data;
    } catch {
      reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid bearer token' });
    }
  };
}

// Synchronous by design: it only inspects a claim already on the request, and a sync hook keeps
// the `void`-returning contract Fastify expects.
export function requireRole(allowed: readonly UserRole[]): preHandlerHookHandler {
  return function requireRoleHook(request: FastifyRequest, reply: FastifyReply, done): void {
    const principal = request.principal;
    if (principal === undefined) {
      reply.code(401).send({ error: 'unauthorized', message: 'not authenticated' });
      return;
    }
    if (!allowed.includes(principal.role)) {
      reply.code(403).send({
        error: 'forbidden',
        message: `role '${principal.role}' may not perform this action`,
        allowed: [...allowed],
      });
      return;
    }
    done();
  };
}
