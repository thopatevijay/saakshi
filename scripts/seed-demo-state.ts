/**
 * `npm run seed:demo-state` — the deployed instance a judge actually meets (D4-02).
 *
 * A judge opens the URL cold, once, briefly. An empty first screen is the whole impression, so the
 * state behind that URL has to be deliberate rather than whatever the last test left behind. This
 * script is that state, expressed as a command so it is reproducible instead of hand-made — and so
 * the claim "this is what the judges saw" can be re-run and checked.
 *
 * ## What it does, and what it refuses to do
 *
 * It **creates accounts and composes existing seeders**. It does not invent measurements. Every
 * number a judge sees still comes from the thing that produced it: `demo:alerts` replays D2-01's
 * real 5-minute ANPR run, `demo:trace` attaches real plate crops from `fixtures/plate-eval/crops`,
 * and trust bands come from a real prober pass (`python -m workers.prober.run`) rather than from
 * rows written here. This script will not fabricate a health check, a trust score or a sighting.
 *
 * ## Credentials
 *
 * Passwords are generated, never committed, and printed **once** to stdout so they can be copied
 * into `.dev-refs.md` and the submission form. Pass `--judge-password` / `--auditor-password` to
 * supply your own (for a re-run that must keep working credentials alive).
 *
 *   npm run seed:demo-state -- --env production
 *   npm run seed:demo-state -- --accounts-only
 *   npm run seed:demo-state -- --judge-password "$PW"
 *
 * `DATABASE_URL` decides which database is touched; `--env production` is a label that appears in
 * the output so an operator can see which one they just seeded, not a second source of truth.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

interface JudgeAccount {
  badgeNo: string;
  name: string;
  role: 'operator' | 'auditor';
  why: string;
  password: string;
}

/**
 * The seeded development users from migration `0009`, whose password is the published string
 * `saakshi-dev`. The seed's own header says D4-01 must not deploy them; the migration runner cannot
 * skip a file, so they arrive on every database and have to be retired here.
 */
const DEV_BADGES = ['GP-ADM-0001', 'GP-SUP-0100', 'GP-OPR-1042', 'GP-AUD-0007'];

/**
 * A password a human can retype off a submission form without ambiguity, and that a machine cannot
 * guess. No `0`/`O`, no `1`/`l`/`I`. 20 characters from a 32-symbol alphabet is 100 bits.
 */
