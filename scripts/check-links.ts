/**
 * `npm run check:links` — the broken-image sweep for the deployed console (D4-02).
 *
 * A judge opening a page to a row of broken image icons draws one conclusion, and it is not about
 * image hosting. This is the check that stops that happening, and it is deliberately **not** a
 * browser crawl: the things that break here are signed URLs and role-gated routes, and both are
 * checkable directly and deterministically.
 *
 * ## Why the crop URLs are the point
 *
 * Evidence crops reach the browser as **presigned S3 URLs** minted per request — SigV4 binds the
 * Host header, so a crop signed for `minio.railway.internal` is correctly signed and completely
 * unloadable from outside the private network. The failure is invisible server-side: the API returns
 * 200 with a URL in it, and only the browser discovers there is nothing there. So every crop URL the
 * API hands out is fetched here, exactly as a browser would (D4-01 § 3.1).
 *
 *   npm run check:links -- --base https://<web-domain> --api https://<api-domain>
 *   npm run check:links -- --base http://localhost:3000 --api http://localhost:4000
 *
 * Credentials come from `JUDGE_BADGE` / `JUDGE_PASSWORD`, or `--badge` / `--password`. Exits
 * non-zero if anything is broken, so it can gate a deploy.
 */
export {};

const args = process.argv;

function flag(name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i !== -1) {
    const v = args[i + 1];
    if (v !== undefined && !v.startsWith('--')) return v;
  }
  return fallback;
}

const base = flag('base', 'http://localhost:3000') as string;
const api = flag('api', 'http://localhost:4000') as string;
const badge = flag('badge', process.env['JUDGE_BADGE'] ?? 'JUDGE-OPR-001') as string;
const password = flag('password', process.env['JUDGE_PASSWORD']);

if (password === undefined || password === '') {
  console.error('a judge password is required: --password <pw> or JUDGE_PASSWORD');
  process.exit(2);
}

interface Result {
  what: string;
  url: string;
  status: number | string;
  ok: boolean;
  note?: string;
}

const results: Result[] = [];

async function check(what: string, url: string, headers: Record<string, string> = {}): Promise<void> {
  try {
    // GET, not HEAD. A presigned S3 signature covers the method, so a HEAD against a URL signed for
    // GET returns 403 and would report every working crop as broken.
    const res = await fetch(url, { headers, redirect: 'manual' });
    // 3xx from the web app is the login redirect - for a page that means the session did not carry,
    // which is a real failure of this sweep rather than a passing page.
    const ok = res.status >= 200 && res.status < 300;
    results.push({ what, url, status: res.status, ok });
  } catch (err) {
    results.push({ what, url, status: 'network', ok: false, note: String(err) });
  }
}

async function main(): Promise<void> {
  const loginRes = await fetch(`${api}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ badgeNo: badge, password }),
  });
  if (!loginRes.ok) {
    console.error(`login failed for ${badge}: HTTP ${String(loginRes.status)}`);
    process.exit(2);
  }
  const { token } = (await loginRes.json()) as { token: string };
  const bearer = { authorization: `Bearer ${token}` };
  const cookie = { cookie: `saakshi_session=${token}; saakshi_role=operator` };

  // 1 · the routes a judge is told to visit
  for (const path of ['/login', '/registry', '/trace', '/alerts', '/video-wall', '/evidence', '/sizing']) {
    await check(`page ${path}`, `${base}${path}`, cookie);
  }

  // 2 · the basemap, without which the compulsory GIS deliverable is a grey box
  await check('basemap pmtiles', `${base}/basemap/gujarat.pmtiles`, { ...cookie, range: 'bytes=0-1023' });
  for (const stack of ['Noto_Sans_Regular', 'Noto_Sans_Medium']) {
    await check(`glyphs ${stack}`, `${base}/basemap/fonts/${stack}/0-255.pbf`, cookie);
  }

  // 3 · every signed crop URL the API will hand a browser
  const alertsRes = await fetch(`${api}/api/v1/alerts?limit=100`, { headers: bearer });
  if (alertsRes.ok) {
    const body = (await alertsRes.json()) as { data?: { id: string; evidence?: { cropUrl?: string | null } }[] };
    for (const alert of body.data ?? []) {
      const url = alert.evidence?.cropUrl;
      if (url !== undefined && url !== null && url !== '') {
        await check(`alert crop ${alert.id.slice(0, 8)}`, url);
      }
    }
  }

  const plate = flag('plate', 'GJ01AB1234') as string;
  const traceUrl = `${api}/api/v1/trace?plate=${encodeURIComponent(plate)}&purpose=${encodeURIComponent('D4-02 link sweep')}`;
  const traceRes = await fetch(traceUrl, { headers: bearer });
  if (traceRes.ok) {
    // `id` is not guaranteed on a trace stop - the shape carries the sighting's identity under
    // different keys depending on how it was linked - so the label falls back to an index rather
    // than assuming a field and throwing on the one response that lacks it.
    const body = (await traceRes.json()) as {
      sightings?: { id?: string; sightingId?: string; cropUrl?: string | null }[];
    };
    for (const [i, stop] of (body.sightings ?? []).entries()) {
      if (stop.cropUrl !== undefined && stop.cropUrl !== null && stop.cropUrl !== '') {
        const label = (stop.id ?? stop.sightingId ?? String(i)).slice(0, 8);
        await check(`trace crop ${label}`, stop.cropUrl);
      }
    }
  }

  const broken = results.filter((r) => !r.ok);
  const crops = results.filter((r) => r.what.includes('crop'));

  console.log('');
  console.log(`  base              ${base}`);
  console.log(`  api               ${api}`);
  console.log(`  as                ${badge}`);
  console.log('');
  console.log(`  checked           ${String(results.length)}`);
  console.log(`  crop URLs         ${String(crops.length)}`);
  console.log(`  broken            ${String(broken.length)}`);
  console.log('');

  for (const r of broken) {
    console.log(`  BROKEN  ${r.what}  HTTP ${String(r.status)}`);
    console.log(`          ${r.url.slice(0, 140)}`);
    if (r.note !== undefined) console.log(`          ${r.note}`);
  }

  if (crops.length === 0) {
    console.log('  NOTE: no crop URLs were returned at all — the evidence panels are empty, which a');
    console.log('        sweep of zero links cannot distinguish from a sweep that passed.');
  }

  process.exit(broken.length === 0 ? 0 : 1);
}

await main();
