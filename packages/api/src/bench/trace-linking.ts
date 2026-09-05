/**
 * D2-08 — what identity linking actually does on this estate.
 *
 * `CLAUDE.md`: no accuracy claims without measurement. This script produces the two numbers a
 * vehicle trace can honestly be described by, and they are very different numbers.
 *
 * **1 · The estate as it stands.** How many of the real `(camera_id, track_id)` track sessions can
 * be linked to a registration at all. On the measured corpus the answer is **zero**, because there
 * are no plate reads: D2-01 read 0 plates exactly across 120 hand-labelled instances, only 3 of
 * which carried a human-legible plate. That is the honest headline for the live estate and it is
 * reported first, before anything more flattering.
 *
 * **2 · The linker itself, under the estate's measured error profile.** The interesting question
 * that number cannot answer is whether *this component* works — whether, given the reads this
 * estate would produce if plates were legible, a trace recovers the vehicle. So the script attaches
 * synthetic reads to the **real** track sessions using the three error shapes D2-01 actually
 * measured on the three legible plates (`docs/anpr-accuracy.md` §3), runs the real trace service
 * over them, and reports recall, precision and confidence per error family.
 *
 * The distinction matters and is kept explicit in the output: §1 measures the **estate**, §2
 * measures the **linker**. Neither is quoted as the other. §2 is a controlled experiment on real
 * sighting rows, not an observation of the live feeds, and it says so in its own heading.
 *
 * Reads are inserted against real sightings under a reserved `crop_uri` prefix and removed again in
 * a `finally`, so a crash mid-run leaves one `delete` to issue and the script prints it.
 *
 *   DATABASE_URL=... npm run measure:trace-linking
 */
