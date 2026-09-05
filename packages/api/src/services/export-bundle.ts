/**
 * Export bundles: evidence packaged so that its integrity can be checked by someone who has only
 * the package (D3-04).
 *
 * ## What a bundle is
 *
 * A directory, not an archive, and deliberately so — a judge, a defence lawyer or a forensic
 * examiner can open the files with anything, and the verifier that ships inside it needs nothing
 * beyond a Node runtime and `node:crypto`.
 *
 * ```
 * exports/<case>-<plate>-<stamp>/
 *   manifest.json      every item, its byte length and its SHA-256, in canonical JSON
 *   manifest.sha256    the SHA-256 of manifest.json's own bytes — the manifest hash
 *   verify.mjs         `node verify.mjs` — zero dependencies, re-checks every hash
 *   README.txt         what this proves, and what it does not
 *   trace.json         the full trace response as the API returned it
 *   trace.csv          the same rows, for a spreadsheet
 *   evidence/*.jpg     the crops themselves, as bytes
 * ```
 *
 * ## Two rules that are easy to get wrong, and were got wrong before
 *
 * **A signed URL is never written into a bundle.** D2-02 and D2-11 both say it: a presigned URL is a
 * credential with an expiry, so a bundle carrying one ships a link that is dead before anyone opens
 * it, and it looks real while being useless. Crops are embedded as **bytes**, fetched once at build
 * time through a URL that is minted, used and discarded inside this function.
 *
 * **`crop_uri` may be `null`, and the bundle says so.** A missing crop is recorded in the manifest
 * as an absence with a reason, never omitted and never faked. `presignerFor` refuses to sign a URI
 * it cannot serve and returns `null`; that refusal is carried through to the manifest rather than
 * being smoothed over, because a bundle that silently drops the sightings it had no crop for
 * misrepresents the evidence that existed.
 *
 * ## What the manifest hash proves
 *
 * `manifest.sha256` is the SHA-256 of `manifest.json`'s bytes. `manifest.json` is written in
 * canonical JSON, so it is reproducible; but the verifier does not need to reproduce it, it only
 * needs to hash the file — which is why the bundle's own verifier carries no JSON canonicaliser and
 * cannot disagree with ours.
 *
 * Verification proves the bundle is **unaltered since it was built**. It does not prove the contents
 * are true, and it does not prove who built it beyond what the manifest records. The chain entry
 * whose hash the manifest carries is what ties the bundle to an accountable officer, a stated
 * purpose and a case reference.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJsonPretty } from '@saakshi/shared';
import type { DbLike } from '../db/client.js';
import type { Principal } from '../auth.js';
import { chainTip, writeAudit } from './audit.js';
import { CHAIN_ALGORITHM } from './audit.js';
import type { TraceResult, TraceSighting } from './trace.js';
import { traceCsv } from './trace-export.js';
import { exportBundles } from '@saakshi/shared/db';

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_HASH_FILE = 'manifest.sha256';

/**
 * Fifteen minutes is the browser's TTL. A bundle build fetches immediately and keeps the bytes, so
 * the URL only has to outlive one request — but a slow store on a cold cache is a real thing, and
 * this URL never leaves this process.
 */
const BUILD_PRESIGN_TTL_SECONDS = 300;

export const BUNDLE_CLAIM =
  'Verification proves this bundle is byte-for-byte unaltered since it was built. It does not ' +
  'prove the contents are true. Sightings are observed detections; that they are the same vehicle ' +
  'is an inferred link with a stated confidence, and the path between them is inferred entirely.';

export const BUNDLE_DISCLAIMER =
  'MOCK PROVIDERS — SAAKSHI has no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity, and ' +
  'performs no face recognition or other biometric processing. Nothing in this bundle is an ' +
  'identification of a person, and no external registry was consulted to produce it.';

/** Why a sighting contributed no crop. Recorded, never silently dropped. */
export type MissingCropReason =
  /** The sighting has no `crop_uri` at all — most sightings do not; only best shots are stored. */
  | 'no_crop_stored'
  /** A `crop_uri` exists but no object store is configured on this deployment. */
  | 'object_store_unconfigured'
  /** A `crop_uri` exists that this store cannot serve — a different bucket, or a `file://` path. */
  | 'uri_not_servable'
  /** The object store was asked for it and did not return it. */
  | 'fetch_failed';

