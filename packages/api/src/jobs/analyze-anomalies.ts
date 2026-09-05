/**
 * `npm run analyze:anomalies` — the whole-table sweep (D3-02 AC 8).
 *
 * Every registration the estate has actually read, traced, reconstructed on the road graph and
 * checked for impossible transitions, with the results counted by classification. It exists because
 * the acceptance criterion is not "the detector works on a fixture" but *"run it across the whole
 * real sightings table and report what you find — and if the count is implausibly high, that is an
 * OCR-quality finding, not a cloning-detection capability"*.
 *
 * ## What it counts, and what it refuses to count
 *
 * The plate universe is `plate_reads.normalized_text <> ''`, never `is not null`. The column is
 * three-valued on purpose (D2-10): `null` means nothing normalised the read, `''` means the read
 * contained no `[A-Z0-9]` at all — a real row, with real timing, carrying **no identity**. Sweeping
 * on `is not null` would pull every unreadable frame in as if it were a vehicle and manufacture
 * "clones" out of blank reads, which is precisely the failure this ticket is supposed to detect
 * rather than commit.
 *
 * ## Why the totals it prints are usually zeros, and why that is the honest answer
 *
 * A segment can only be called impossible if a road distance exists between its two cameras. The
 * Sentinel catalogue publishes `{id, name}` only, so **0 of 30 real cameras carry coordinates** —
 * every real transition is `inferred_unroutable`, no distance is computable, and the verdict is
 * `indeterminate`. That is reported as `segmentsEvaluable`, beside the total, rather than being
 * folded into "no anomalies found". A sweep that printed "0 impossible transitions" without saying
 * that 0 transitions could be assessed would be the more flattering and less true report.
 *
 * `--seq` prints a per-plate breakdown; `--json` emits the whole report for a document to quote.
 */
import { sql } from 'drizzle-orm';
import { createDb, createSql, type Db } from '../db/client.js';
import { loadEnv } from '../env.js';
import { analyseRoute, loadAnomalyPolicy, type AnomalyReport } from '../services/anomaly.js';
import { HttpOsrmClient, NullOsrmClient, OSRM_DEFAULT_URL } from '../services/osrm.js';
import { PlateSearchService } from '../services/plate-search.js';
import { RouteService } from '../services/route.js';
import { TraceService } from '../services/trace.js';

interface Args {
  limit: number;
  perPlate: boolean;
  json: boolean;
  persist: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = { limit: 500, perPlate: false, json: false, persist: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--limit') args.limit = Number(argv[++i] ?? '500');
    else if (flag === '--seq') args.perPlate = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--no-persist') args.persist = false;
  }
  return args;
}

interface Totals {
  plates: number;
  platesTraced: number;
  segments: number;
  evaluable: number;
  impossible: number;
  likelyMisread: number;
  likelyCloned: number;
  undetermined: number;
  alerts: number;
}

/**
 * The estate, measured rather than assumed, so the report can explain its own zeros.
 *
 * `camerasPlaced` is the number that decides whether this sweep can say anything at all: with none
 * placed, no road distance exists for any pair and every verdict is `indeterminate`.
 */
async function estate(db: Db): Promise<{
  sightings: number;
  plateReads: number;
  plateReadsIdentified: number;
  cameras: number;
  camerasPlaced: number;
}> {
  const rows = await db.execute<Record<string, string>>(sql`
    select (select count(*)::text from sightings)                                    as sightings,
           (select count(*)::text from plate_reads)                                  as plate_reads,
           (select count(*)::text from plate_reads where normalized_text <> '')      as identified,
           (select count(*)::text from cameras)                                      as cameras,
           (select count(*)::text from cameras where location is not null)           as placed
  `);
  const r = rows[0] ?? {};
  return {
    sightings: Number(r['sightings'] ?? '0'),
    plateReads: Number(r['plate_reads'] ?? '0'),
    plateReadsIdentified: Number(r['identified'] ?? '0'),
    cameras: Number(r['cameras'] ?? '0'),
    camerasPlaced: Number(r['placed'] ?? '0'),
  };
}