import { sql } from 'drizzle-orm';
import { createDb, createSql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { TraceService } from '../services/trace.js';

const TAG = `MEASD208-${String(Date.now()).slice(-8)}`;
const CROP_PREFIX = `s3://measure/${TAG}/`;

/**
 * The three error shapes D2-01 measured, with the confidence each read actually carried.
 *
 * | ground truth | pipeline read | char acc | confidence |
 * |---|---|---|---|
 * | `GJ12EC7928` | `50011A`   | 0.0%  | 0.373 |
 * | `GJ32D0107`  | `GJ32DD10` | 77.8% | 0.584 |
 * | `GJ35U0779`  | `GJ35U07`  | 77.8% | 0.764 |
 *
 * Applied in equal thirds, which is the ratio they occurred in — the whole legible sample was three
 * plates, and inventing a different mix would be inventing data.
 */
const FAMILIES = [
  {
    name: 'garbage (cam30 daylight, dark-on-dark)',
    confidence: 0.373,
    /** Shares no character with the truth, as the measured read did not. */
    transform: (plate: string): string => `${String(50011 + (plate.length % 7))}A`,
  },
  {
    name: 'truncation -1 + confusable substitution (cam07 night)',
    confidence: 0.584,
    // `GJ32D0107` -> `GJ32DD10`: last character dropped, and a 0 read as a D in the tail.
    transform: (plate: string): string => {
      const body = plate.slice(0, -1);
      const idx = body.length - 3;
      return `${body.slice(0, idx)}${body[idx] === '0' ? 'D' : 'D'}${body.slice(idx + 1)}`;
    },
  },
  {
    name: 'truncation -2 (cam07 night)',
    confidence: 0.764,
    transform: (plate: string): string => plate.slice(0, -2),
  },
] as const;

/** A real-shaped registration per session. Deterministic, and it names no real vehicle. */
function syntheticPlate(index: number): string {
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const rto = String((index % 38) + 1).padStart(2, '0');
  const a = LETTERS[Math.floor(index / 24) % 24] ?? 'A';
  const b = LETTERS[index % 24] ?? 'B';
  const number = String(1000 + ((index * 7919) % 9000));
  return `GJ${rto}${a}${b}${number}`;
}

interface SessionRow extends Record<string, unknown> {
  camera_id: string;
  external_id: string;
  track_id: number;
  sightings: string;
  first_sighting_id: string;
  first_ts: string;
}

async function main(): Promise<void> {
  const env = loadEnv({ ...process.env });
  const rawSql = createSql(env.DATABASE_URL, 8);
  const db = createDb(rawSql);
  const service = new TraceService(db);

  const line = (s = ''): void => {
    process.stdout.write(`${s}\n`);
  };

  try {
    /* ── §1 · the estate as it stands ─────────────────────────────────────────────────────────── */

    const estate = (
      await db.execute<{
        sightings: string;
        cameras: string;
        sessions: string;
        distinct_track_ids: string;
        with_reads: string;
      }>(sql`
        select (select count(*)::text from sightings) as sightings,
               (select count(distinct camera_id)::text from sightings) as cameras,
               (select count(*)::text from (select distinct camera_id, track_id from sightings) t) as sessions,
               (select count(distinct track_id)::text from sightings) as distinct_track_ids,
               (select count(*)::text from (
                  select distinct s.camera_id, s.track_id
                    from sightings s
                    join plate_reads pr on pr.sighting_id = s.id and pr.sighting_ts = s.ts
                   where pr.normalized_text is not null
               ) t) as with_reads
      `)
    )[0];
    if (estate === undefined) throw new Error('no estate row');

    const sessions = Number(estate.sessions);
    const withReads = Number(estate.with_reads);

    line('════ §1 · THE ESTATE AS IT STANDS (an observation) ════');
    line();
    line(`sightings                              ${estate.sightings}`);
    line(`cameras with sightings                 ${estate.cameras}`);
    line(`track sessions — (camera_id, track_id) ${estate.sessions}`);
    line(
      `distinct track_id values               ${estate.distinct_track_ids}   <- under-counts sessions`,
    );
    line();
    line(`sessions carrying a usable plate read  ${estate.with_reads}`);
    line(
      `SESSIONS THAT LINK TO A REGISTRATION    ${String(withReads)} of ${String(sessions)}` +
        ` (${pct(withReads, sessions)})`,
    );
    line(
      `SESSIONS THAT STAY SINGLETONS           ${String(sessions - withReads)} of ${String(sessions)}` +
        ` (${pct(sessions - withReads, sessions)})`,
    );
    line();
    line(
      'Failure mode, in one sentence: there is nothing to link on. D2-01 measured 0 exact plate',
    );
    line('reads over 120 hand-labelled instances because only 3 of them carried a human-legible');
    line('plate at all (docs/anpr-accuracy.md). A vehicle trace on this estate is therefore built');
    line('from detections and attributes, not from confirmed identity, and the UI says so.');
    line();

    /* ── §2 · the linker, under the measured error profile ────────────────────────────────────── */

    const rows = await db.execute<SessionRow>(sql`
      select s.camera_id::text as camera_id,
             c.external_id,
             s.track_id,
             count(*)::text as sightings,
             (array_agg(s.id::text order by s.ts))[1] as first_sighting_id,
             min(s.ts) as first_ts
        from sightings s
        join cameras c on c.id = s.camera_id
       group by s.camera_id, c.external_id, s.track_id
       order by c.external_id, s.track_id
    `);

    line("════ §2 · THE LINKER, UNDER THE ESTATE'S MEASURED ERROR PROFILE ════");
    line('    A CONTROLLED EXPERIMENT on real sighting rows — not an observation of the feeds.');
    line();
    line(`Attaching one synthetic read to each of the ${String(rows.length)} real track sessions,`);
    line('using the three error shapes D2-01 measured on the three legible plates, in the ratio');
    line('they occurred. Every read is wrong; none is an exact match, exactly as measured.');
    line();

    const truth = new Map<string, { plate: string; family: number; sightingId: string }>();
    for (const [i, row] of rows.entries()) {
      const family = i % FAMILIES.length;
      const plate = syntheticPlate(i);
      const read = FAMILIES[family]?.transform(plate) ?? plate;
      const confidence = FAMILIES[family]?.confidence ?? 0.5;
      truth.set(`${row.camera_id}:${String(row.track_id)}`, {
        plate,
        family,
        sightingId: row.first_sighting_id,
      });
      await db.execute(sql`
        insert into plate_reads (sighting_id, sighting_ts, raw_text, normalized_text, confidence, vote_count, crop_uri, is_best_shot)
        values (${row.first_sighting_id}::uuid, ${row.first_ts}, ${read}, ${read}, ${confidence}, 3,
                ${`${CROP_PREFIX}${row.camera_id}-${String(row.track_id)}.jpg`}, true)
      `);
    }

    const stats = FAMILIES.map((f) => ({
      name: f.name,
      attempted: 0,
      linked: 0,
      confidences: [] as number[],
      falseLinks: 0,
    }));
    let totalReturned = 0;
    let totalCorrect = 0;
    let singletons = 0;
    let exactLinks = 0;

    const started = Date.now();
    const latencies: number[] = [];

    for (const [key, expected] of truth) {
      const stat = stats[expected.family];
      if (stat === undefined) continue;
      stat.attempted += 1;

      const t0 = performance.now();
      const result = await service.trace(expected.plate, { limit: 200 });
      latencies.push(performance.now() - t0);

      const hit = result.sightings.find((s) => s.sightingId === expected.sightingId);
      totalReturned += result.sightings.length;
      if (hit !== undefined) {
        stat.linked += 1;
        totalCorrect += 1;
        stat.confidences.push(hit.linkConfidence);
        if (hit.linkMethod === 'plate_exact') exactLinks += 1;
      }
      stat.falseLinks += result.sightings.filter(
        (s) => s.sightingId !== expected.sightingId,
      ).length;
      if (result.sightings.length === 1) singletons += 1;
      void key;
    }

    latencies.sort((a, b) => a - b);
    const p95 =
      latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)] ?? 0;
    const attempted = stats.reduce((n, s) => n + s.attempted, 0);
    const linked = stats.reduce((n, s) => n + s.linked, 0);

    line('by measured error family:');
    line();
    line(
      '  family                                                        attempted  linked  recall   mean conf',
    );
    for (const s of stats) {
      const mean =
        s.confidences.length === 0
          ? 0
          : s.confidences.reduce((a, b) => a + b, 0) / s.confidences.length;
      line(
        `  ${s.name.padEnd(60)}  ${String(s.attempted).padStart(9)}  ${String(s.linked).padStart(6)}` +
          `  ${pct(s.linked, s.attempted).padStart(6)}  ${mean.toFixed(3).padStart(9)}`,
      );
    }
    line();
    line(
      `SESSIONS LINKED             ${String(linked)} of ${String(attempted)} (${pct(linked, attempted)})`,
    );
    line(
      `SESSIONS THAT STAY SINGLE   ${String(attempted - linked)} of ${String(attempted)} (${pct(attempted - linked, attempted)})`,
    );
    line(`traces returning exactly one sighting   ${String(singletons)}`);
    line(
      `links reported as plate_exact           ${String(exactLinks)}  <- every read is wrong, so 0 is correct`,
    );
    line(
      `precision (correct sightings / returned) ${pct(totalCorrect, totalReturned)}` +
        `  [${String(totalCorrect)} / ${String(totalReturned)}]`,
    );
    line(
      `p95 trace latency                       ${p95.toFixed(1)} ms over ${String(latencies.length)} traces`,
    );
    line(`wall                                    ${((Date.now() - started) / 1000).toFixed(1)} s`);
    line();
    line(
      'Read §1 and §2 together: the linker recovers most of what the estate would produce if the',
    );
    line('plates were legible, and the estate produces none. Both numbers belong in the report.');
  } finally {
    const deleted = await db.execute<{ n: string }>(
      sql`with d as (delete from plate_reads where crop_uri like ${`${CROP_PREFIX}%`} returning 1)
          select count(*)::text as n from d`,
    );
    process.stdout.write(`\ncleanup: removed ${deleted[0]?.n ?? '0'} synthetic plate_reads\n`);
    process.stdout.write(
      `if this run crashed, finish with:\n  delete from plate_reads where crop_uri like '${CROP_PREFIX}%';\n`,
    );
    await rawSql.end();
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

await main();