export interface BundleItem {
  path: string;
  bytes: number;
  sha256: string;
  kind: 'report' | 'evidence';
  /** For an evidence item, the sighting it belongs to and the URI it came from. */
  sightingId?: string;
  cropUri?: string;
}

export interface BundleOmission {
  sightingId: string;
  seq: number;
  cameraExternalId: string;
  ts: string;
  cropUri: string | null;
  reason: MissingCropReason;
}

export interface BundleManifest {
  manifestVersion: number;
  bundleId: string;
  createdAt: string;
  createdBy: { actorId: string | null; badgeNo: string | null; role: string | null };
  purpose: string;
  caseRef: string;
  subject: { kind: 'vehicle_trace'; query: string; normalized: string };
  window: { from: string | null; to: string | null };
  counts: {
    sightings: number;
    cameras: number;
    cropsIncluded: number;
    cropsUnavailable: number;
  };
  /** The audit entry that recorded this export, and the chain tip at the moment it was written. */
  chain: { algorithm: string; auditEntryHash: string; tipHash: string | null };
  claim: string;
  disclaimer: string;
  items: BundleItem[];
  omissions: BundleOmission[];
}

export interface BuildBundleOptions {
  db: DbLike;
  principal?: Principal | undefined;
  trace: TraceResult;
  purpose: string;
  caseRef: string;
  outDir: string;
  /** Mints a short-lived GET URL for an `s3://` crop, or `null` when it cannot serve that URI. */
  presign?: ((cropUri: string) => string | null) | undefined;
  now?: Date;
}

