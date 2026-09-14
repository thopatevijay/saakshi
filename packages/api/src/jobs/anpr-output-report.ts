/**
 * `npm run report:anpr-output` — the government-feed output report (D4-03).
 *
 * **Mandatory submission item 4**, and the artefact behind evaluation area #1 ("Successful Test
 * Case"). The organisers ask for *"an output report showing detected vehicles or number plates with
 * corresponding timestamps"*, and their wording is careful — *"available* video-analytics output" —
 * so this reports what the estate actually produced and nothing else.
 *
 * ## What it refuses to include, and why that matters more than what it includes
 *
 * **Synthetic cameras are excluded.** `TRACEFIX-*` are the fixture vehicles behind the trace
 * demonstration — invented by `demo:trace`, correct for showing a route, and not a government
 * detection. This is a *government-feed* report; padding it with fixtures would be the one thing the
 * brief explicitly warns against. The exclusion is counted and stated in the PDF rather than done
 * quietly, because a reader comparing this row count against the database should find the
 * difference explained.
 *
 * **Every row carries its `plate_read_id`.** D4-03's AC 6 requires each row to be traceable to a
 * `plate_reads` id, so the id is the first column: a judge can take any line of the CSV and find the
 * exact row it came from.
 *
 * **Every row carries both the absolute timestamp and `frame_pts_ms`.** AC 8 requires timestamps to
 * be PTS-derived and absolute. Printing only the timestamp would assert that; printing the
 * presentation timestamp beside it *demonstrates* it — the wall-clock column is the frame's own PTS
 * resolved against the stream epoch, and the two are checkable against each other. `CLAUDE.md` is
 * explicit that timing comes from PTS and never from frame arrival time.
 *
 * ## Accuracy is cited, not recomputed
 *
 * The PDF's accuracy section quotes `docs/anpr-accuracy.md` — D2-01's 120-instance hand-labelled
 * measurement — rather than deriving a fresh number from this window. Four reads is not a sample
 * anyone should compute precision from, and inventing a second accuracy figure that disagreed with
 * the documented one is precisely the inconsistency D4-03's handoff warns about: *"the measured
 * accuracy in this report must match the number in the deck."*
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createDb, createSql, type Db } from '../db/client.js';
import { loadEnv } from '../env.js';
import { evidenceStoreFromEnv } from '../services/evidence.js';
import { csvCell } from '../services/trace-export.js';
import { A4_LANDSCAPE, PdfPage, renderPdf, type PdfImage } from '../services/pdf.js';
import { MEASURED_ANPR_LINES } from '../services/anpr-accuracy.js';

/**
 * The repository root from this file, never `process.cwd()`.
 *
 * `npm run report:anpr-output` runs with the cwd set to `packages/api`, so a relative `--out` would
 * quietly write `packages/api/submission/…` — which is what happened the first time, and the report
 * looked like it had been produced while the deliverable path stayed empty. Same reasoning, and the
 * same constant, as `gap-analysis-cli.ts`.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Fixture cameras invented by `demo:trace`. Never a government detection. */
const SYNTHETIC_PREFIX = 'TRACEFIX';

interface Args {
  from: string | undefined;
  to: string | undefined;
  out: string;
  maxCrops: number;
}

function parse(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    from: flag('from'),
    to: flag('to'),
    out: flag('out') ?? 'submission/govt-feed-output-report',
    maxCrops: Number(flag('max-crops') ?? '60'),
  };
}

interface ReadRow extends Record<string, unknown> {
  plate_read_id: string;
  camera_id: string;
  camera_external_id: string;
  camera_name: string;
  department: string | null;
  raw_text: string;
  normalized_text: string | null;
  confidence: string;
  ts: string;
  frame_pts_ms: string;
  is_best_shot: boolean;
  vote_count: number;
  crop_uri: string | null;
}

async function readsInWindow(db: Db, from: string | undefined, to: string | undefined) {
  return db.execute<ReadRow>(sql`
    select pr.id::text                as plate_read_id,
           c.id::text                 as camera_id,
           c.external_id              as camera_external_id,
           c.name                     as camera_name,
           d.name                     as department,
           pr.raw_text,
           pr.normalized_text,
           pr.confidence::text        as confidence,
           s.ts::text                 as ts,
           s.frame_pts_ms::text       as frame_pts_ms,
           pr.is_best_shot,
           pr.vote_count,
           pr.crop_uri
      from plate_reads pr
      join sightings s   on s.id = pr.sighting_id
      join cameras   c   on c.id = s.camera_id
      left join departments d on d.id = c.department_id
     where c.external_id not like ${`${SYNTHETIC_PREFIX}%`}
       and (${from ?? null}::timestamptz is null or s.ts >= ${from ?? null}::timestamptz)
       and (${to ?? null}::timestamptz   is null or s.ts <= ${to ?? null}::timestamptz)
     order by s.ts, c.external_id
  `);
}

