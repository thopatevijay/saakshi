import { z } from 'zod';
import type { App } from '../server.js';
import { authenticate, requireRole, userRoles } from '../auth.js';
import { can } from '@saakshi/shared';
import type { Db } from '../db/client.js';
import type { EvidenceStore } from '../services/evidence.js';

/**
 * `GET /api/v1/evidence/crop` — the bytes of one stored evidence crop (D4-09).
 *
 * ## Why the server reads the object instead of the browser
 *
 * Until this route existed, a crop reached the browser as a presigned URL. SigV4 binds the `Host`
 * header, so such a URL only works when the host that signed it is the host the browser resolves —
 * and on the deployment the object store is on the private network (`minio.railway.internal`).
 * Every crop was therefore a broken image for anyone outside that network, which is to say for
 * every judge (BL-01 finding 18).
 *
 * The alternative was to publish the object store. That fixes the image and loses the argument:
 * a presigned URL is a bearer credential, valid for its whole TTL for whoever holds it, regardless
 * of whether that person may see that particular crop. This project's claim is purpose-bound access
 * to evidence, so the bytes come through here, behind the same session as everything else, and the
 * store stays unreachable from the internet.
 *
 * ## Why the roles are a union
 *
 * A crop is rendered in two places — the alert queue and a vehicle trace — and this route must not
 * be either narrower or wider than the responses that hand out the URL. Anyone who can already
 * receive a `cropUrl` in a payload can fetch what it points at; nobody else can.
 *
 * ## Why a bad URI is 404 and not 403
 *
 * The guard is D2-11's: a URI outside this bucket cannot be served with these credentials, and
 * saying *which* of "not yours" or "not there" applies would let a caller map the estate's storage
 * by probing. Both answer "not found".
 */
export const EVIDENCE_VIEW_ROLES = userRoles.filter(
  (role) => can(role, 'alerts:view') || can(role, 'trace:run'),
);

export const CropQuery = z.object({
  /** The stable `s3://<bucket>/<key>` identifier, exactly as it is stored in `crop_uri`. */
  uri: z.string().min(1).max(1024),
});

/**
 * Resolve a stored URI to an object key, or `null` if this store cannot serve it.
 *
 * Exported because it is the whole security boundary of this route and deserves its own tests.
 * A key containing a `..` segment is refused: object keys are opaque strings to S3, but this one is
 * interpolated into a request path, and a traversal segment there could address a different
 * bucket's objects with our credentials.
 */
export function keyForCropUri(uri: string, bucket: string): string | null {
  const prefix = `s3://${bucket}/`;
  if (!uri.startsWith(prefix)) return null;
  const key = uri.slice(prefix.length);
  if (key === '') return null;
  if (key.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  return key;
}

export function registerEvidenceRoutes(
  app: App,
  options: { db: Db; store?: EvidenceStore | null },
): void {
  const { db } = options;
  const store = options.store ?? null;

  app.get(
    '/api/v1/evidence/crop',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(EVIDENCE_VIEW_ROLES)],
      schema: {
        tags: ['evidence'],
        summary: 'Stream one stored evidence crop',
        description:
          'The bytes of a crop identified by its stable `s3://` URI. Served by the API rather ' +
          'than by a presigned URL so that the object store needs no public network surface and ' +
          'so that every read passes the session and role check — see D4-09.',
        querystring: CropQuery,
      },
    },
    async (request, reply): Promise<void> => {
      if (store === null) {
        // No object store configured. The same honest answer `presignerFor` gives: the pipeline
        // runs, the crop simply is not available, and the UI already renders that state.
        reply
          .code(503)
          .send({ error: 'evidence_store_unconfigured', message: 'no object store is configured' });
        return;
      }

      const { uri } = request.query;
      const key = keyForCropUri(uri, store.bucket);
      if (key === null) {
        reply.code(404).send({ error: 'not_found', message: 'no such crop' });
        return;
      }

      const object = await store.getObject(key);
      if (object === null) {
        reply.code(404).send({ error: 'not_found', message: 'no such crop' });
        return;
      }

      // `private` because this is evidence behind a session: a shared cache holding it would serve
      // one officer's crop to the next request that asked for the same key. The TTL matches the
      // presigned URL's old 900 s, so a queue left open through a shift behaves as it did before.
      reply.header('content-type', object.contentType).header('cache-control', 'private, max-age=900');
      if (object.contentLength !== null) reply.header('content-length', object.contentLength);
      if (object.etag !== null) reply.header('etag', object.etag);
      return reply.send(Buffer.from(object.bytes));
    },
  );
}