export interface BuiltBundle {
  bundleId: string;
  dir: string;
  manifest: BundleManifest;
  manifestHash: string;
  bytes: number;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Safe on every filesystem, and still readable — a case number is full of slashes. */
export function slug(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
  return cleaned === '' ? 'UNSPECIFIED' : cleaned.slice(0, 48);
}

async function fetchCrop(
  url: string,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: MissingCropReason }> {
  try {
    // GET, never HEAD: the presigned URL is signed for GET, and a HEAD of it answers 403 against a
    // store that is working perfectly (D2-02). Checking existence with HEAD first would report every
    // crop as missing.
    const response = await fetch(url);
    if (!response.ok) return { ok: false, reason: 'fetch_failed' };
    return { ok: true, bytes: Buffer.from(await response.arrayBuffer()) };
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }
}

function cropFileName(sighting: TraceSighting, cropUri: string): string {
  const kind = cropUri.endsWith('-plate.jpg') ? 'plate' : 'vehicle';
  return `evidence/${String(sighting.seq).padStart(4, '0')}-${sighting.sightingId}-${kind}.jpg`;
}

/**
 * Builds the bundle on disk and records it, in the audit chain and in `export_bundles`.
 *
 * The audit entry is written **before** the manifest, so the manifest can name it: a bundle that
 * cannot point at the chain entry authorising it is a bundle whose provenance stops at its own
 * front cover.
 */
export async function buildExportBundle(options: BuildBundleOptions): Promise<BuiltBundle> {
  const now = options.now ?? new Date();
  const trace = options.trace;
  const subject = trace.normalized === '' ? trace.query : trace.normalized;

  const audit = await writeAudit(options.db, options.principal, {
    action: 'export.bundle',
    targetType: 'export_bundle',
    targetId: subject,
    purpose: options.purpose,
    caseRef: options.caseRef,
    params: {
      plate: trace.query,
      normalized: trace.normalized,
      from: trace.window.from,
      to: trace.window.to,
      sightings: trace.sightings.length,
      cameras: trace.cameras.length,
    },
    resultCount: trace.sightings.length,
  });
  const tip = await chainTip(options.db);

  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bundleId = `${slug(options.caseRef)}-${slug(subject)}-${stamp}`;
  const dir = path.resolve(options.outDir, bundleId);
  await mkdir(path.join(dir, 'evidence'), { recursive: true });

  const items: BundleItem[] = [];
  const omissions: BundleOmission[] = [];

  const addFile = async (relative: string, bytes: Buffer, kind: BundleItem['kind'], extra?: Partial<BundleItem>) => {
    await writeFile(path.join(dir, relative), bytes);
    items.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes), kind, ...extra });
  };

  // The trace exactly as the API returned it, canonicalised so the file is reproducible.
  await addFile('trace.json', Buffer.from(canonicalJsonPretty(trace), 'utf8'), 'report');
  await addFile('trace.csv', Buffer.from(traceCsv(trace), 'utf8'), 'report');

  for (const sighting of trace.sightings) {
    if (sighting.cropUri === null) {
      omissions.push({
        sightingId: sighting.sightingId,
        seq: sighting.seq,
        cameraExternalId: sighting.cameraExternalId,
        ts: sighting.ts,
        cropUri: null,
        reason: 'no_crop_stored',
      });
      continue;
    }
    if (options.presign === undefined) {
      omissions.push({ ...omissionOf(sighting), reason: 'object_store_unconfigured' });
      continue;
    }
    const url = options.presign(sighting.cropUri);
    if (url === null) {
      omissions.push({ ...omissionOf(sighting), reason: 'uri_not_servable' });
      continue;
    }
    const fetched = await fetchCrop(url);
    if (!fetched.ok) {
      omissions.push({ ...omissionOf(sighting), reason: fetched.reason });
      continue;
    }
    await addFile(cropFileName(sighting, sighting.cropUri), fetched.bytes, 'evidence', {
      sightingId: sighting.sightingId,
      cropUri: sighting.cropUri,
    });
  }

  const manifest: BundleManifest = {
    manifestVersion: MANIFEST_VERSION,
    bundleId,
    createdAt: now.toISOString(),
    createdBy: {
      actorId: options.principal?.sub ?? null,
      badgeNo: options.principal?.badgeNo ?? null,
      role: options.principal?.role ?? null,
    },
    purpose: options.purpose,
    caseRef: options.caseRef,
    subject: { kind: 'vehicle_trace', query: trace.query, normalized: trace.normalized },
    window: trace.window,
    counts: {
      sightings: trace.sightings.length,
      cameras: trace.cameras.length,
      cropsIncluded: items.filter((i) => i.kind === 'evidence').length,
      cropsUnavailable: omissions.length,
    },
    chain: { algorithm: CHAIN_ALGORITHM, auditEntryHash: audit.hash, tipHash: tip?.hash ?? null },
    claim: BUNDLE_CLAIM,
    disclaimer: BUNDLE_DISCLAIMER,
    // Sorted, so two builds of the same evidence produce the same manifest.
    items: [...items].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    omissions: [...omissions].sort((a, b) => a.seq - b.seq),
  };

  const manifestBytes = Buffer.from(canonicalJsonPretty(manifest), 'utf8');
  const manifestHash = sha256(manifestBytes);
  await writeFile(path.join(dir, MANIFEST_FILE), manifestBytes);
  await writeFile(path.join(dir, MANIFEST_HASH_FILE), `${manifestHash}\n`, 'utf8');
  await writeFile(path.join(dir, 'verify.mjs'), VERIFIER_SOURCE, 'utf8');
  await writeFile(path.join(dir, 'README.txt'), readmeFor(manifest, manifestHash), 'utf8');

  await options.db.insert(exportBundles).values({
    createdBy: options.principal?.sub ?? null,
    createdAt: now.toISOString(),
    items: manifest.items,
    manifest,
    manifestHash,
  });

  const bytes = manifest.items.reduce((sum, item) => sum + item.bytes, 0) + manifestBytes.byteLength;
  return { bundleId, dir, manifest, manifestHash, bytes };
}

function omissionOf(sighting: TraceSighting): Omit<BundleOmission, 'reason'> {
  return {
    sightingId: sighting.sightingId,
    seq: sighting.seq,
    cameraExternalId: sighting.cameraExternalId,
    ts: sighting.ts,
    cropUri: sighting.cropUri,
  };
}

// ── Verifying ───────────────────────────────────────────────────────────────────────────────────

export type BundleFailureReason =
  | 'manifest_missing'
  | 'manifest_unreadable'
  | 'manifest_hash_missing'
  | 'manifest_hash_mismatch'
  | 'item_missing'
  | 'item_size_mismatch'
  | 'item_hash_mismatch'
  | 'unlisted_file';

export interface BundleFailure {
  reason: BundleFailureReason;
  path: string;
  expected?: string;
  actual?: string;
  detail: string;
}

export interface BundleVerification {
  ok: boolean;
  dir: string;
  bundleId: string | null;
  manifestHash: string | null;
  itemsChecked: number;
  bytesChecked: number;
  failures: BundleFailure[];
}