/** Cameras that produced sightings but no plate read — the limitations section's raw material. */
async function camerasWithoutReads(db: Db, from: string | undefined, to: string | undefined) {
  return db.execute<{ external_id: string; name: string; sightings: string; geometry_class: string }>(
    sql`
    select c.external_id, c.name, count(s.id)::text as sightings, c.geometry_class::text
      from cameras c
      join sightings s on s.camera_id = c.id
     where c.external_id not like ${`${SYNTHETIC_PREFIX}%`}
       and (${from ?? null}::timestamptz is null or s.ts >= ${from ?? null}::timestamptz)
       and (${to ?? null}::timestamptz   is null or s.ts <= ${to ?? null}::timestamptz)
       and not exists (select 1 from plate_reads pr where pr.sighting_id = s.id)
     group by c.external_id, c.name, c.geometry_class
    having count(s.id) > 0
     order by count(s.id) desc
  `,
  );
}

const CSV_COLUMNS = [
  'plate_read_id',
  'camera_id',
  'camera_external_id',
  'camera_name',
  'department',
  'plate_text',
  'normalized_plate',
  'confidence',
  'timestamp',
  'frame_pts_ms',
  'is_best_shot',
  'vote_count',
  'crop_reference',
] as const;

function toCsv(rows: readonly ReadRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.plate_read_id,
        r.camera_id,
        r.camera_external_id,
        r.camera_name,
        r.department,
        r.raw_text,
        r.normalized_text,
        r.confidence,
        new Date(r.ts).toISOString(),
        r.frame_pts_ms,
        r.is_best_shot,
        r.vote_count,
        r.crop_uri,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

async function fetchCrops(rows: readonly ReadRow[], limit: number): Promise<Map<string, Buffer>> {
  const store = evidenceStoreFromEnv();
  const out = new Map<string, Buffer>();
  if (store === null) return out;
  const prefix = `s3://${store.bucket}/`;
  for (const r of rows.slice(0, limit)) {
    // The D2-11 rule: a `crop_uri` outside this bucket cannot be served with these credentials, and
    // guessing produces a link that 4xxs while looking real. Skip it; the PDF says "no crop stored".
    if (r.crop_uri === null || !r.crop_uri.startsWith(prefix)) continue;
    try {
      const object = await store.getObject(r.crop_uri.slice(prefix.length));
      if (object !== null) out.set(r.plate_read_id, Buffer.from(object.bytes));
    } catch {
      // A crop that cannot be fetched is an absence, not a failure of the report. It is counted.
    }
  }
  return out;
}

function buildPdf(
  rows: readonly ReadRow[],
  missing: readonly { external_id: string; name: string; sightings: string; geometry_class: string }[],
  crops: Map<string, Buffer>,
  window: { from: string | undefined; to: string | undefined },
  excludedSynthetic: number,
): { pdf: Buffer } {
  const pages: PdfPage[] = [];
  const images: PdfImage[] = [];
  const M = 40;
  const W = A4_LANDSCAPE.width;

  let page = new PdfPage(A4_LANDSCAPE);
  pages.push(page);
  let y = A4_LANDSCAPE.height - M;

  page.text('SAAKSHI — government-feed ANPR output report', M, y, { size: 16, font: 'Helvetica-Bold' });
  y -= 18;
  page.text(
    'Gujarat Police Innovation Challenge 2026 · mandatory submission item 4',
    M,
    y,
    { size: 9, grey: 0.35 },
  );
  y -= 26;

  const cameras = new Set(rows.map((r) => r.camera_external_id));
  const withCrop = rows.filter((r) => crops.has(r.plate_read_id)).length;
  const summary: [string, string][] = [
    ['Generated', new Date().toISOString()],
    ['Window', `${window.from ?? 'all time'} → ${window.to ?? 'now'}`],
    ['Plate reads reported', String(rows.length)],
    ['Cameras producing reads', String(cameras.size)],
    ['Reads with a stored crop', `${String(withCrop)} of ${String(rows.length)}`],
    ['Synthetic rows excluded', `${String(excludedSynthetic)} (TRACEFIX-* demo fixtures)`],
  ];
  for (const [k, v] of summary) {
    page.text(k, M, y, { size: 9, grey: 0.4 });
    page.text(v, M + 190, y, { size: 9, font: 'Helvetica-Bold' });
    y -= 14;
  }
  y -= 10;

  page.text('What this report claims', M, y, { size: 11, font: 'Helvetica-Bold' });
  y -= 15;
  y = page.paragraph(
    'Every row below is a plate read the analytics pipeline produced from a government sandbox feed. ' +
      'A read is what the OCR returned — it is not an identification of a vehicle, and on this estate ' +
      'most reads are not valid registrations at all. Rows from the TRACEFIX-* demonstration fixtures ' +
      'are excluded: they are synthetic by construction and this report covers government feeds only.',
    M,
    y,
    W - 2 * M,
    { size: 9 },
  );
  y -= 8;
  y = page.paragraph(
    'Timestamps are absolute wall-clock times derived from each frame’s presentation timestamp ' +
      '(PTS), never from the time a frame arrived. The frame_pts_ms column in the CSV is that ' +
      'presentation timestamp, so the derivation is checkable rather than asserted.',
    M,
    y,
    W - 2 * M,
    { size: 9 },
  );
  y -= 18;

  page.text('Measured accuracy — and where it fails', M, y, { size: 11, font: 'Helvetica-Bold' });
  y -= 15;
  y = page.paragraph(
    'These figures are NOT computed from this window. They come from D2-01’s hand-labelled ' +
      'measurement of 120 vehicle instances drawn from this estate, documented with its method in ' +
      'docs/anpr-accuracy.md. Four reads is not a sample from which precision can honestly be ' +
      'computed, and a second accuracy number that disagreed with the documented one would be worse ' +
      'than none.',
    M,
    y,
    W - 2 * M,
    { size: 9 },
  );
  y -= 6;
  for (const line of MEASURED_ANPR_LINES) {
    page.text(`• ${line}`, M + 6, y, { size: 9 });
    y -= 13;
  }
  y -= 6;
  y = page.paragraph(
    'Against the challenge’s stated target of >90% detection/processing accuracy, exact plate ' +
      'reading on this estate MISSES, and it is reported as missing. The estate is dominated by ' +
      'wide-area CSITMS traffic-overview cameras built for traffic monitoring rather than plate ' +
      'capture, and the recorded window is roughly nine of twelve hours in darkness.',
    M,
    y,
    W - 2 * M,
    { size: 9 },
  );

  // ── Limitations ────────────────────────────────────────────────────────────────────────────
  page = new PdfPage(A4_LANDSCAPE);
  pages.push(page);
  y = A4_LANDSCAPE.height - M;
  page.text('Limitations — cameras that produced no plate read', M, y, {
    size: 13,
    font: 'Helvetica-Bold',
  });
  y -= 18;
  y = page.paragraph(
    'A camera that saw vehicles and read no plate is the normal case on this estate, and naming those ' +
      'cameras is more useful than a headline count. The cause is geometry and light, not a failure to ' +
      'run: each of these decoded frames and produced vehicle sightings.',
    M,
    y,
    W - 2 * M,
    { size: 9 },
  );
  y -= 16;
  page.text('CAMERA', M, y, { size: 8, font: 'Helvetica-Bold', grey: 0.4 });
  page.text('NAME', M + 90, y, { size: 8, font: 'Helvetica-Bold', grey: 0.4 });
  page.text('SIGHTINGS', M + 400, y, { size: 8, font: 'Helvetica-Bold', grey: 0.4 });
  page.text('GEOMETRY', M + 480, y, { size: 8, font: 'Helvetica-Bold', grey: 0.4 });
  y -= 4;
  page.line(M, y, W - M, y, { grey: 0.8 });
  y -= 12;
  if (missing.length === 0) {
    page.text('Every camera with sightings in this window produced at least one read.', M, y, {
      size: 9,
      grey: 0.4,
    });
    y -= 14;
  }
  for (const m of missing) {
    if (y < M + 40) {
      page = new PdfPage(A4_LANDSCAPE);
      pages.push(page);
      y = A4_LANDSCAPE.height - M;
    }
    page.text(m.external_id, M, y, { size: 9, font: 'Courier' });
    page.text(m.name.slice(0, 60), M + 90, y, { size: 9 });
    page.text(m.sightings, M + 400, y, { size: 9 });
    page.text(m.geometry_class, M + 480, y, { size: 9, grey: 0.4 });
    y -= 13;
  }

  // ── The reads, with crops ──────────────────────────────────────────────────────────────────
  page = new PdfPage(A4_LANDSCAPE);
  pages.push(page);
  y = A4_LANDSCAPE.height - M;
  page.text('Detected plates, with timestamps and crops', M, y, {
    size: 13,
    font: 'Helvetica-Bold',
  });
  y -= 20;

  const header = (): void => {
    page.text('CROP', M, y, { size: 8, font: 'Helvetica-Bold', grey: 0.4 });
    page.text('CAMERA', M + 70, y, { size: 8, font: 'Helvetica-Bold', grey: 0.4 });
    page.text('READ', M + 180, y, { size: 8, font: 'Helvetica-Bold', grey: 0.4 });
    page.text('CONF', M + 290, y, { size: 8, font: 'Helvetica-Bold', grey: 0.4 });
    page.text('TIMESTAMP (from PTS)', M + 340, y, { size: 8, font: 'Helvetica-Bold', grey: 0.4 });
    page.text('PTS ms', M + 500, y, { size: 8, font: 'Helvetica-Bold', grey: 0.4 });
    page.text('PLATE_READ_ID', M + 570, y, { size: 8, font: 'Helvetica-Bold', grey: 0.4 });
    y -= 4;
    page.line(M, y, W - M, y, { grey: 0.8 });
    y -= 40;
  };
  header();

  for (const r of rows) {
    if (y < M + 50) {
      page = new PdfPage(A4_LANDSCAPE);
      pages.push(page);
      y = A4_LANDSCAPE.height - M;
      header();
    }
    const crop = crops.get(r.plate_read_id);
    if (crop !== undefined) {
      const name = `Im${String(images.length)}`;
      images.push({ name, jpeg: crop });
      page.image(name, M, y - 4, 56, 36);
    } else {
      page.text('no crop', M, y + 8, { size: 8, grey: 0.55, font: 'Helvetica-Oblique' });
    }
    page.text(r.camera_external_id, M + 70, y + 14, { size: 9, font: 'Courier' });
    page.text(r.camera_name.slice(0, 22), M + 70, y + 3, { size: 7, grey: 0.45 });
    page.text(r.raw_text, M + 180, y + 14, { size: 10, font: 'Helvetica-Bold' });
    page.text(
      r.normalized_text === null || r.normalized_text === ''
        ? 'no normalised form'
        : `norm ${r.normalized_text}`,
      M + 180,
      y + 3,
      { size: 7, grey: 0.45 },
    );
    page.text(Number(r.confidence).toFixed(3), M + 290, y + 14, { size: 9 });
    page.text(new Date(r.ts).toISOString(), M + 340, y + 14, { size: 8, font: 'Courier' });
    page.text(r.frame_pts_ms, M + 500, y + 14, { size: 8, font: 'Courier' });
    page.text(r.plate_read_id.slice(0, 8), M + 570, y + 14, { size: 8, font: 'Courier', grey: 0.4 });
    y -= 46;
  }

  return { pdf: renderPdf(pages, { title: 'SAAKSHI — government-feed ANPR output report' }, images) };
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  const env = loadEnv(process.env);
  const rawSql = createSql(env.DATABASE_URL, 4);
  const db = createDb(rawSql);
  const out = (l: string): void => {
    process.stdout.write(`${l}\n`);
  };

  try {
    const rows = [...(await readsInWindow(db, args.from, args.to))];
    const missing = [...(await camerasWithoutReads(db, args.from, args.to))];
    const excluded = [
      ...(await db.execute<{ n: string }>(sql`
        select count(*)::text as n
          from plate_reads pr
          join sightings s on s.id = pr.sighting_id
          join cameras c   on c.id = s.camera_id
         where c.external_id like ${`${SYNTHETIC_PREFIX}%`}
      `)),
    ];
    const excludedCount = Number(excluded[0]?.n ?? '0');

    if (rows.length === 0) {
      out('no government-feed plate reads in this window — refusing to write an empty report.');
      out('  Run the analytics pipeline over the sandbox feeds first, or widen --from/--to.');
      return 1;
    }

    const crops = await fetchCrops(rows, args.maxCrops);
    const csv = toCsv(rows);
    const { pdf } = buildPdf(rows, missing, crops, { from: args.from, to: args.to }, excludedCount);

    const outBase = path.isAbsolute(args.out) ? args.out : path.join(REPO_ROOT, args.out);
    mkdirSync(path.dirname(outBase), { recursive: true });
    writeFileSync(`${outBase}.csv`, csv, 'utf8');
    writeFileSync(`${outBase}.pdf`, pdf);

    const cameras = new Set(rows.map((r) => r.camera_external_id));
    out(`database        ${new URL(env.DATABASE_URL).pathname.slice(1)}`);
    out(`window          ${args.from ?? 'all time'} -> ${args.to ?? 'now'}`);
    out(`plate reads     ${String(rows.length)} across ${String(cameras.size)} cameras`);
    out(`crops embedded  ${String(crops.size)} of ${String(rows.length)}`);
    out(`excluded        ${String(excludedCount)} synthetic (${SYNTHETIC_PREFIX}-*) rows`);
    out(`no-read cameras ${String(missing.length)} with sightings but no plate read`);
    out(`wrote           ${path.relative(REPO_ROOT, `${outBase}.csv`)}`);
    out(`wrote           ${path.relative(REPO_ROOT, `${outBase}.pdf`)}`);
    return 0;
  } finally {
    await rawSql.end();
  }
}

process.exit(await main());