/** Every plate the estate has actually read. `<> ''`, never `is not null` — D2-10. */
async function platesToSweep(db: Db, limit: number): Promise<string[]> {
  const rows = await db.execute<{ plate: string; n: string }>(sql`
    select normalized_text as plate, count(*)::text as n
      from plate_reads
     where normalized_text <> ''
     group by normalized_text
     order by count(*) desc, normalized_text
     limit ${limit}
  `);
  return rows.map((r) => r.plate);
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  const env = loadEnv(process.env);
  const policy = loadAnomalyPolicy();
  const rawSql = createSql(env.DATABASE_URL, 4);
  const db = createDb(rawSql);
  const osrmUrl = process.env['OSRM_URL'] ?? OSRM_DEFAULT_URL;
  const osrm = osrmUrl === '' ? new NullOsrmClient() : new HttpOsrmClient({ baseUrl: osrmUrl });
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  try {
    const measured = await estate(db);
    const plates = await platesToSweep(db, args.limit);
    const traces = new TraceService(db, new PlateSearchService(db));
    const routes = new RouteService(db, osrm);

    const totals: Totals = {
      plates: plates.length,
      platesTraced: 0,
      segments: 0,
      evaluable: 0,
      impossible: 0,
      likelyMisread: 0,
      likelyCloned: 0,
      undetermined: 0,
      alerts: 0,
    };
    const reports: AnomalyReport[] = [];

    // **The totals count transitions, not queries.** Several distinct reads of one vehicle —
    // `GJ01AB1234`, `GJ01A81234`, `GJ01AB12`, `GJ01AB123` — are all fuzzy-resolved to the same
    // identity by D2-04's matcher, so each of them traces the *same* sightings and would contribute
    // the same segments again. Counting per query multiplied a 2-transition finding into 8 on the
    // first run of this sweep. The pair of sighting ids is the identity of a transition; a segment
    // already seen is skipped from the totals while its per-plate report is still printed.
    const seen = new Set<string>();
    for (const plate of plates) {
      const trace = await traces.trace(plate);
      if (trace.sightings.length < 2) continue;
      totals.platesTraced += 1;
      const route = await routes.reconstruct(trace, { persist: args.persist });
      const report = route.anomalies;
      reports.push(report);
      for (const f of report.findings) {
        const key = `${f.fromSightingId}>${f.toSightingId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        totals.segments += 1;
        if (f.feasibility !== 'indeterminate') totals.evaluable += 1;
        if (f.feasibility !== 'impossible') continue;
        totals.impossible += 1;
        if (f.explanation === 'likely_misread') totals.likelyMisread += 1;
        else if (f.explanation === 'likely_cloned') totals.likelyCloned += 1;
        else totals.undetermined += 1;
        if (f.alert !== null) totals.alerts += 1;
      }
    }

    if (args.json) {
      out(JSON.stringify({ estate: measured, totals, reports }, null, 2));
      return 0;
    }

    out('');
    out('impossible-transition sweep — the whole plate_reads table (D3-02 AC 8)');
    out('══════════════════════════════════════════════════════════════════════');
    out(`database              ${redactDatabase(env.DATABASE_URL)}`);
    out(`road graph            ${osrm.baseUrl}`);
    out(
      `policy                v${String(policy.version)} · max ${String(policy.speed.maxPlausibleKmh)} km/h · free-flow tolerance ×${String(policy.speed.graphSpeedTolerance)}`,
    );
    out('');
    out('the estate, measured');
    out(`  cameras             ${measured.cameras} (${measured.camerasPlaced} with coordinates)`);
    out(`  sightings           ${measured.sightings}`);
    out(
      `  plate reads         ${measured.plateReads} (${measured.plateReadsIdentified} carrying an identity)`,
    );
    out('');
    out('the sweep');
    out(`  plates swept        ${totals.plates}`);
    out(`  traced (>= 2 hits)  ${totals.platesTraced}`);
    out(`  segments examined   ${totals.segments}   <- distinct transitions, deduplicated by pair`);
    out(`  segments evaluable  ${totals.evaluable}   <- a road distance and a usable elapsed time`);
    out('');
    out('classification');
    out(`  impossible          ${totals.impossible}`);
    out(`    likely misread    ${totals.likelyMisread}`);
    out(`    likely cloned     ${totals.likelyCloned}`);
    out(`    undetermined      ${totals.undetermined}`);
    out(`  cloning alerts      ${totals.alerts}`);
    out('');

    if (args.perPlate) {
      for (const r of reports) {
        out(
          `  ${r.plate.padEnd(14)} segments ${String(r.segmentsExamined).padStart(3)} · evaluable ${String(r.segmentsEvaluable).padStart(3)} · impossible ${String(r.impossible).padStart(3)} (misread ${r.likelyMisread}, cloned ${r.likelyCloned}, undetermined ${r.undetermined})`,
        );
      }
      out('');
    }

    out(interpretation(measured, totals));
    out('');
    out(policyNote(totals));
    return 0;
  } finally {
    await rawSql.end({ timeout: 5 });
  }
}

/**
 * The honest reading of the numbers above, written by the sweep rather than left to the reader.
 *
 * There are three distinct zeros this report can print and they mean completely different things.
 * Collapsing them into "no anomalies found" is the failure mode; each has its own sentence.
 */
function interpretation(
  measured: Awaited<ReturnType<typeof estate>>,
  totals: Totals,
): string {
  if (measured.sightings === 0) {
    return (
      'interpretation: there are no sightings in this database, so nothing was swept. This is not\n' +
      '  a measurement of the detector and must not be quoted as one — it is a statement that the\n' +
      '  corpus is empty. Run the ingest pipeline, or seed the trace fixture\n' +
      '  (`npm run demo:trace -w packages/api -- --seed`), and run this again.'
    );
  }
  if (totals.evaluable === 0) {
    return (
      `interpretation: ${String(totals.segments)} transitions were examined and NONE could be assessed.\n` +
      `  ${String(measured.camerasPlaced)} of ${String(measured.cameras)} cameras carry coordinates, so no road distance exists between\n` +
      '  any pair and no travel time can be required of one. "0 impossible transitions" here means\n' +
      '  "0 transitions were testable", not "the estate is clean". Impossible-transition detection\n' +
      '  cannot fire on this estate until the camera catalogue carries positions.'
    );
  }
  if (totals.impossible === 0) {
    return (
      `interpretation: ${String(totals.evaluable)} of ${String(totals.segments)} transitions were assessable and none was impossible.\n` +
      '  Note the direction of the claim: the road distance used is the FASTEST path, a lower bound\n' +
      '  on the distance driven, so "feasible" means "not shown to be impossible" and not "verified".'
    );
  }
  const rate = (totals.impossible / Math.max(1, totals.evaluable)) * 100;
  const implausible = rate > 20;
  return (
    `interpretation: ${String(totals.impossible)} of ${String(totals.evaluable)} assessable transitions (${rate.toFixed(1)}%) are impossible.\n` +
    (implausible
      ? '  That rate is implausibly high for genuine cloning. Read it as an OCR-quality or clock\n' +
        '  finding first — a camera whose presentation clock is wrong produces this signature with no\n' +
        '  vehicle doing anything — and log it to BL-01 before claiming a cloning-detection capability.'
      : `  ${String(totals.likelyMisread)} favour a misread, ${String(totals.likelyCloned)} favour a duplicated registration, ${String(totals.undetermined)} are undetermined.\n` +
        '  None of these is a finding of cloning. There is no VAHAN or SARTHI link in this system, so\n' +
        '  no registration can be confirmed to exist or be traced to a holder.')
  );
}

function policyNote(totals: Totals): string {
  return (
    `${String(totals.alerts)} cloning alert(s) raised. An alert says two sightings are inconsistent with a single\n` +
    'vehicle. It is evidence for an officer to judge from two crops side by side, not a conclusion.'
  );
}

/** The connection string carries a password. Print the database name and nothing else. */
function redactDatabase(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '(unparseable)';
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
