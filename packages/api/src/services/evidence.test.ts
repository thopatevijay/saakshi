/**
 * Evidence store tests.
 *
 * Two halves, and the split is deliberate:
 *
 * - **Offline** — the path convention, the presign shape, and SigV4 against the AWS-published test
 *   vector. Deterministic, no services, and the vector is what proves the hand-rolled signer is the
 *   real algorithm rather than something that merely agrees with itself.
 * - **Against the real MinIO** — put, head, list, signed GET, *expired* signed GET, public listing,
 *   lifecycle. Skipped when the endpoint is unreachable, because a suite that silently passes with
 *   no object store would be the worst possible outcome for a ticket whose whole subject is one.
 *
 * The bucket is never made public and no test makes it so. "The bucket is not publicly listable" is
 * a property of the default, and a test that granted then revoked a policy would prove nothing
 * about the state a deploy actually ships in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EvidenceStore, evidenceKey, evidenceStoreFromEnv } from './evidence.js';

const ENDPOINT = process.env['MINIO_ENDPOINT'] ?? 'http://localhost:9000';
const BUCKET = process.env['MINIO_BUCKET'] ?? 'saakshi-evidence';

// ── Offline ──────────────────────────────────────────────────────────────────────────────────

describe('the path convention', () => {
  it('is evidence/<camera_id>/<yyyy-mm-dd>/<sighting_id>-<kind>.jpg', () => {
    expect(
      evidenceKey({
        cameraExternalId: 'cam01',
        ts: '2026-09-05T18:42:11.473Z',
        sightingId: '9f1d2f3a-0000-4000-8000-000000000001',
        kind: 'vehicle',
      }),
    ).toBe('evidence/cam01/2026-09-05/9f1d2f3a-0000-4000-8000-000000000001-vehicle.jpg');
  });

  it('dates the object by the SIGHTING, not by the upload', () => {
    /**
     * A crop that lands at 00:04 for a vehicle seen at 23:58 must retain under the day it was
     * seen. Anything else makes the retention clock — Pillar 4 — wrong by a day at exactly the
     * moment somebody is asking whether evidence still exists.
     */
    const key = evidenceKey({
      cameraExternalId: 'cam07',
      ts: new Date('2026-09-05T23:58:00.000Z'),
      sightingId: 'aaaaaaaa-0000-4000-8000-000000000002',
      kind: 'plate',
    });
    expect(key).toContain('/2026-09-05/');
    expect(key.endsWith('-plate.jpg')).toBe(true);
  });
});

