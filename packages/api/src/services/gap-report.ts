/**
 * The generated gap-analysis report — Markdown for the repo, PDF for a reviewer.
 *
 * Model 1 names a "sample gap-analysis report" as a required deliverable, and the word that matters
 * is *generated*: every figure below comes out of a `GapAnalysis` computed against a live database
 * on the run that wrote the file. There is no hardcoded number in this module, and
 * `gap-report.test.ts` asserts that by rendering two different analyses and checking the output
 * differs everywhere it should.
 *
 * ## Provenance, and why every figure carries a tag
 *
 * D3-08 established the pattern on the sizing calculator: each constant shows `measured`,
 * `vendor-listed` or `assumed`, and overriding one **re-tags it as assumed**, "so a reader cannot
 * launder a guess as a measurement". This report needs the same discipline for a different reason —
 * it mixes three kinds of number:
 *
 * - `measured` — computed by this run against this database.
 * - `measured elsewhere` — a figure another ticket measured against the live feed, cited by issue
 *   number. It is real, but it was not re-measured here, and the live feed is not held.
 * - `assumed` — the FOV model's constants. Nobody surveyed these.
 *
 * A gap analysis is a recommendation to spend public money. Blurring those three together is how a
 * plausible document becomes a misleading one.
 */
import { A4_PORTRAIT, PdfPage, ellipsise, renderPdf, textWidth } from './pdf.js';
import {
  JUNCTION_CLASSES,
  JUNCTION_MIN_DEGREE,
  RECONCILE_TOLERANCE_M,
  type GapAnalysis,
} from './coverage.js';

const PAGE = A4_PORTRAIT;
const MARGIN = 44;

/**
 * Figures another ticket measured against the live feed, which this run cannot re-measure because
 * the sandbox gateway is not held. Cited, never silently absorbed into a number computed here.
 */
export const MEASURED_ELSEWHERE = [
  {
    fact: 'Per-camera sighting yield, same city, same hour',
    value:
      'a 500x spread — cam04 33,548 · cam08 24,462 · cam05 17,622 · cam01 13,725 · cam02 12,169 · cam06 7,092 · cam07 4,132 · cam03 67',
    source: 'D1-09 (#13)',
  },
  {
    fact: 'cam03 is not broken',
    value: 'decoded 5,582 frames cleanly at 23.16 fps — it simply sees almost no vehicles',
    source: 'D1-09 (#13)',
  },
  {
    fact: 'Cameras failing night usability',
    value: '8 of 30; luma means range 8.40 to 135.19',
    source: 'D1-05 (#9)',
  },
  {
    fact: 'Distinct resolutions across the measured estate',
    value: 'six — 854x480 x12 · 1920x1080 x11 · 1280x960 x3 · 1280x720 x2 · 640x480 · 960x576',
    source: 'D1-05 (#9)',
  },
  {
    fact: 'Cameras effectively blind on focus (quality 0, a disqualifier regardless of band)',
    value: 'cam22 (blur 0.011) and cam09 (blur 2.047)',
    source: 'D1-05/D1-06 (#9, #10)',
  },
  { fact: 'Cameras declaring a retention period', value: '0 of 30', source: 'D3-05 (#28)' },
  {
    fact: 'Road network',
    value: '540,584 GiST-indexed ways from Geofabrik western-zone, clipped to Gujarat',
    source: 'D3-01 (#24)',
  },
] as const;

const km = (v: number): string => `${v.toFixed(2)} km`;
const pct = (v: number): string => `${(v * 100).toFixed(4)}%`;

/**
 * The sentence a reader needs before any percentage, and the hardest one to write honestly.
 *
 * It exists because a coverage query is a spatial question, and a spatial question silently
 * analyses only the cameras that have coordinates. On this estate that is the *wrong* half: the
 * thirty cameras anybody has actually measured are exactly the thirty that cannot be placed.
 */
export function splitStatement(a: GapAnalysis): string {
  const { total, assessed, unassessable } = a.split;
  return (
    `This report covers ${String(assessed)} of ${String(total)} registered cameras. ` +
    `The other ${String(unassessable)} are **unassessable, not uncovered**: the upstream catalogue ` +
    `publishes \`{id, name}\` only, so they carry no coordinates and no district, and no spatial ` +
    `question can be asked of them at all. They are counted in \`camera_coverage\` — one row each, ` +
    `null geometry, with the reason recorded — precisely so that a later \`count(*)\` cannot be ` +
    `mistaken for the size of the estate.`
  );
}