function generatePassword(length = 20): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(bytes[i] as number) % alphabet.length];
  }
  return out;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required');
  }
  const label = flag('env') ?? 'local';

  const accounts: JudgeAccount[] = [
    {
      badgeNo: 'JUDGE-OPR-001',
      name: 'Screening Committee (Operator)',
      role: 'operator',
      // Forced, not chosen. The ticket requires a judge who cannot mutate the watchlist or delete a
      // camera but can acknowledge alerts and run traces. WRITE_ROLES = [admin, supervisor] gates
      // every watchlist mutation, so supervisor fails the first clause; auditor has neither
      // trace:run nor alerts:view, so it fails the second. operator is the only role left.
      why: 'reads the registry, runs traces, acknowledges alerts; cannot write anything',
      password: flag('judge-password') ?? generatePassword(),
    },
    {
      badgeNo: 'JUDGE-AUD-002',
      name: 'Screening Committee (Auditor)',
      role: 'auditor',
      // operator has no audit:read, so the chain-of-custody screen and the export bundle are
      // invisible to it. This second account exists for those, and for nothing else. Note that an
      // auditor is bounced to /forbidden on /alerts by the web shell (D2-07) - that is the RBAC
      // matrix working, and the walkthrough says so rather than letting a judge meet it cold.
      why: 'reads the audit chain and export bundles; no video, no trace, no alerts',
      password: flag('auditor-password') ?? generatePassword(),
    },
  ];

  const sql = postgres(databaseUrl, { max: 4, types: {}, onnotice: () => {} });

  try {
    const [dept] = await sql<{ id: string }[]>`
      select id from departments where code = 'POLICE' limit 1
    `;
    if (dept === undefined) throw new Error("no POLICE department - run migrations first");

    console.log('');
    console.log(`  database          ${label}`);
    console.log('');
    console.log('  judge accounts');

    for (const account of accounts) {
      await sql`
        insert into users (name, badge_no, role, department_id, password_hash, active)
        values (
          ${account.name}, ${account.badgeNo}, ${account.role}::user_role, ${dept.id},
          crypt(${account.password}, gen_salt('bf')), true
        )
        on conflict (badge_no) do update
          set password_hash = excluded.password_hash,
              role          = excluded.role,
              name          = excluded.name,
              active        = true
      `;
      console.log(`    ${account.badgeNo.padEnd(14)} ${account.role.padEnd(10)} ${account.password}`);
      console.log(`    ${''.padEnd(14)} ${account.why}`);
    }

    // Retiring rather than deleting: `audit_log` rows reference the actor, and a deleted user turns
    // a readable audit trail into a column of orphaned UUIDs. `active = false` is what the login
    // query already checks (`routes/auth.ts` filters on it), so this closes the door without
    // rewriting history.
    const retired = await sql`
      update users set active = false
      where badge_no in ${sql(DEV_BADGES)} and active = true
      returning badge_no
    `;
    console.log('');
    console.log(`  retired dev users ${String(retired.length)} of ${String(DEV_BADGES.length)} (password 'saakshi-dev' no longer works)`);
    for (const row of retired) console.log(`    ${String((row as { badge_no: string }).badge_no)}`);

    if (!has('accounts-only')) {
      const counts = await sql<{ k: string; v: number }[]>`
        select 'cameras' as k, count(*)::int as v from cameras
        union all select 'placed', count(location)::int from cameras
        union all select 'trust-scored', count(*)::int from cameras where trust_score is not null
        union all select 'health checks', count(*)::int from camera_health_checks
        union all select 'sightings', count(*)::int from sightings
        union all select 'plate reads', count(*)::int from plate_reads
        union all select 'watchlist', count(*)::int from watchlist_entries
        union all select 'alerts', count(*)::int from alerts
        union all select 'audit rows', count(*)::int from audit_log
      `;
      console.log('');
      console.log('  demo state');
      for (const row of counts) console.log(`    ${row.k.padEnd(16)} ${String(row.v)}`);

      const missing = counts.filter((c) => c.v === 0).map((c) => c.k);
      if (missing.length > 0) {
        console.log('');
        console.log(`  EMPTY: ${missing.join(', ')}`);
        console.log('  The judge-facing screens for these are blank. Fill them with the seeders that');
        console.log('  own them - this script deliberately does not fabricate measurements.');
        console.log('');
        console.log('  THE ORDER MATTERS, and the failure is not obvious:');
        console.log('');
        console.log('    1. npm run seed:watchlist');
        console.log('    2. npm run demo:trace -w @saakshi/api -- --remove');
        console.log('    3. npm run demo:alerts -- --seed');
        console.log('    4. npm run demo:trace -w @saakshi/api -- --seed --clone');
        console.log('    5. python -m workers.prober.run --once --all --pool 10');
        console.log('    6. npm run trust:recompute');
        console.log('');
        console.log('  Steps 2 and 4 bracket step 3 because `demo:alerts` round-robins its 17');
        console.log('  measured reads over EVERY camera that has any sighting, and asks for the');
        console.log('  n-th sighting on each. The TRACEFIX-* fixture cameras have 1-3 sightings');
        console.log('  apiece, so once they exist the seeder picks one and dies with');
        console.log('  "camera TRACEFIX-CAM-C has no sighting at offset 2" - which reads like a');
        console.log('  corrupt database rather than an ordering problem. Removing the trace');
        console.log('  fixtures first leaves only the measured cameras to choose from.');
        console.log('');
        console.log('  Step 5 is what gives every trust screen a band. A database that is migrated');
        console.log('  and synced but never probed shows "Never probed" everywhere (D3-07).');
      }
    }

    console.log('');
    console.log('  Passwords are shown once and are not stored anywhere by this script.');
    console.log('  Copy them into .dev-refs.md (gitignored) and the submission form.');
    console.log('');
  } finally {
    await sql.end();
  }
}

await main();