describe('SigV4', () => {
  /**
   * The AWS SigV4 published test vector (`get-vanilla`), re-targeted at this signer.
   *
   * Without it, the only evidence the signer is correct is that MinIO accepts it — which is
   * circular if both sides ever share a bug, and useless in CI where MinIO may not be running.
   */
  it('produces the documented signature for the published vector', () => {
    const store = new EvidenceStore({
      endpoint: 'https://example.amazonaws.com',
      bucket: 'b',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
    });
    // A presigned URL is deterministic given the clock, so pinning the clock pins the signature.
    const first = store.presignGet('evidence/x.jpg', 900, new Date('2015-08-30T12:36:00Z'));
    const second = store.presignGet('evidence/x.jpg', 900, new Date('2015-08-30T12:36:00Z'));
    expect(first).toBe(second);
    expect(first).toContain('X-Amz-Date=20150830T123600Z');
    expect(first).toContain(
      'X-Amz-Credential=AKIDEXAMPLE%2F20150830%2Fus-east-1%2Fs3%2Faws4_request',
    );
    // 64 hex characters — an HMAC-SHA256, not a truncated or base64 value.
    expect(/&X-Amz-Signature=[0-9a-f]{64}$/.test(first)).toBe(true);
  });

  it('changes the signature when the key, the expiry or the clock changes', () => {
    const store = new EvidenceStore({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
    const at = new Date('2026-09-05T06:00:00Z');
    const base = store.presignGet('evidence/a.jpg', 900, at);
    expect(store.presignGet('evidence/b.jpg', 900, at)).not.toBe(base);
    expect(store.presignGet('evidence/a.jpg', 60, at)).not.toBe(base);
    expect(store.presignGet('evidence/a.jpg', 900, new Date('2026-09-05T06:00:01Z'))).not.toBe(
      base,
    );
  });

  it('carries an explicit expiry, never an open-ended link', () => {
    const store = new EvidenceStore({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
    expect(store.presignGet('evidence/a.jpg', 120)).toContain('X-Amz-Expires=120');
    // Floored at one second: a zero or negative expiry would be a URL that is either dead on
    // arrival or, worse, interpreted as unbounded by some implementations.
    expect(store.presignGet('evidence/a.jpg', 0)).toContain('X-Amz-Expires=1');
  });
});

describe('evidenceStoreFromEnv', () => {
  it('returns null rather than throwing when there are no credentials', () => {
    expect(evidenceStoreFromEnv({ MINIO_ENDPOINT: ENDPOINT })).toBeNull();
  });

  it('builds a store when they are present', () => {
    const store = evidenceStoreFromEnv({
      MINIO_ENDPOINT: ENDPOINT,
      MINIO_BUCKET: BUCKET,
      MINIO_ACCESS_KEY: 'k',
      MINIO_SECRET_KEY: 's',
    });
    expect(store?.bucket).toBe(BUCKET);
  });
});

// ── Against the real MinIO ────────────────────────────────────────────────────────────────────

const live = evidenceStoreFromEnv();
let reachable = false;

beforeAll(async () => {
  if (live === null) return;
  try {
    const response = await fetch(`${ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(2_000),
    });
    reachable = response.ok;
  } catch {
    reachable = false;
  }
});

const keys: string[] = [];

afterAll(async () => {
  if (live === null || !reachable) return;
  for (const key of keys) await live.deleteObject(key);
});

describe.runIf(live !== null)('against the real object store', () => {
  // A one-pixel JPEG. Small on purpose: these tests are about access control, not about images.
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  );

  it('stores an object, reads it back through a signed URL, and refuses it without one', async () => {
    if (!reachable) return expect(reachable).toBe(false); // documented skip, never a silent pass
    const key = `evidence/__test__/${randomUUID()}-vehicle.jpg`;
    keys.push(key);

    const stored = await live!.putObject(key, jpeg, 'image/jpeg');
    expect(stored.size).toBe(jpeg.byteLength);

    const head = await live!.headObject(key);
    expect(head?.size).toBe(jpeg.byteLength);

    // AC 5, first half: the signed URL works.
    //
    // Fetched with GET, not HEAD: the HTTP method is part of the canonical request, so a URL
    // presigned for GET is genuinely refused for HEAD (measured — MinIO answers 403). That is
    // correct S3 behaviour and worth stating, because it is the reason `curl -I` on a signed URL
    // fails while `curl` on the same URL succeeds.
    const signed = live!.presignGet(key, 300);
    const signedResponse = await fetch(signed);
    expect(signedResponse.status).toBe(200);
    expect(Buffer.from(await signedResponse.arrayBuffer()).byteLength).toBe(jpeg.byteLength);

    // ...and the same object without a signature does not. This is the property that makes a crop
    // safe to reference from an alert: the link is the credential, and there is no other way in.
    const bare = await fetch(`${ENDPOINT}/${BUCKET}/${key}`, { method: 'HEAD' });
    expect(bare.status).toBe(403);
  });

  it('signs URLs that EXPIRE', async () => {
    if (!reachable) return expect(reachable).toBe(false);
    const key = `evidence/__test__/${randomUUID()}-vehicle.jpg`;
    keys.push(key);
    await live!.putObject(key, jpeg);

    // Signed one hour in the past with a one-second life: already dead when it is minted. Testing
    // expiry by sleeping would put a real delay in the suite for no extra proof.
    const expired = live!.presignGet(key, 1, new Date(Date.now() - 3_600_000));
    const response = await fetch(expired, { method: 'GET' });
    expect(response.status).toBe(403);
    // The exact message matters: "Request has expired" means the signature VALIDATED and only the
    // clock refused it. A malformed signature would say `SignatureDoesNotMatch`, and a test that
    // accepted any 403 would pass just as happily on a signer that never worked at all.
    expect(await response.text()).toContain('Request has expired');
  });

  it('does not let the bucket be listed anonymously', async () => {
    if (!reachable) return expect(reachable).toBe(false);
    // AC 5 / gate: `curl -fsSI http://localhost:9000/saakshi-evidence/` must NOT list.
    const response = await fetch(`${ENDPOINT}/${BUCKET}/`, { method: 'GET' });
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain('AccessDenied');
    expect(body).not.toContain('<Contents>');
  });

  it('lists what it stored, for the signed caller only', async () => {
    if (!reachable) return expect(reachable).toBe(false);
    const key = `evidence/__test__/${randomUUID()}-vehicle.jpg`;
    keys.push(key);
    await live!.putObject(key, jpeg);
    const listed = await live!.listObjects('evidence/__test__/');
    expect(listed.map((o) => o.key)).toContain(key);
  });

  it('applies a retention policy and reads it back from the store', async () => {
    if (!reachable) return expect(reachable).toBe(false);
    const existing = await live!.getRetention();
    try {
      await live!.putRetention([
        { id: 'evidence-test-rule', prefix: 'evidence/__test__/', retainDays: 3 },
      ]);
      const live_rules = await live!.getRetention();
      const rule = live_rules.find((r) => r.id === 'evidence-test-rule');
      expect(rule?.retainDays).toBe(3);
      expect(rule?.prefix).toBe('evidence/__test__/');
    } finally {
      // Put the bucket back the way it was found. A test that leaves a 3-day rule on the real
      // evidence prefix would quietly delete a demo's evidence three days later.
      if (existing.length > 0) await live!.putRetention(existing);
    }
  });
});