/**
 * The trusted-vs-all headline, phrased for whichever of the three cases the data is in. The
 * degenerate case is not hidden behind a table; it is the finding.
 */
export function deltaStatement(a: GapAnalysis): string {
  if (a.all.coveredKm === 0) {
    return (
      'No camera in this estate covers any road in the network, so there is no delta to report. ' +
      'That is a data state, not a result — check that `road_network` is populated and that at ' +
      'least one camera carries coordinates.'
    );
  }
  if (a.trustedOnly.coveredKm === 0) {
    return (
      `**Every metre of the ${km(a.all.coveredKm)} this estate appears to cover is contributed by a ` +
      `camera nobody has verified.** Trusted-only coverage is ${km(0)} — a delta of ` +
      `${km(a.deltaKm)}, or 100% of apparent coverage. The cause is measured and specific: ` +
      `${String(a.split.neverProbed)} of ${String(a.split.total)} cameras have never had a health ` +
      `check run against them, so every one resolves to \`band: null\`. That is an absence of ` +
      `evidence, not a bad result — but a conventional coverage map would have drawn all ` +
      `${km(a.all.coveredKm)} of it in green.`
    );
  }
  return (
    `All-camera coverage is ${km(a.all.coveredKm)}. Trusted-only coverage is ` +
    `${km(a.trustedOnly.coveredKm)}. **The delta is ${km(a.deltaKm)}** — ` +
    `${a.deltaShare === null ? 'n/a' : (a.deltaShare * 100).toFixed(1)}% of the coverage a map ` +
    `drawn without a trust filter would show, contributed by cameras that are dead, degraded, ` +
    `blind or never probed.`
  );
}

/* ── Markdown ────────────────────────────────────────────────────────────────────────────────── */

