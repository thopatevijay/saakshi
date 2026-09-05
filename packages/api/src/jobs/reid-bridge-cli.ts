/**
 * `npm run reid:bridge -w @saakshi/api -- --plate GJ01AB1234 --purpose "FIR 123/2026"`
 *
 * Runs the vehicle appearance bridge (D3-03) for one registration: builds a gallery from the
 * sightings whose plate was actually read, gates every unclaimed best-shot sighting against the
 * D3-01 travel-time model, compares appearance only for the survivors, and writes the links it
 * finds into `identity_sightings` as `reid_bridge`.
 *
 * ## Why this is a job and not something the trace endpoint does
 *
 * A `GET` must not write. A bridge writes evidence rows and appends to the tamper-evident audit
 * chain, and both of those are acts somebody has to be accountable for — which is why `--purpose`
 * is mandatory here exactly as it is on `/api/v1/trace` (D3-04). Running it as a job also means the
 * links are *durable*: the trace reads them back, an export bundle carries them, and an auditor can
 * see when they were created and by whom, rather than watching them appear and vanish per request.
 *
 * ## It refuses to run unless someone turned it on
 *
 * `REID_ENABLED` defaults to false because held-out precision measured **0.761** on
 * `fixtures/reid-eval`, below D3-03's 0.9 bar. `--force` overrides for a measurement run and says
 * so loudly on the way past; it does not change the threshold, and it does not change the number.
 */
import { sql } from 'drizzle-orm';
import { createDb, createSql } from '../db/client.js';
import { loadEnv } from '../env.js';
import { HttpOsrmClient, NullOsrmClient, OSRM_DEFAULT_URL } from '../services/osrm.js';
import { PlateSearchService } from '../services/plate-search.js';
import { TraceService } from '../services/trace.js';
import {
  REID_DISCLAIMER,
  REID_MEASURED_PRECISION,
  ReidBridgeService,
  reidConfigFromEnv,
} from '../services/reid.js';

interface Args {
  plate: string;
  purpose: string;
  force: boolean;
  dryRun: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = { plate: '', purpose: '', force: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--plate') args.plate = argv[++i] ?? '';
    else if (flag === '--purpose') args.purpose = argv[++i] ?? '';
    else if (flag === '--force') args.force = true;
    else if (flag === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (args.plate === '') {
    console.error('usage: reid:bridge --plate <registration> --purpose "<why>" [--dry-run] [--force]');
    return 2;
  }
  if (args.purpose.trim().length < 3) {
    // The same rule the endpoint enforces. A bridge with no stated reason is not auditable, and an
    // unauditable write to an evidentiary route is worse than no write at all.
    console.error('a purpose is required — it is written into the audit chain with this run');
    return 2;
  }

  const env = loadEnv(process.env);
  const config = reidConfigFromEnv(process.env);
  if (!config.enabled && !args.force) {
    console.error(
      `re-ID is disabled (REID_ENABLED is not "true").\n` +
        `  Held-out precision measured ${REID_MEASURED_PRECISION.toFixed(3)} on fixtures/reid-eval,\n` +
        `  below D3-03's 0.9 bar. Pass --force to run anyway, or set REID_ENABLED=true.`,
    );
    return 1;
  }
  if (!config.enabled) {
    console.warn(
      `--force: running a feature measured at ${REID_MEASURED_PRECISION.toFixed(3)} precision. ` +
        `Roughly one link in four will be wrong.`,
    );
  }

  const rawSql = createSql(env.DATABASE_URL, 4);
  const db = createDb(rawSql);
  const osrmUrl = process.env['OSRM_URL'] ?? OSRM_DEFAULT_URL;
  const osrm = osrmUrl === '' ? new NullOsrmClient() : new HttpOsrmClient({ baseUrl: osrmUrl });

  try {
    const trace = await new TraceService(db, new PlateSearchService(db)).trace(args.plate);
    if (trace.sightings.length === 0) {
      console.log(`no plate-read sightings for ${args.plate} — nothing to anchor a bridge to`);
      return 0;
    }

    const service = new ReidBridgeService(db, osrm, { ...config, enabled: true });
    const result = await service.bridge(trace, {
      persist: !args.dryRun,
      purpose: args.purpose,
    });

    console.log(`plate                ${result.canonicalPlate}`);
    console.log(`anchors              ${result.anchors} (${result.anchorsWithEmbedding} embedded)`);
    console.log(`candidates           ${result.candidatesConsidered}`);
    console.log(`gated out            ${result.pairsGatedOut}  <- before any appearance comparison`);
    console.log(`compared             ${result.pairsCompared}`);
    console.log(`linked               ${result.links.length}`);
    console.log(`written              ${result.written}${args.dryRun ? ' (dry run)' : ''}`);
    for (const link of result.links) {
      console.log(
        `  ${link.sightingId}  sim ${link.similarity.toFixed(4)}  conf ${link.linkConfidence.toFixed(3)}  ${link.gate}`,
      );
      console.log(`    ${link.explanation}`);
    }
    console.log(`\n${REID_DISCLAIMER}`);

    // Sanity, printed rather than assumed: how many links this identity now carries by method.
    const byMethod = await db.execute<{ link_method: string; n: string }>(
      sql`select isg.link_method, count(*)::text as n
            from identity_sightings isg
            join vehicle_identities vi on vi.id = isg.identity_id
           where vi.canonical_plate = ${result.canonicalPlate}
           group by isg.link_method order by isg.link_method`,
    );
    for (const row of byMethod) console.log(`stored ${row.link_method.padEnd(14)} ${row.n}`);
    return 0;
  } finally {
    await rawSql.end({ timeout: 5 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
