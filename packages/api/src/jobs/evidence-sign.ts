/**
 * `npm run evidence:sign -- <object-key> [expires-seconds]`
 *
 * Mints one pre-signed GET URL and prints it. Nothing more.
 *
 * It exists because "signed URLs work and expire" is an acceptance criterion, and an acceptance
 * criterion needs something a human — or a gate script, or a judge at a demo — can actually run.
 * With no key it lists the first object under `evidence/` and signs that, so the check works on a
 * fresh bucket without anyone having to go and find a uuid first.
 *
 * The URL is signed for **GET**. The HTTP method is part of the SigV4 canonical request, so
 * `curl -I` (a HEAD) against it is correctly refused with 403 — verified against the aws-cli's own
 * presigner too, so it is S3 semantics rather than anything about this implementation. Fetch it
 * with `curl -fsS -o /dev/null -w '%{http_code}'`.
 */
import 'dotenv/config';
import { evidenceStoreFromEnv } from '../services/evidence.js';

const store = evidenceStoreFromEnv();
if (store === null) {
  console.error('MINIO_ACCESS_KEY / MINIO_SECRET_KEY are not set.');
  process.exit(2);
}

// Empty strings are dropped, not just flags. `npm run … -- '' 300` otherwise signs the bucket root,
// which returns a *listing* to the signed caller and looks exactly like a successful object fetch.
const args = process.argv.slice(2).filter((a) => a !== '' && !a.startsWith('-'));
const expires = Number(args[1] ?? 900);

let key = args[0];
if (key === undefined) {
  const objects = await store.listObjects();
  if (objects.length === 0) {
    console.error('the evidence bucket is empty — nothing to sign');
    process.exit(1);
  }
  key = objects[0]!.key;
}

console.log(store.presignGet(key, expires));