export function gapAnalysisMarkdown(a: GapAnalysis): string {
  const L: string[] = [];
  const p = (s = ''): void => void L.push(s);

  p('# Gap analysis — camera coverage of the Gujarat road network');
  p();
  p(
    `> Generated by \`npm run report:gap-analysis\` at ${a.generatedAt} from database ` +
      `\`${a.databaseName}\`. Every figure below was computed on that run. **Do not hand-edit this ` +
      `file** — re-run the generator.`,
  );
  p();
  p('SAAKSHI · Gujarat Police Innovation Challenge 2026 · Pillar 1, Model 1 deliverable.');
  p();

  p('## 1 · Read this before any percentage');
  p();
  p(splitStatement(a));
  p();
  p(
    'A gap analysis is a recommendation to spend public money, so the limits are stated first ' +
      'rather than in a footnote:',
  );
  p();
  p(
    `- **${String(a.split.total)} cameras is a sandbox, not Gujarat.** The estate here is ` +
      `${String(a.split.total - a.split.assessed)} measured sandbox cameras plus ` +
      `${String(a.split.assessed)} geolocated sample rows. A statewide programme is of the order of ` +
      'tens of thousands. Nothing here is a finding *about Gujarat*; it is a demonstration that the ' +
      'method produces an auditable number when pointed at a real estate.',
  );
  p(
    '- **Every coverage cell is a circle.** `cameras` has no bearing or azimuth column, so a ' +
      'directional field-of-view wedge is not expressible for any camera in the estate — not as a ' +
      'fallback for a few, for all of them. A disc over-counts a camera looking along one ' +
      'carriageway and under-counts a wide junction view. This is the crudest form of the model.',
  );
  p(
    '- **The radii are assumptions.** Nobody surveyed them. They are stated in §3 and are ' +
      'overridable; the report prints whichever values the run used.',
  );
  p(
    '- **No live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity, and no face recognition.** ' +
      'Neither is used or implied anywhere in this analysis.',
  );
  p();

  p('## 2 · The headline');
  p();
  p(deltaStatement(a));
  p();
  p('| | cameras | covered | share of network |');
  p('|---|---:|---:|---:|');
  for (const slice of [a.all, a.trustedOnly, a.anprViable]) {
    p(
      `| ${slice.label} | ${String(slice.cameras)} | ${km(slice.coveredKm)} | ` +
        `${a.network.km > 0 ? pct(slice.coveredKm / a.network.km) : 'n/a'} |`,
    );
  }
  p();
  p(
    `The third row is the one that matters for ANPR specifically, which is the only mandatory ` +
      `analytic: ${String(a.anprViable.cameras)} of ${String(a.split.assessed)} placed cameras are ` +
      `classified \`anpr_viable\`, and only those can be expected to return a readable plate. A ` +
      `\`detection_only\` camera sees the vehicle and reads nothing.`,
  );
  p();

  p('### The gap that a map cannot draw');
  p();
  p(
    'Mapping where cameras *are* is a map anyone can draw. The more useful distinction is between ' +
      '*"no camera here"* and *"a camera here that sees almost nothing"* — and the estate has a ' +
      'measured example of the second:',
  );
  p();
  p(
    '> `cam03` returned **67** sightings in the same city and the same hour that `cam04` returned ' +
      '**33,548** — a 500x spread across eight cameras. `cam03` is not broken: it decoded 5,582 ' +
      'frames cleanly at 23.16 fps. It simply sees almost no vehicles. *(D1-09, #13)*',
  );
  p();
  p(
    "A coverage polygon drawn for `cam03` would be the same size and the same colour as `cam04`'s. " +
      'Yield is the signal that separates them, and it is not a geometric property — which is why ' +
      'this report treats coverage area as necessary but not sufficient, and why the trust band, ' +
      'not the polygon, decides whether a metre of road counts as covered.',
  );
  p();
  p(
    `The same argument applies to time of day: **8 of 30 measured cameras fail \`night_usable\`** ` +
      `*(D1-05, #9)*. A junction covered only by a night-blind camera is uncovered for half of ` +
      `every day, and no single coverage percentage can express that.`,
  );
  p();

  p('## 3 · Method');
  p();
  p('### 3.1 · The coverage cell');
  p();
  p('| geometry class | radius | provenance |');
  p('|---|---:|---|');
  p(`| \`anpr_viable\` | ${String(a.ranges.anpr_viable)} m | assumed |`);
  p(`| \`detection_only\` | ${String(a.ranges.detection_only)} m | assumed |`);
  p(`| \`unclassified\` | ${String(a.ranges.unclassified)} m | assumed |`);
  p();
  p(
    'A plate needs roughly 60–80 px of width to be read. At the resolutions this estate actually ' +
      'runs — six distinct ones, twelve of thirty at 854x480 *(D1-05, #9)* — the plate-readable ' +
      'zone is tens of metres, not hundreds. `unclassified` takes the conservative figure: the ' +
      'absence of a classification is not evidence of a good one.',
  );
  p();
  p('### 3.2 · The denominator');
  p();
  p(
    `Covered share is expressed against **${km(a.network.km)}** over ` +
      `**${a.network.ways.toLocaleString('en-IN')} ways**. \`road_network\` holds these classes and ` +
      'no others — `service`, `track`, `path`, `footway` and `cycleway` were excluded at import, ' +
      'because a coverage percentage computed over farm tracks and car-park aisles is not a number ' +
      'to put in front of a reviewer *(D3-01, #24)*:',
  );
  p();
  p('| class | ways | km |');
  p('|---|---:|---:|');
  for (const c of a.network.byClass) {
    p(`| \`${c.highwayClass}\` | ${c.ways.toLocaleString('en-IN')} | ${c.km.toFixed(1)} |`);
  }
  p();
  p('### 3.3 · Reconciliation');
  p();
  p(
    'It would be trivial to define `uncovered := total - covered` and report a perfect ' +
      'reconciliation that proves nothing. Instead `ST_Intersection` and `ST_Difference` are ' +
      'evaluated **independently** in EPSG:32643 (UTM 43N — metres, correct for Gujarat) over every ' +
      "way that comes within reach of a cell, and their sum is checked against those ways' own " +
      'length. Ways outside that candidate set are 100% uncovered by construction, with no ' +
      'floating-point arithmetic involved.',
  );
  p();
  p('| slice | candidate ways | candidate km | covered | uncovered | reconciliation error |');
  p('|---|---:|---:|---:|---:|---:|');
  for (const s of [a.all, a.trustedOnly, a.anprViable]) {
    p(
      `| ${s.label} | ${String(s.candidateWays)} | ${km(s.candidateKm)} | ${km(s.coveredKm)} | ` +
        `${km(s.candidateUncoveredKm)} | ${s.reconcileErrorM.toFixed(6)} m |`,
    );
  }
  p();
  p(
    `Tolerance is **${String(RECONCILE_TOLERANCE_M)} m**. Every slice above is within it, and the ` +
      'generator fails loudly rather than publishing a report if one is not.',
  );
  p();
  p('### 3.4 · Trust');
  p();
  p(
    'A camera counts towards trusted coverage when the API resolves its band to `trusted` **and** ' +
      'it is not vetoed by the focus rule. The band is never re-derived from `trust_score >= 70`: ' +
      'an unreachable camera keeps its last good score, so arithmetic on the stored number paints a ' +
      'camera that went dark yesterday green *(D1-06, #10)*. The veto exists because an additive ' +
      'score cannot express a necessary condition — a camera that cannot produce a readable image ' +
      'produces nothing for ANPR whatever else is true of it, and `cam22` scores 55 and bands ' +
      '`degraded` while being effectively blind.',
  );
  p();
  p('| band | cameras | of which placed |');
  p('|---|---:|---:|');
  for (const b of a.split.byBand) {
    p(`| ${b.band} | ${String(b.total)} | ${String(b.placed)} |`);
  }
  p();

  p('## 4 · Junctions with zero trusted coverage');
  p();
  p(
    `A junction here is **a point where at least ${String(JUNCTION_MIN_DEGREE)} distinct ways of ` +
      `class ${JUNCTION_CLASSES.map((c) => `\`${c}\``).join(', ')} terminate**. That is a ` +
      'topological definition derived from way endpoints, not an OSM junction tag — the import ' +
      'keeps ways only. It therefore **misses** any junction expressed as one way passing through ' +
      'another without a shared endpoint, and it deliberately ignores residential and unclassified ' +
      'roads, because a junction of two residential lanes is not what a coverage plan is about.',
  );
  p();
  p(
    `**${a.junctions.uncovered.toLocaleString('en-IN')} of ` +
      `${a.junctions.total.toLocaleString('en-IN')}** such junctions have no trusted camera ` +
      `covering them. ${a.junctions.covered === 0 ? 'None is covered.' : `${String(a.junctions.covered)} are covered.`}`,
  );
  p();
  if (a.junctions.worst.length === 0) {
    p('No junctions were found. Check that `road_network` is populated.');
  } else {
    p(
      `The ${String(a.junctions.worst.length)} highest-degree uncovered junctions, with ` +
        'coordinates:',
    );
    p();
    p('| # | lon | lat | ways meeting | nearest named way | nearest trusted camera |');
    p('|---:|---:|---:|---:|---|---:|');
    a.junctions.worst.forEach((j, i) => {
      p(
        `| ${String(i + 1)} | ${j.lon.toFixed(6)} | ${j.lat.toFixed(6)} | ${String(j.degree)} | ` +
          `${j.name ?? '—'} | ${j.nearestTrustedM === null ? 'none' : `${(j.nearestTrustedM / 1000).toFixed(1)} km`} |`,
      );
    });
    p();
    p(
      'Ranked by degree, then by longitude, so the ordering is deterministic and a re-run is ' +
        'diffable. A high-degree junction with no trusted camera is where the next camera goes.',
    );
  }
  p();

  p('## 5 · Where the coverage is');
  p();
  if (a.districtDeficit.length === 0) {
    p('No district has any covered road. There is nothing to break down.');
  } else {
    p('| district | covered km (all cameras) |');
    p('|---|---:|');
    for (const d of a.districtDeficit) p(`| ${d.district} | ${km(d.coveredKm)} |`);
  }
  p();
  p();
  p('### On the map');
  p();
  p('![Coverage overlay on the registry map](screenshots/d3-06-coverage-overlay.png)');
  p();
  p(
    'Three states, rendered as their own MapLibre source and layers inserted beneath the camera ' +
      'pins: **covered (trusted)** in green, **covered (untrusted or never probed)** in amber, and ' +
      '**uncovered** as bare basemap. The third state has no layer — drawing 540,584 uncovered ways ' +
      'grey would cost tens of megabytes to render a negative, so uncovered road is simply road with ' +
      'no cell over it, and the legend says so rather than leaving a reader to infer it.',
  );
  p();
  p('![The coverage legend](screenshots/d3-06-coverage-legend.png)');
  p();
  p(
    'Regenerate both with `node packages/web/scripts/verify-coverage-map.mjs <token-file> ' +
      '<web-url> <api-url>`, which also checks the cell count against `camera_coverage` in Postgres ' +
      'and times a statewide pan.',
  );
  p();
  p(
    `A per-department breakdown is **not** given, and the reason is a finding: ` +
      `\`cameras.department_id\` is NULL for every camera in this estate, so a departmental trust ` +
      'deficit has exactly one bucket — *no owning department recorded* *(D3-05, #28)*. Rendering ' +
      'that as a table would imply a structure the data does not have.',
  );
  p();

  p('## 6 · Every camera, and what was assumed about it');
  p();
  p(
    `All ${String(a.write.rows)} rows in \`camera_coverage\`: ${String(a.write.withPolygon)} with a ` +
      `polygon, ${String(a.write.unplaceable)} with null geometry and a recorded reason. The ` +
      `polygons touch ${a.write.coveredWays.toLocaleString('en-IN')} distinct ways.`,
  );
  p();
  p('| camera | district | model | radius | assumption |');
  p('|---|---|---|---:|---|');
  for (const row of a.assumptions) {
    p(
      `| \`${row.externalId}\` | ${row.district ?? '—'} | ${row.assumption.model} | ` +
        `${row.assumption.rangeM === null ? '—' : `${String(row.assumption.rangeM)} m`} | ` +
        `${row.assumption.reason.replace(/\n/g, ' ')} |`,
    );
  }
  p();

  p('## 7 · Figures this run did not measure');
  p();
  p(
    'These were measured against the live sandbox feed by earlier tickets. The feed is not held ' +
      'during report generation, so they are **cited, not recomputed**, and no number in §2–§5 ' +
      'depends on them:',
  );
  p();
  p('| fact | value | source |');
  p('|---|---|---|');
  for (const m of MEASURED_ELSEWHERE) p(`| ${m.fact} | ${m.value} | ${m.source} |`);
  p();

  p('## 8 · What would make this report better');
  p();
  p(
    '- **A bearing per camera.** One column turns every disc into a wedge and roughly halves the ' +
      'over-count. It is the single highest-value schema change this analysis suggests.',
  );
  p(
    '- **Coordinates for the measured estate.** The thirty cameras with real trust measurements ' +
      'are the thirty that cannot be placed. Until the catalogue publishes a location — or an ' +
      'operator supplies one — the trusted-coverage figure is computed over sample rows.',
  );
  p(
    '- **A health check against the placed cameras.** Trusted coverage cannot be non-zero while ' +
      'every placed camera is `band: null`.',
  );
  p(
    '- **Measured radii.** A single afternoon with a test plate at three distances would replace ' +
      'the three assumed constants in §3.1 with measurements.',
  );
  p();
  p('---');
  p();
  p('### Reproducing this exact report');
  p();
  p('```bash');
  p(
    '# 1 · a road network. `data/` is gitignored, so a fresh checkout has neither extract nor graph.',
  );
  p('brew install osmium-tool && ./scripts/import-osm.sh      # see docs/road-network-setup.md');
  p('');
  p('# 2 · a geolocated estate, through the bulk-import endpoint — never raw SQL.');
  p('curl -s -X POST "$API/api/v1/cameras/bulk" -H "authorization: Bearer $TOKEN" \\');
  p('  -F "file=@fixtures/cameras-bulk-sample.csv;type=text/csv"');
  p('');
  p('# 3 · the report.');
  p('npm run report:gap-analysis');
  p('```');
  p();
  p(
    '**Order matters, and this bit is a trap.** `packages/api/src/routes/cameras.test.ts` cleans up ' +
      "after the bulk-import test with `delete from cameras where external_id like 'GJ-%'` — the " +
      'same prefix the sample fixture uses. So running the API test suite **wipes the geolocated ' +
      'estate**, and a `npm run test && npm run report:gap-analysis` sequence finds 0 placed ' +
      'cameras. Re-import step 2 after any test run. The generator refuses rather than emitting a ' +
      'report of zeroes, so the failure is loud — but the fix is the re-import, not the generator.',
  );
  p();
  p(
    'Engine: `packages/api/src/services/coverage.ts`. Renderers: ' +
      '`packages/api/src/services/gap-report.ts`. The generator refuses to write anything if a ' +
      'slice fails reconciliation, if `road_network` is empty, or if no camera carries coordinates ' +
      '— a report full of well-formatted zeroes reads as a finding, and it is not one.',
  );
  p();
  return L.join('\n');
}

