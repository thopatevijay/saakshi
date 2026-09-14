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
import { evidenceStoreFromEnv, type EvidenceStore } from './evidence.js';
import type { CropPresigner } from './trace.js';

/** Fifteen minutes: long enough to review a trace, short enough that a shared screenshot rots. */
export const CROP_URL_TTL_SECONDS = 900;

/**
 * Where the browser asks for a crop. Same-origin on the web app, which proxies it to the API with
 * the session cookie the way the video wall and the alert stream already do.
 */
export const CROP_VIEW_BASE_PATH = '/evidence/crop';

/**
 * The one guard, for every consumer of a stored `crop_uri` (D2-11).
 *
 * It exists as a shared function rather than four lines each in `routes/trace.ts` and
 * `services/alerts.ts` because it already *was* four lines each, and only one of the two copies had
 * the guard. D2-GATE (#23) found the other: the alert path ran
 * `cropUri.replace(/^s3:\/\/[^/]+\//, '')` and, handed the `file:///…/100-plate.jpg` that D2-01
 * writes, matched nothing, signed the whole URI as an object key and emitted a link that returned
 * **HTTP 400**. The trace path, on the identical input, returned `null`.
 *
 * `null` is a first-class, correct answer — D2-07 renders it as "no crop stored" and D2-02's
 * four-way `cropState` handles it. A signed URL that 4xxs is worse than no link at all, because it
 * looks real. That asymmetry is the whole reason this function refuses rather than guesses.
 *
 * `store === null` (no MinIO configured) yields `null` for every URI: the pipeline still runs, and
 * the crop renders as "no crop stored", which is true.
 */
export function presignerFor(
  store: EvidenceStore | null,
  ttlSeconds: number = CROP_URL_TTL_SECONDS,
): CropPresigner {
  if (store === null) return () => null;
  const prefix = `s3://${store.bucket}/`;
  return (cropUri: string): string | null => {
    // A crop stored against a *different* bucket — or under a scheme this store cannot serve at
    // all, like `file://` — cannot be signed with these credentials, and guessing would produce a
    // URL that 403s. `null` renders as "no crop", which is true.
    if (!cropUri.startsWith(prefix)) return null;
    return store.presignGet(cropUri.slice(prefix.length), ttlSeconds);
  };
}

/**
 * The path a *browser* should use to fetch a crop (D4-09).
 *
 * ## Why this is not `presignerFor`
 *
 * A presigned URL is signed against `MINIO_ENDPOINT`, and SigV4 binds the `Host` header, so the
 * host that signs and the host the browser resolves must be the same string. On the deployment the
 * object store lives on the private network (`minio.railway.internal`), which a judge's browser
 * cannot resolve — so every crop rendered as an `<img src>` was a broken image (BL-01 finding 18).
 *
 * Publishing the object store would fix the symptom and lose the argument: this project's pitch is
 * purpose-bound access to evidence, and a 900 s presigned URL is a bearer credential that works for
 * anyone who has it, whether or not they may see that crop. So the bytes go through the API
 * instead, behind the session, and the store stays private.
 *
 * ## Why `presignerFor` still exists and must keep existing
 *
 * Export bundles embed crops as **bytes**, fetched at build time — `export-bundle.ts` calls
 * `fetch()` on whatever this returns. A relative path is not fetchable from Node, and the bundle
 * builder records a fetch failure as an *omission* rather than throwing, so handing it a proxy path
 * would quietly empty every bundle. Audit and `export-bundle-cli` therefore keep the real
 * presigner; only the browser-facing routes get this.
 *
 * The bucket-prefix guard is D2-11's and is preserved exactly: a `file://` URI, or one belonging to
 * another bucket, yields `null` — "no crop stored", which is true — rather than a link that 4xxs.
 */
export function cropViewUrlFor(store: EvidenceStore | null, basePath = CROP_VIEW_BASE_PATH) {
  if (store === null) return () => null;
  const prefix = `s3://${store.bucket}/`;
  return (cropUri: string): string | null => {
    if (!cropUri.startsWith(prefix)) return null;
    return `${basePath}?uri=${encodeURIComponent(cropUri)}`;
  };
}

export function cropViewUrlFromEnv(env: NodeJS.ProcessEnv = process.env): CropPresigner {
  return cropViewUrlFor(evidenceStoreFromEnv(env));
}

export function presignerFromEnv(env: NodeJS.ProcessEnv = process.env): CropPresigner {
  return presignerFor(evidenceStoreFromEnv(env));
}
