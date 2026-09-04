/**
 * The typed API client.
 *
 * Every request the web app makes goes through here, and every request/response shape comes from
 * `schema.d.ts`, which is **generated** from the API's own OpenAPI document (`npm run generate:api`).
 * Nothing in this package hand-writes a fetch or hand-types a payload: a second description of the
 * same contract drifts the moment a route changes, and it drifts silently because both still
 * compile.
 *
 * The token never reaches browser JavaScript. It lives in an httpOnly cookie; server components and
 * route handlers read it and attach it here.
 */
import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './schema';

export const API_BASE_URL = process.env['API_BASE_URL'] ?? 'http://localhost:4000';

export type ApiPaths = paths;

/** A client bound to one caller's bearer token, for use in server components and actions. */
export function apiClient(token?: string) {
  const client = createClient<paths>({ baseUrl: API_BASE_URL });

  if (token !== undefined && token !== '') {
    const authorise: Middleware = {
      onRequest({ request }) {
        request.headers.set('authorization', `Bearer ${token}`);
        return request;
      },
    };
    client.use(authorise);
  }

  return client;
}

/** An unauthenticated client. Only the login route accepts one. */
export const publicApi = () => apiClient();

export type LoginResponse =
  paths['/api/v1/auth/login']['post']['responses'][200]['content']['application/json'];
export type SessionUser =
  paths['/api/v1/auth/me']['get']['responses'][200]['content']['application/json'];
export type CameraListResponse =
  paths['/api/v1/cameras']['get']['responses'][200]['content']['application/json'];
export type TrustSummary =
  paths['/api/v1/trust/summary']['get']['responses'][200]['content']['application/json'];