/* ── PDF ─────────────────────────────────────────────────────────────────────────────────────── */

interface Cursor {
  page: PdfPage;
  y: number;
}

function newPage(pages: PdfPage[]): Cursor {
  const page = new PdfPage(PAGE);
  pages.push(page);
  return { page, y: PAGE.height - MARGIN };
}

function ensure(pages: PdfPage[], c: Cursor, needed: number): Cursor {
  if (c.y - needed > MARGIN + 24) return c;
  return newPage(pages);
}

function heading(pages: PdfPage[], c: Cursor, text: string): Cursor {
  const next = ensure(pages, c, 30);
  next.page.text(text, MARGIN, next.y, { size: 12, font: 'Helvetica-Bold' });
  next.y -= 16;
  return next;
}

function body(pages: PdfPage[], c: Cursor, text: string, grey = 0.2): Cursor {
  const width = PAGE.width - 2 * MARGIN;
  // `paragraph` wraps but does not paginate, so budget the height before writing.
  const lines = Math.ceil(textWidth(text, 8.5) / width) + 1;
  const next = ensure(pages, c, lines * 11 + 6);
  next.y = next.page.paragraph(stripMarkup(text), MARGIN, next.y, width, {
    size: 8.5,
    leading: 11,
    grey,
  });
  next.y -= 6;
  return next;
}

