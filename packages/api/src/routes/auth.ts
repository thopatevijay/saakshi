/**
 * Session issuance (D1-07).
 *
 * D1-02 deliberately shipped nine registry endpoints and no login: *"No login route here — D1-07
 * owns issuance."* This is that route. Everything else in the API only ever **verifies** a token;
 * this is the single place one is created.
 *
 * Passwords are checked **in PostgreSQL**, not in Node. The seed stores
 * `crypt('saakshi-dev', gen_salt('bf'))` through pgcrypto, so the comparison is
 * `password_hash = crypt($password, password_hash)` — bcrypt with the stored salt, done by the
 * database. That removes a native npm dependency from the deploy and keeps the hash from ever
 * being copied into application memory.
 */
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { users, departments } from '@saakshi/shared/db';
import { ROLE_CAPABILITIES, userRoles } from '@saakshi/shared';
import type { App } from '../server.js';
import type { Db } from '../db/client.js';
import { authenticate } from '../auth.js';
import { ErrorResponse } from './camera-contracts.js';

/** How long an issued session lasts. A control-room shift, not a week. */
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

export const LoginRequest = z.object({
  badgeNo: z.string().min(1, 'badge number is required'),
  password: z.string().min(1, 'password is required'),
});

export const SessionUser = z.object({
  id: z.uuid(),
  name: z.string(),
  badgeNo: z.string(),
  role: z.enum(userRoles),
  departmentId: z.uuid().nullable(),
  departmentCode: z.string().nullable(),
  /** Sent so the UI renders from the same matrix the server enforces, rather than its own copy. */
  capabilities: z.array(z.string()),
});

export const LoginResponse = z.object({
  token: z.string(),
  expiresInSeconds: z.number().int().positive(),
  user: SessionUser,
});

export function registerAuthRoutes(app: App, deps: { db: Db }): void {
  const { db } = deps;

  app.post(
    '/api/v1/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Exchange a badge number and password for a bearer token',
        body: LoginRequest,
        response: { 200: LoginResponse, 401: ErrorResponse },
        // Explicitly unauthenticated: this is the one route that cannot require a token.
        security: [],
      },
    },
    async (request, reply) => {
      const { badgeNo, password } = request.body;

      const rows = await db
        .select({
          id: users.id,
          name: users.name,
          badgeNo: users.badgeNo,
          role: users.role,
          departmentId: users.departmentId,
          departmentCode: departments.code,
          passwordOk: sql<boolean>`${users.passwordHash} = crypt(${password}, ${users.passwordHash})`,
        })
        .from(users)
        .leftJoin(departments, eq(users.departmentId, departments.id))
        // `active` is in the query, not checked afterwards: a deactivated officer must be
        // indistinguishable from a wrong badge, or the response becomes an account oracle.
        .where(and(eq(users.badgeNo, badgeNo), eq(users.active, true)))
        .limit(1);

      const user = rows[0];

      // One message and one status for "no such badge", "deactivated" and "wrong password".
      // Telling an attacker which of the three it was hands them a list of valid badge numbers.
      if (user === undefined || user.passwordOk !== true) {
        return reply
          .code(401)
          .send({ error: 'unauthorized', message: 'badge number or password is incorrect' });
      }

      const token = app.jwt.sign(
        {
          sub: user.id,
          badgeNo: user.badgeNo,
          role: user.role,
          departmentId: user.departmentId,
        },
        { expiresIn: TOKEN_TTL_SECONDS },
      );

      return {
        token,
        expiresInSeconds: TOKEN_TTL_SECONDS,
        user: {
          id: user.id,
          name: user.name,
          badgeNo: user.badgeNo,
          role: user.role,
          departmentId: user.departmentId,
          departmentCode: user.departmentCode,
          capabilities: [...ROLE_CAPABILITIES[user.role]],
        },
      };
    },
  );

  app.get(
    '/api/v1/auth/me',
    {
      onRequest: [authenticate(db)],
      schema: {
        tags: ['auth'],
        summary: 'The signed-in user behind the presented token',
        response: { 200: SessionUser, 401: ErrorResponse },
      },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        return reply.code(401).send({ error: 'unauthorized', message: 'not authenticated' });
      }

      const rows = await db
        .select({
          id: users.id,
          name: users.name,
          badgeNo: users.badgeNo,
          role: users.role,
          departmentId: users.departmentId,
          departmentCode: departments.code,
        })
        .from(users)
        .leftJoin(departments, eq(users.departmentId, departments.id))
        .where(and(eq(users.id, principal.sub), eq(users.active, true)))
        .limit(1);

      const user = rows[0];
      if (user === undefined) {
        // `authenticate` already rejects an inactive subject; this covers the race where an account
        // is deactivated between the hook and the handler.
        return reply
          .code(401)
          .send({ error: 'unauthorized', message: 'token subject is not an active user' });
      }

      return { ...user, capabilities: [...ROLE_CAPABILITIES[user.role]] };
    },
  );
}
