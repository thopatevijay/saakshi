/**
 * Minting a browser-usable URL for a stored evidence crop (D2-08).
 *
 * `sightings.crop_uri` and `plate_reads.crop_uri` hold `s3://<bucket>/<key>`, never a signed URL —
 * D2-02's reason is that a signed URL is a credential with an expiry, so persisting one puts a
 * value in the database that stops working, and makes an export bundle carry a link that is dead by
 * the time anyone opens it. The URL is minted on read, which is here.
 *
 * **Why this is its own module rather than a few lines inside `routes/trace.ts`.** `packages/web`
 * typechecks the API sources it reaches through `scripts/generate-api-types.mts`, and it does so
 * with `lib: ["DOM"]`, under which `Buffer` is not a `BodyInit`. Anything the route graph imports
 * is therefore compiled twice, against two different sets of ambient types. `EvidenceStore` uploads
 * `Buffer`s and only ever runs in Node; pulling it into the route graph made a latent typing
 * mismatch in `evidence.ts` into a build failure for the *web* package, which is a strange and
 * unhelpful place for it to surface.
 *
 * So the object store is constructed at the composition root (`index.ts`) and injected, which is
 * where an environment-reading, credential-holding client belongs anyway. `buildServer` without one
 * yields `cropUrl: null` on every sighting — the honest answer on a machine with no MinIO, and the
 * reason the evidence strip has a "no crop stored" state at all.
 */
import { evidenceStoreFromEnv } from './evidence.js';
import type { CropPresigner } from './trace.js';

/** Fifteen minutes: long enough to review a trace, short enough that a shared screenshot rots. */
export const CROP_URL_TTL_SECONDS = 900;

export function presignerFromEnv(env: NodeJS.ProcessEnv = process.env): CropPresigner {
  const store = evidenceStoreFromEnv(env);
  if (store === null) return () => null;
  const prefix = `s3://${store.bucket}/`;
  return (cropUri: string): string | null => {
    // A crop stored against a *different* bucket cannot be signed with these credentials, and
    // guessing would produce a URL that 403s. `null` renders as "no crop", which is true.
    if (!cropUri.startsWith(prefix)) return null;
    return store.presignGet(cropUri.slice(prefix.length), CROP_URL_TTL_SECONDS);
  };
}