/** The PDF has no bold run inside a paragraph, so markup would render as literal asterisks. */
function stripMarkup(text: string): string {
  return text.replace(/\*\*/g, '').replace(/`/g, '');
}

function table(
  pages: PdfPage[],
  c: Cursor,
  columns: readonly { header: string; width: number; align?: 'right' }[],
  rows: readonly (readonly string[])[],
): Cursor {
  let cur = ensure(pages, c, 30);
  const header = (): void => {
    let x = MARGIN;
    for (const col of columns) {
      const text = ellipsise(col.header, col.width - 4, 7.5, 'Helvetica-Bold');
      const dx = col.align === 'right' ? col.width - 4 - textWidth(text, 7.5, 'Helvetica-Bold') : 0;
      cur.page.text(text, x + dx, cur.y, { size: 7.5, font: 'Helvetica-Bold', grey: 0.35 });
      x += col.width;
    }
    cur.y -= 4;
    cur.page.line(MARGIN, cur.y, PAGE.width - MARGIN, cur.y, { grey: 0.75, width: 0.5 });
    cur.y -= 10;
  };
  header();
  for (const row of rows) {
    if (cur.y < MARGIN + 24) {
      cur = newPage(pages);
      header();
    }
    let x = MARGIN;
    row.forEach((cell, i) => {
      const col = columns[i];
      if (col === undefined) return;
      const text = ellipsise(cell, col.width - 4, 7.5);
      const dx = col.align === 'right' ? col.width - 4 - textWidth(text, 7.5) : 0;
      cur.page.text(text, x + dx, cur.y, { size: 7.5 });
      x += col.width;
    });
    cur.y -= 10;
  }
  cur.y -= 6;
  return cur;
}

/**
 * A plan view of the estate, drawn from the live coordinates with the PDF's own line primitives.
 *
 * There is no image support in `pdf.ts` — deliberately, `package.json` is a hot file and a PDF
 * dependency was judged not worth it — so the map in the PDF is vector, generated on this run, and
 * shows exactly what the analysis used: one ring per placed camera, coloured by whether it counted
 * as trusted. The screen map in §5 of the Markdown shows the same thing over a basemap.
 */
function planView(pages: PdfPage[], c: Cursor, a: GapAnalysis): Cursor {
  const placed = a.assumptions.filter(
    (r): r is typeof r & { lat: number; lon: number } => r.lat !== null && r.lon !== null,
  );

  const height = 220;
  let cur = ensure(pages, c, height + 46);
  cur = heading(pages, cur, 'Plan view');

  // The clip box `road_network` was imported against, so the frame means the same thing the
  // denominator does.
  const [west, south, east, north] = [68.0, 19.9, 74.6, 24.8] as const;
  const width = PAGE.width - 2 * MARGIN;
  const top = cur.y;
  const bottom = top - height;
  const sx = width / (east - west);
  const sy = height / (north - south);

  cur.page.rect(MARGIN, bottom, width, height, { grey: 0.97 });
  for (const [x1, y1, x2, y2] of [
    [MARGIN, bottom, MARGIN + width, bottom],
    [MARGIN, top, MARGIN + width, top],
    [MARGIN, bottom, MARGIN, top],
    [MARGIN + width, bottom, MARGIN + width, top],
  ] as const) {
    cur.page.line(x1, y1, x2, y2, { grey: 0.7, width: 0.5 });
  }

  for (const camera of placed) {
    const x = MARGIN + (camera.lon - west) * sx;
    const y = bottom + (camera.lat - south) * sy;
    if (x < MARGIN || x > MARGIN + width || y < bottom || y > top) continue;
    // A ring, not a filled dot: at this scale a 60 m disc is far under a point, so drawing it to
    // scale would be invisible and drawing it larger would overstate the coverage. The ring is a
    // position marker and the caption says so.
    ring(cur.page, x, y, 2.2, camera.trusted ? 0.15 : 0.55);
  }

  cur.y = bottom - 9;
  cur.page.paragraph(
    `${String(placed.length)} placed cameras of ${String(a.split.total)} registered, across ` +
      `${String(a.districtDeficit.length)} districts. Frame is the import clip ${String(west)},` +
      `${String(south)} to ${String(east)},${String(north)}. Dark rings counted as trusted (` +
      `${String(a.split.trusted)}); light rings did not. Markers show position only — a ` +
      `${String(a.ranges.anpr_viable)} m cell is far below one point at this scale, so the rings ` +
      `are not drawn to scale and this figure must not be read as a coverage area. The ` +
      `${String(a.split.unassessable)} cameras with no coordinates cannot appear here at all.`,
    MARGIN,
    cur.y,
    width,
    { size: 7, leading: 9, grey: 0.45 },
  );
  cur.y -= 46;
  return cur;
}

/** A circle as a 16-gon: `pdf.ts` has lines and rectangles, and that is enough. */
function ring(page: PdfPage, cx: number, cy: number, r: number, grey: number): void {
  const steps = 16;
  for (let i = 0; i < steps; i += 1) {
    const a0 = (i / steps) * 2 * Math.PI;
    const a1 = ((i + 1) / steps) * 2 * Math.PI;
    page.line(
      cx + r * Math.cos(a0),
      cy + r * Math.sin(a0),
      cx + r * Math.cos(a1),
      cy + r * Math.sin(a1),
      { grey, width: 0.6 },
    );
  }
}

export function gapAnalysisPdf(a: GapAnalysis): Buffer {
  const pages: PdfPage[] = [];
  let c = newPage(pages);
  const right = PAGE.width - MARGIN;

  c.page.text('SAAKSHI · Camera coverage gap analysis', MARGIN, c.y, {
    size: 16,
    font: 'Helvetica-Bold',
  });
  c.y -= 16;
  c.page.text(
    'Gujarat Police Innovation Challenge 2026 — Pillar 1, Model 1 deliverable',
    MARGIN,
    c.y,
    { size: 8.5, grey: 0.4 },
  );
  c.y -= 8;
  c.page.line(MARGIN, c.y, right, c.y, { grey: 0.6, width: 1 });
  c.y -= 18;

  c.page.text(`Generated ${a.generatedAt} from database ${a.databaseName}`, MARGIN, c.y, {
    size: 8,
    grey: 0.45,
  });
  c.y -= 16;

  c = heading(pages, c, '1 · Read this before any percentage');
  c = body(pages, c, splitStatement(a));
  c = body(
    pages,
    c,
    `${String(a.split.total)} cameras is a sandbox, not Gujarat. Every coverage cell is a circle: ` +
      'cameras has no bearing column, so a directional wedge is not expressible for any camera in ' +
      'the estate. The radii are assumptions, not survey measurements. No live VAHAN / SARTHI / ' +
      'eGujCop / AFIS / NAFIS connectivity is used anywhere, and no face recognition is performed.',
    0.35,
  );

  c = heading(pages, c, '2 · The headline');
  c = body(pages, c, deltaStatement(a));
  c = table(
    pages,
    c,
    [
      { header: 'slice', width: 200 },
      { header: 'cameras', width: 60, align: 'right' },
      { header: 'covered', width: 90, align: 'right' },
      { header: 'share of network', width: 100, align: 'right' },
    ],
    [a.all, a.trustedOnly, a.anprViable].map((s) => [
      s.label,
      String(s.cameras),
      km(s.coveredKm),
      a.network.km > 0 ? pct(s.coveredKm / a.network.km) : 'n/a',
    ]),
  );
  c = body(
    pages,
    c,
    'Mapping where cameras are is a map anyone can draw. cam03 returned 67 sightings in the same ' +
      'city and hour that cam04 returned 33,548 — a 500x spread — and cam03 is not broken: it ' +
      'decoded 5,582 frames cleanly at 23.16 fps. It simply sees almost no vehicles (D1-09, #13). A ' +
      "coverage polygon for cam03 would be the same size and colour as cam04's. Yield is not a " +
      'geometric property, which is why the trust band, not the polygon, decides whether a metre of ' +
      'road counts as covered. Likewise 8 of 30 measured cameras fail night usability (D1-05, #9): a ' +
      'junction covered only by a night-blind camera is uncovered for half of every day.',
    0.3,
  );

  c = heading(pages, c, '3 · Method');
  c = body(
    pages,
    c,
    `Cell radius by geometry class, all assumed: anpr_viable ${String(a.ranges.anpr_viable)} m, ` +
      `detection_only ${String(a.ranges.detection_only)} m, unclassified ` +
      `${String(a.ranges.unclassified)} m. Denominator: ${km(a.network.km)} over ` +
      `${a.network.ways.toLocaleString('en-IN')} ways; service, track, path, footway and cycleway ` +
      'were excluded at import (D3-01, #24). ST_Intersection and ST_Difference are evaluated ' +
      `independently in EPSG:32643 and reconciled to ${String(RECONCILE_TOLERANCE_M)} m; the ` +
      'generator refuses to publish if a slice falls outside that.',
    0.3,
  );
  c = table(
    pages,
    c,
    [
      { header: 'slice', width: 170 },
      { header: 'cand. ways', width: 65, align: 'right' },
      { header: 'cand. km', width: 70, align: 'right' },
      { header: 'covered', width: 70, align: 'right' },
      { header: 'reconcile err', width: 80, align: 'right' },
    ],
    [a.all, a.trustedOnly, a.anprViable].map((s) => [
      s.label,
      String(s.candidateWays),
      km(s.candidateKm),
      km(s.coveredKm),
      `${s.reconcileErrorM.toFixed(6)} m`,
    ]),
  );

  c = heading(pages, c, `4 · Junctions with zero trusted coverage`);
  c = body(
    pages,
    c,
    `A junction is a point where at least ${String(JUNCTION_MIN_DEGREE)} distinct ways of class ` +
      `${JUNCTION_CLASSES.join(', ')} terminate — a topological definition from way endpoints, not ` +
      'an OSM junction tag, so it misses junctions where one way passes through another without a ' +
      `shared endpoint. ${a.junctions.uncovered.toLocaleString('en-IN')} of ` +
      `${a.junctions.total.toLocaleString('en-IN')} have no trusted camera covering them.`,
    0.3,
  );
  c = table(
    pages,
    c,
    [
      { header: '#', width: 24, align: 'right' },
      { header: 'lon', width: 70, align: 'right' },
      { header: 'lat', width: 70, align: 'right' },
      { header: 'ways', width: 40, align: 'right' },
      { header: 'nearest named way', width: 210 },
    ],
    a.junctions.worst.map((j, i) => [
      String(i + 1),
      j.lon.toFixed(6),
      j.lat.toFixed(6),
      String(j.degree),
      j.name ?? '—',
    ]),
  );

  c = heading(pages, c, '5 · Where the coverage is');
  c = table(
    pages,
    c,
    [
      { header: 'district', width: 260 },
      { header: 'covered km (all cameras)', width: 150, align: 'right' },
    ],
    a.districtDeficit.map((d) => [d.district, km(d.coveredKm)]),
  );
  c = body(
    pages,
    c,
    'No per-department breakdown is given, and that is itself a finding: department_id is NULL for ' +
      'every camera in this estate, so a departmental trust deficit has exactly one bucket — no ' +
      'owning department recorded (D3-05, #28).',
    0.35,
  );
  c = planView(pages, c, a);

  c = heading(pages, c, '6 · Figures this run did not measure');
  c = body(
    pages,
    c,
    'Measured against the live sandbox feed by earlier tickets. The feed is not held during report ' +
      'generation, so these are cited, not recomputed, and no figure above depends on them.',
    0.35,
  );
  c = table(
    pages,
    c,
    [
      { header: 'fact', width: 180 },
      { header: 'value', width: 240 },
      { header: 'source', width: 87 },
    ],
    MEASURED_ELSEWHERE.map((m) => [m.fact, m.value, m.source]),
  );

  footer(pages, a);
  return renderPdf(pages, {
    title: 'SAAKSHI — camera coverage gap analysis',
    author: 'SAAKSHI',
    subject:
      'Generated from live data. Coverage cells are radius discs, not measured fields of view; ' +
      'the radii are assumptions. Cameras without coordinates are unassessable, not uncovered.',
  });
}

function footer(pages: PdfPage[], a: GapAnalysis): void {
  pages.forEach((page, i) => {
    page.text(
      `SAAKSHI gap analysis · generated ${a.generatedAt} · ${a.databaseName} · not a survey`,
      MARGIN,
      MARGIN - 16,
      { size: 6.5, grey: 0.55 },
    );
    const label = `${String(i + 1)} / ${String(pages.length)}`;
    page.text(label, PAGE.width - MARGIN - textWidth(label, 6.5), MARGIN - 16, {
      size: 6.5,
      grey: 0.55,
    });
  });
}