/** Every file a bundle carries that the manifest deliberately does not list — it cannot list itself. */
const UNLISTED_BY_DESIGN = new Set([MANIFEST_FILE, MANIFEST_HASH_FILE, 'verify.mjs', 'README.txt']);

async function walk(dir: string, base = ''): Promise<string[]> {
  const entries = await readdir(path.join(dir, base), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(dir, relative)));
    else out.push(relative);
  }
  return out;
}

/**
 * Re-checks a bundle on disk.
 *
 * Every listed item is re-hashed, and every file present is checked against the list — a bundle with
 * an extra file nobody vouched for is as much of a problem as one with a file altered, because a
 * reader has no way to tell which of the two they are looking at.
 */
export async function verifyExportBundle(dir: string): Promise<BundleVerification> {
  const resolved = path.resolve(dir);
  const failures: BundleFailure[] = [];

  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(path.join(resolved, MANIFEST_FILE));
  } catch {
    return {
      ok: false,
      dir: resolved,
      bundleId: null,
      manifestHash: null,
      itemsChecked: 0,
      bytesChecked: 0,
      failures: [
        {
          reason: 'manifest_missing',
          path: MANIFEST_FILE,
          detail: `no ${MANIFEST_FILE} in ${resolved} — this is not a SAAKSHI export bundle`,
        },
      ],
    };
  }

  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as BundleManifest;
  } catch (error) {
    return {
      ok: false,
      dir: resolved,
      bundleId: null,
      manifestHash: null,
      itemsChecked: 0,
      bytesChecked: 0,
      failures: [
        {
          reason: 'manifest_unreadable',
          path: MANIFEST_FILE,
          detail: error instanceof Error ? error.message : 'manifest is not valid JSON',
        },
      ],
    };
  }

  const actualManifestHash = sha256(manifestBytes);
  let declaredManifestHash: string | null = null;
  try {
    declaredManifestHash = (await readFile(path.join(resolved, MANIFEST_HASH_FILE), 'utf8')).trim();
  } catch {
    failures.push({
      reason: 'manifest_hash_missing',
      path: MANIFEST_HASH_FILE,
      detail: 'the bundle carries no manifest hash, so the manifest itself cannot be checked',
    });
  }

  if (declaredManifestHash !== null && declaredManifestHash !== actualManifestHash) {
    failures.push({
      reason: 'manifest_hash_mismatch',
      path: MANIFEST_FILE,
      expected: declaredManifestHash,
      actual: actualManifestHash,
      detail: 'the manifest does not hash to the value recorded beside it — the manifest changed',
    });
  }

  let itemsChecked = 0;
  let bytesChecked = 0;

  for (const item of manifest.items ?? []) {
    const full = path.join(resolved, item.path);
    let size: number;
    try {
      size = (await stat(full)).size;
    } catch {
      failures.push({
        reason: 'item_missing',
        path: item.path,
        detail: 'listed in the manifest but not present in the bundle',
      });
      continue;
    }
    if (size !== item.bytes) {
      failures.push({
        reason: 'item_size_mismatch',
        path: item.path,
        expected: `${item.bytes} bytes`,
        actual: `${size} bytes`,
        detail: 'the file is a different length than when the bundle was built',
      });
      continue;
    }
    const actual = sha256(await readFile(full));
    itemsChecked++;
    bytesChecked += size;
    if (actual !== item.sha256) {
      failures.push({
        reason: 'item_hash_mismatch',
        path: item.path,
        expected: item.sha256,
        actual,
        detail: 'the file is the right length but its contents changed',
      });
    }
  }

  const listed = new Set((manifest.items ?? []).map((item) => item.path));
  for (const present of await walk(resolved)) {
    if (listed.has(present) || UNLISTED_BY_DESIGN.has(present)) continue;
    failures.push({
      reason: 'unlisted_file',
      path: present,
      detail: 'present in the bundle but not listed in the manifest — nobody vouched for it',
    });
  }

  return {
    ok: failures.length === 0,
    dir: resolved,
    bundleId: manifest.bundleId ?? null,
    manifestHash: actualManifestHash,
    itemsChecked,
    bytesChecked,
    failures,
  };
}

// ── What ships inside the bundle ────────────────────────────────────────────────────────────────

