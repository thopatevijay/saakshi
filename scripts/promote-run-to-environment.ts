/**
 * `npm run db:promote-run` — copy an ingest run from one environment's database into another (D4-13).
 *
 * ## Why this exists
 *
 * Submissions are judged by opening the deployed URL. On 15 Sep an every-table audit found the
 * deployed database held a *different* ingest run from the one every submission artefact describes:
 * 90,704 sightings, but only **4** inside the window `submission/govt-feed-output-report.csv` covers,
 * where local held 14,900 across `cam01` 2,674 / `cam04` 7,634 / `cam05` 4,592.
 *
 * That is not cosmetic. A report regenerated against the deployed database silently **drops the line
 * disclosing that cam01 saw 2,674 vehicles and read zero plates** — one of the report's most honest
 * statements, and exactly the kind of claim this project is scored on keeping.
 *
 * ## Why `pg_dump` cannot do this
 *
 * The two databases generated **different uuids for the same camera**: `cam04` is `af0eb90e…`
 * locally and `cb0ffcf7…` in the deployed environment. A straight dump would either violate the
 * foreign key or, worse, attach 14,900 sightings to whichever camera happened to hold that uuid.
 * So `camera_id` is remapped by `external_id`, which is the only identifier both databases agree on.
 *
 * Sighting and plate-read ids **are** preserved: `submission/govt-feed-output-report.csv` cites each
 * `plate_read_id`, and D4-03's AC 6 requires every row to stay traceable to one.
 *
 * ## Two things that will bite a reader of this file
 *
 * - `sightings` is a **TimescaleDB hypertable**, so its primary key is `(id, ts)` — the partitioning
 *   column must appear in any unique index — and `ON CONFLICT` has to name both. `ON CONFLICT (id)`
 *   fails with *"no unique or exclusion constraint matching the ON CONFLICT specification"*.
 * - A PG 17 `pg_dump` into a PG 16 server emits `SET transaction_timeout = 0`, which PG 16 rejects;
 *   with `ON_ERROR_STOP=1` the load aborts having written nothing while every surrounding command
 *   reports success. This script talks to both databases over the wire and sidesteps that entirely.
 *
 * Idempotent: every insert is `ON CONFLICT … DO NOTHING`, so a re-run writes nothing and reports 0.
 *
 * Usage:
 *   npm run db:promote-run -- --from <url> --to <url> --window 2026-09-11T00:00:00Z..2026-09-12T00:00:00Z
 *   npm run db:promote-run -- --from … --to … --window … --dry-run
 */
import postgres from 'postgres';

export {};

const args = process.argv;

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i !== -1) {
    const v = args[i + 1];
    if (v !== undefined && !v.startsWith('--')) return v;
  }
  return undefined;
}

const fromUrl = flag('from') ?? process.env['SOURCE_DATABASE_URL'];
const toUrl = flag('to') ?? process.env['TARGET_DATABASE_URL'];
const windowArg = flag('window');
const dry = args.includes('--dry-run');

if (fromUrl === undefined || toUrl === undefined || windowArg === undefined) {
  console.error(
    'usage: --from <source url> --to <target url> --window <fromIso>..<toIso> [--dry-run]\n' +
      '       urls may also come from SOURCE_DATABASE_URL / TARGET_DATABASE_URL',
  );
  process.exit(2);
}

const [windowFrom, windowTo] = windowArg.split('..');
if (windowFrom === undefined || windowTo === undefined) {
  console.error('--window must be <fromIso>..<toIso>');
  process.exit(2);
}

/**
 * Row shapes, declared rather than inferred.
 *
 * `postgres` types every column `any`, so without these the whole file is an unsafe-argument
 * minefield and `--max-warnings 0` rejects it. Declaring them also documents exactly which columns
 * this migration carries — anything added to `sightings` later will not be copied silently.
 */
interface CameraRow {
  id: string;
  external_id: string;
}

interface SightingRow {
  id: string;
  camera_id: string;
  ts: Date;
  frame_pts_ms: number;
  track_id: string;
  class: string;
  bbox: unknown;
  det_confidence: number;
  vehicle_color: string | null;
  vehicle_type: string | null;
  crop_uri: string | null;
  vehicle_color_confidence: number | null;
  attributes_low_confidence: boolean | null;
  is_best_shot: boolean;
  external_id: string;
}

