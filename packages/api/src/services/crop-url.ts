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

export function presignerFromEnv(env: NodeJS.ProcessEnv = process.env): CropPresigner {
  return presignerFor(evidenceStoreFromEnv(env));
}