/**
 * The standalone verifier, written into every bundle.
 *
 * It hashes `manifest.json`'s bytes rather than re-serialising the manifest, so it needs no JSON
 * canonicaliser and cannot drift from `verifyExportBundle` on a whitespace question. Node's own
 * `crypto` and `fs` are the only imports, so it runs anywhere Node runs, years from now, with no
 * install step and no access to this repository.
 */
const VERIFIER_SOURCE = `#!/usr/bin/env node
// SAAKSHI export bundle verifier. No dependencies. Run:  node verify.mjs
//
// It re-hashes every file the manifest lists and the manifest itself. A pass proves the bundle is
// byte-for-byte unaltered since it was built. It does not prove the contents are true.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const unlisted = new Set(['manifest.json', 'manifest.sha256', 'verify.mjs', 'README.txt']);
const failures = [];

const manifestBytes = readFileSync(join(root, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const declared = readFileSync(join(root, 'manifest.sha256'), 'utf8').trim();
const actual = sha256(manifestBytes);
if (declared !== actual) failures.push(\`manifest.json: expected \${declared}, got \${actual}\`);

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [relative(root, join(dir, e.name)).split('\\\\').join('/')],
  );

let checked = 0;
for (const item of manifest.items ?? []) {
  const full = join(root, item.path);
  let size;
  try {
    size = statSync(full).size;
  } catch {
    failures.push(\`\${item.path}: listed in the manifest but missing\`);
    continue;
  }
  if (size !== item.bytes) {
    failures.push(\`\${item.path}: expected \${item.bytes} bytes, got \${size}\`);
    continue;
  }
  const got = sha256(readFileSync(full));
  checked++;
  if (got !== item.sha256) failures.push(\`\${item.path}: expected \${item.sha256}, got \${got}\`);
}

const listed = new Set((manifest.items ?? []).map((i) => i.path));
for (const present of walk(root)) {
  if (!listed.has(present) && !unlisted.has(present)) {
    failures.push(\`\${present}: present but not listed in the manifest\`);
  }
}

console.log(\`bundle      \${manifest.bundleId}\`);
console.log(\`case        \${manifest.caseRef}\`);
console.log(\`built       \${manifest.createdAt}\`);
console.log(\`items       \${checked} of \${(manifest.items ?? []).length} verified\`);
console.log(\`manifest    \${actual}\`);
if (failures.length === 0) {
  console.log('\\nPASS — every file matches the manifest, and the manifest matches its hash.');
  console.log(manifest.claim);
  process.exit(0);
}
console.log(\`\\nFAIL — \${failures.length} problem(s):\`);
for (const f of failures) console.log(\`  \${f}\`);
process.exit(1);
`;

function readmeFor(manifest: BundleManifest, manifestHash: string): string {
  return [
    `SAAKSHI EVIDENCE EXPORT — ${manifest.bundleId}`,
    '='.repeat(72),
    '',
    `Case reference   ${manifest.caseRef}`,
    `Subject          ${manifest.subject.normalized || manifest.subject.query} (vehicle registration)`,
    `Built            ${manifest.createdAt}`,
    `Built by         ${manifest.createdBy.badgeNo ?? 'system'} (${manifest.createdBy.role ?? 'system'})`,
    `Stated purpose   ${manifest.purpose}`,
    '',
    `Sightings        ${manifest.counts.sightings}`,
    `Cameras          ${manifest.counts.cameras}`,
    `Crops included   ${manifest.counts.cropsIncluded}`,
    `Crops absent     ${manifest.counts.cropsUnavailable}  (listed with a reason under "omissions")`,
    '',
    'HOW TO VERIFY',
    '-'.repeat(72),
    '  node verify.mjs',
    '',
    'No installation, no network, no access to the originating system. The verifier re-hashes every',
    'file the manifest lists and the manifest itself.',
    '',
    `Manifest SHA-256  ${manifestHash}`,
    `Audit entry hash  ${manifest.chain.auditEntryHash}`,
    `Chain algorithm   ${manifest.chain.algorithm}`,
    '',
    'The audit entry above is a link in this deployment\'s append-only chain. It records who built',
    'this bundle, when, for what stated purpose and against which case. It is what ties the package',
    'to an accountable person; the hashes below tie the package to its own contents.',
    '',
    'WHAT A PASS PROVES, AND WHAT IT DOES NOT',
    '-'.repeat(72),
    manifest.claim,
    '',
    manifest.disclaimer,
    '',
  ].join('\n');
}