interface PlateReadRow {
  id: string;
  sighting_id: string;
  sighting_ts: Date;
  raw_text: string;
  normalized_text: string | null;
  confidence: number | null;
  is_best_shot: boolean;
  vote_count: number | null;
  crop_uri: string | null;
}

interface CountRow {
  cam: string;
  n: number;
}

/** Batched so a 14,900-row run does not build one statement megabytes wide. */
const BATCH = 500;

const source = postgres(fromUrl, {
  max: 1,
  ...(fromUrl.includes('sslmode') ? { ssl: 'require' as const } : {}),
});
const target = postgres(toUrl, {
  max: 1,
  ...(toUrl.includes('sslmode') ? { ssl: 'require' as const } : {}),
});

try {
  // `external_id` is the only identifier the two databases agree on. Anything the target does not
  // know about is skipped loudly rather than silently dropped.
  const targetCameras = new Map<string, string>();
  for (const c of await target<CameraRow[]>`select id, external_id from cameras`) {
    targetCameras.set(c.external_id, c.id);
  }

  const sightings = await source<SightingRow[]>`
    select s.*, c.external_id
    from sightings s join cameras c on c.id = s.camera_id
    where s.ts >= ${windowFrom} and s.ts < ${windowTo}
    order by s.ts`;

  const unknown = [
    ...new Set(sightings.map((r) => r.external_id).filter((e) => !targetCameras.has(e))),
  ];
  if (unknown.length > 0) {
    console.error(`the target has no camera with external_id: ${unknown.join(', ')}`);
    console.error('refusing to guess — register those cameras in the target first');
    process.exit(1);
  }

  const byCamera = new Map<string, number>();
  for (const r of sightings) {
    byCamera.set(r.external_id, (byCamera.get(r.external_id) ?? 0) + 1);
  }
  console.log(`source window   ${String(sightings.length)} sightings`);
  for (const [cam, n] of [...byCamera].sort()) console.log(`  ${cam.padEnd(8)} ${String(n)}`);

  const reads = await source<PlateReadRow[]>`
    select pr.*
    from plate_reads pr
    join sightings s on s.id = pr.sighting_id
    where s.ts >= ${windowFrom} and s.ts < ${windowTo}`;
  console.log(`source window   ${String(reads.length)} plate reads`);

  if (dry) {
    console.log('DRY RUN — nothing written');
  } else {
    let insertedSightings = 0;
    for (let i = 0; i < sightings.length; i += BATCH) {
      const chunk = sightings.slice(i, i + BATCH).map((r) => ({
        id: r.id,
        camera_id: targetCameras.get(r.external_id) ?? '',
        ts: r.ts,
        frame_pts_ms: r.frame_pts_ms,
        track_id: r.track_id,
        class: r.class,
        bbox: r.bbox,
        det_confidence: r.det_confidence,
        vehicle_color: r.vehicle_color,
        vehicle_type: r.vehicle_type,
        crop_uri: r.crop_uri,
        vehicle_color_confidence: r.vehicle_color_confidence,
        attributes_low_confidence: r.attributes_low_confidence,
        is_best_shot: r.is_best_shot,
      }));
      // (id, ts): `sightings` is a hypertable — see the note at the top of this file.
      const res = await target`
        insert into sightings ${target(chunk)} on conflict (id, ts) do nothing returning id`;
      insertedSightings += res.length;
      process.stdout.write(`\rsightings       ${String(insertedSightings)} inserted`);
    }
    process.stdout.write('\n');

    let insertedReads = 0;
    for (const r of reads) {
      const res = await target`
        insert into plate_reads (id, sighting_id, sighting_ts, raw_text, normalized_text,
                                 confidence, is_best_shot, vote_count, crop_uri)
        values (${r.id}, ${r.sighting_id}, ${r.sighting_ts}, ${r.raw_text},
                ${r.normalized_text}, ${r.confidence}, ${r.is_best_shot},
                ${r.vote_count}, ${r.crop_uri})
        on conflict (id) do nothing returning id`;
      insertedReads += res.length;
    }
    console.log(`plate reads     ${String(insertedReads)} inserted`);
  }

  const after = await target<CountRow[]>`
    select c.external_id as cam, count(*)::int as n
    from sightings s join cameras c on c.id = s.camera_id
    where s.ts >= ${windowFrom} and s.ts < ${windowTo}
    group by 1 order by 1`;
  console.log(
    `target window   ${after.map((r) => `${r.cam}:${String(r.n)}`).join(' ') || '(empty)'}`,
  );
} finally {
  await source.end();
  await target.end();
}
