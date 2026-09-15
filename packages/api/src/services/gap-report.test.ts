/**
 * D3-06 — the report renderers.
 *
 * Pure: `gapAnalysisMarkdown` and `gapAnalysisPdf` take a `GapAnalysis` object and touch no
 * database, so these tests run anywhere and are the ones that guard the ticket's honesty criteria
 * (AC 6 and AC 7).
 *
 * The load-bearing test here is `"contains no hardcoded figure"`: it renders **two different
 * analyses** and asserts every number that should move has moved. A generated report that quietly
 * bakes in a number from the run that wrote it is indistinguishable from a hand-written one, and
 * the ticket's requirement is that the report is generated *from real data*.
 */
import { describe, expect, it } from 'vitest';
import {
  deltaStatement,
  gapAnalysisMarkdown,
  gapAnalysisPdf,
  measuredElsewhere,
  splitStatement,
  zeroTrustedCause,
} from './gap-report.js';
import { DEFAULT_RANGES, type CoverageSlice, type GapAnalysis } from './coverage.js';

function slice(over: Partial<CoverageSlice> = {}): CoverageSlice {
  return {
    label: 'All cameras',
    cameras: 50,
    coveredKm: 20.3504,
    candidateUncoveredKm: 48.7,
    candidateKm: 69.05,
    candidateWays: 627,
    reconcileErrorM: 0,
    byDistrict: [{ district: 'Ahmedabad', coveredKm: 9.5 }],
    ...over,
  };
}

function analysis(over: Partial<GapAnalysis> = {}): GapAnalysis {
  return {
    generatedAt: '2026-09-06T00:00:00.000Z',
    databaseName: 'saakshi_test',
    ranges: { ...DEFAULT_RANGES },
    network: {
      ways: 540_584,
      km: 218_026.2,
      extract: 'Geofabrik western-zone, clipped to Gujarat, OSM data of 2026-09-05T20:22:06Z',
      byClass: [
        { highwayClass: 'residential', ways: 420_160, km: 73_719.2 },
        { highwayClass: 'primary', ways: 12_222, km: 18_935.4 },
        { highwayClass: 'motorway', ways: 1_446, km: 1_263.7 },
        { highwayClass: 'trunk', ways: 9_120, km: 11_763.0 },
        { highwayClass: 'secondary', ways: 7_261, km: 9_123.4 },
        { highwayClass: 'tertiary', ways: 36_708, km: 51_432.5 },
      ],
    },
    split: {
      total: 80,
      assessed: 50,
      unassessable: 30,
      neverProbed: 80,
      trusted: 0,
      focusDisqualified: 0,
      byBand: [{ band: 'never probed', total: 80, placed: 50 }],
    },
    write: { rows: 80, withPolygon: 50, unplaceable: 30, coveredWays: 627 },
    all: slice(),
    trustedOnly: slice({ label: 'Trusted cameras only', cameras: 0, coveredKm: 0, byDistrict: [] }),
    anprViable: slice({ label: 'ANPR-viable cameras only', cameras: 17, coveredKm: 2.77 }),
    deltaKm: 20.3504,
    deltaShare: 1,
    junctions: {
      total: 6_750,
      covered: 0,
      uncovered: 6_750,
      worst: [
        { lon: 72.5714, lat: 23.0225, degree: 6, name: 'Ashram Road', nearestTrustedM: null },
        { lon: 70.8022, lat: 22.3039, degree: 4, name: null, nearestTrustedM: null },
      ],
    },
    assumptions: [
      {
        externalId: 'GJ-AHM-0001',
        name: 'Chiman bhai Bridge',
        district: 'Ahmedabad',
        lat: 23.026336,
        lon: 72.514452,
        trusted: false,
        assumption: {
          model: 'disc',
          rangeM: 60,
          bearingDeg: null,
          reason: 'Radius disc, no bearing column',
        },
      },
      {
        externalId: 'cam01',
        name: 'Sandbox 1',
        district: null,
        lat: null,
        lon: null,
        trusted: false,
        assumption: {
          model: 'none',
          rangeM: null,
          bearingDeg: null,
          reason: 'No coordinates — unassessable, not uncovered.',
        },
      },
    ],
    districtDeficit: [{ district: 'Ahmedabad', coveredKm: 9.5 }],
    ...over,
  };
}

describe('the report is generated, not written (AC 6)', () => {
  it('contains no hardcoded figure — two analyses render two sets of numbers', () => {
    const a = gapAnalysisMarkdown(analysis());
    const b = gapAnalysisMarkdown(
      analysis({
        databaseName: 'other_db',
        generatedAt: '2027-01-01T00:00:00.000Z',
        network: {
          ways: 12,
          km: 34.5,
          byClass: [{ highwayClass: 'primary', ways: 12, km: 34.5 }],
          extract: 'a different extract',
        },
        split: {
          total: 7,
          assessed: 3,
          unassessable: 4,
          neverProbed: 1,
          trusted: 2,
          focusDisqualified: 1,
          byBand: [{ band: 'trusted', total: 2, placed: 2 }],
        },
        write: { rows: 7, withPolygon: 3, unplaceable: 4, coveredWays: 9 },
        all: slice({ cameras: 3, coveredKm: 5.5 }),
        trustedOnly: slice({ label: 'Trusted cameras only', cameras: 2, coveredKm: 4.25 }),
        deltaKm: 1.25,
        deltaShare: 1.25 / 5.5,
        junctions: { total: 11, covered: 4, uncovered: 7, worst: [] },
      }),
    );

    // `5,40,584` is the Indian-grouped rendering of the computed way count.
    //
    // **This block used to assert the opposite**, and the comment explained why: an ungrouped
    // `540,584` in §7 was fixed prose citing D3-01's measurement, and was "supposed to survive".
    // D4-10 re-imported the table and the real count became 540,711 — so the report cited a way
    // count contradicting its own §3, in a document whose header tells the reader not to hand-edit
    // it. §7's road-network row is generated now, and nothing in the report may outlive its data.
    for (const stale of [
      'saakshi_test',
      '2026-09-06',
      '5,40,584',
      '218026.20',
      '6,750',
      '80 cameras',
    ]) {
      expect(a).toContain(stale);
      expect(b).not.toContain(stale);
    }
    // The stale literal must NOT survive into a report generated from different data.
    expect(b).not.toContain('540,584');
    expect(b).toContain('a different extract');
    for (const fresh of ['other_db', '2027-01-01', '34.50 km', '5.50 km', '4.25 km', '1.25 km']) {
      expect(b).toContain(fresh);
    }
  });

  it('renders a PDF that starts with a PDF header and carries the title', () => {
    const pdf = gapAnalysisPdf(analysis());
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(4_000);
    const text = pdf.toString('latin1');
    expect(text).toContain('SAAKSHI');
    expect(text).toContain('gap analysis');
  });

  it('renders a PDF for a degenerate estate without throwing', () => {
    // The state the live run is actually in: nothing placed, nothing trusted, no junctions listed.
    const pdf = gapAnalysisPdf(
      analysis({
        all: slice({ cameras: 0, coveredKm: 0, byDistrict: [] }),
        trustedOnly: slice({
          label: 'Trusted cameras only',
          cameras: 0,
          coveredKm: 0,
          byDistrict: [],
        }),
        anprViable: slice({
          label: 'ANPR-viable cameras only',
          cameras: 0,
          coveredKm: 0,
          byDistrict: [],
        }),
        deltaKm: 0,
        deltaShare: null,
        junctions: { total: 0, covered: 0, uncovered: 0, worst: [] },
        districtDeficit: [],
        assumptions: [],
      }),
    );
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('the report states its own method and does not overclaim (AC 7)', () => {
  const md = gapAnalysisMarkdown(analysis());

  it('admits the FOV model is a circle, for every camera, not just some', () => {
    expect(md).toContain('Every coverage cell is a circle');
    expect(md).toContain('no bearing or azimuth column');
    expect(md).toContain('crudest form of the model');
  });

  it('labels the radii as assumptions rather than measurements', () => {
    expect(md).toContain('The radii are assumptions');
    // Every row of the radius table carries the provenance tag.
    const rows = md
      .split('\n')
      .filter((l) => /^\| `(anpr_viable|detection_only|unclassified)` \|/.test(l));
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toContain('assumed');
  });

  it('names the highway classes in the denominator, so the percentage is interpretable', () => {
    // D3-01's instruction, verbatim in intent.
    expect(md).toContain('`service`, `track`, `path`, `footway` and `cycleway` were excluded');
    for (const cls of ['residential', 'primary', 'trunk', 'secondary', 'tertiary', 'motorway']) {
      expect(md).toContain(`| \`${cls}\` |`);
    }
  });

  it('defines what a junction is, and admits what the definition misses', () => {
    expect(md).toContain('distinct ways of class');
    expect(md).toContain('not an OSM junction tag');
    expect(md).toContain('misses');
  });

  it('states the reconciliation is computed independently rather than asserted', () => {
    expect(md).toContain('would be trivial to define `uncovered := total - covered`');
    expect(md).toContain('EPSG:32643');
    expect(md).toContain('independently');
  });

  it('repeats the claims-discipline exclusions', () => {
    expect(md).toContain('No live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity');
    expect(md).toContain('no face recognition');
  });

  it('says the estate is a sandbox rather than implying it is Gujarat', () => {
    expect(md).toContain('is a sandbox, not Gujarat');
    expect(md).toContain('Nothing here is a finding *about Gujarat*');
  });

  it('separates figures this run measured from figures it merely cites', () => {
    expect(md).toContain('Figures this run did not measure');
    expect(md).toContain('cited, not recomputed');
    for (const m of measuredElsewhere({ ways: 540_584, extract: 'test extract' }))
    expect(md).toContain(m.source);
  });
});

describe('the disjoint-set split is stated, never resolved silently', () => {
  it('prints assessed beside unassessable, in words', () => {
    const s = splitStatement(analysis());
    expect(s).toContain('50 of 80');
    expect(s).toContain('unassessable, not uncovered');
  });

  it('scales with the analysis rather than repeating a fixed sentence', () => {
    const s = splitStatement(
      analysis({
        split: {
          total: 9,
          assessed: 4,
          unassessable: 5,
          neverProbed: 0,
          trusted: 4,
          focusDisqualified: 0,
          byBand: [],
        },
      }),
    );
    expect(s).toContain('4 of 9');
    expect(s).toContain('The other 5');
  });

  it('lists every camera in the assumptions table, placed or not', () => {
    const md = gapAnalysisMarkdown(analysis());
    expect(md).toContain('`GJ-AHM-0001`');
    expect(md).toContain('`cam01`');
  });

  it('refuses a per-department table and says why', () => {
    const md = gapAnalysisMarkdown(analysis());
    expect(md).toContain('`cameras.department_id` is NULL for every camera');
    expect(md).toContain('no owning department recorded');
  });
});

describe('the headline adapts to what the data actually shows', () => {
  it('names the degenerate case as the finding rather than hiding it', () => {
    const s = deltaStatement(analysis());
    expect(s).toContain('100% of apparent coverage');
    expect(s).toContain('never had a health check');
    // The distinction D1-08 insisted on: absence of evidence is not a bad result.
    expect(s).toContain('absence of evidence, not a bad result');
  });

  it('reports a graded delta when the bands vary', () => {
    const s = deltaStatement(
      analysis({
        all: slice({ coveredKm: 20 }),
        trustedOnly: slice({ label: 'Trusted cameras only', cameras: 12, coveredKm: 8 }),
        deltaKm: 12,
        deltaShare: 0.6,
      }),
    );
    expect(s).toContain('20.00 km');
    expect(s).toContain('8.00 km');
    expect(s).toContain('12.00 km');
    expect(s).toContain('60.0%');
  });

  it('refuses to call an empty estate a result', () => {
    const s = deltaStatement(
      analysis({
        all: slice({ cameras: 0, coveredKm: 0 }),
        trustedOnly: slice({ label: 'Trusted cameras only', cameras: 0, coveredKm: 0 }),
        deltaKm: 0,
        deltaShare: null,
      }),
    );
    expect(s).toContain('That is a data state, not a result');
  });
});

describe('why trusted coverage is zero is derived, not asserted (D4-13)', () => {
  // The regression: run against a database where every camera HAD been probed, the old code still
  // printed "0 of 85 cameras have never had a health check … so every one resolves to `band: null`"
  // directly above a band table reading `dead 55 · trusted 26`. Four distinct causes reach zero
  // trusted coverage and each calls for a different remedy.

  it('names an unprobed estate when nothing has been probed', () => {
    expect(zeroTrustedCause(analysis())).toContain('80 of 80 cameras have never had a health check');
  });

  it('names missing coordinates when trusted cameras exist but none is placed', () => {
    const s = zeroTrustedCause(
      analysis({
        split: {
          total: 85,
          assessed: 54,
          unassessable: 31,
          neverProbed: 0,
          trusted: 0,
          focusDisqualified: 0,
          byBand: [
            { band: 'dead', total: 55, placed: 54 },
            { band: 'trusted', total: 26, placed: 0 },
            { band: 'degraded', total: 3, placed: 0 },
            { band: 'untrusted', total: 1, placed: 0 },
          ],
        },
      }),
    );
    expect(s).toContain('26 cameras do clear the trust bar');
    expect(s).toContain('not one of them carries coordinates');
    expect(s).not.toContain('never had a health check');
  });

  it('names the bands when no camera reaches the trusted band at all', () => {
    const s = zeroTrustedCause(
      analysis({
        split: {
          total: 10,
          assessed: 10,
          unassessable: 0,
          neverProbed: 0,
          trusted: 0,
          focusDisqualified: 0,
          byBand: [
            { band: 'dead', total: 7, placed: 7 },
            { band: 'degraded', total: 3, placed: 3 },
          ],
        },
      }),
    );
    expect(s).toContain('no camera in the estate reaches the trusted band');
    expect(s).toContain('7 dead');
    expect(s).toContain('3 degraded');
  });

  it('names siting when trusted placed cameras cover no road', () => {
    const s = zeroTrustedCause(
      analysis({
        split: {
          total: 4,
          assessed: 4,
          unassessable: 0,
          neverProbed: 0,
          trusted: 4,
          focusDisqualified: 0,
          byBand: [{ band: 'trusted', total: 4, placed: 4 }],
        },
      }),
    );
    expect(s).toContain('4 cameras are trusted and placed');
    expect(s).toContain('intersect no road');
  });

  it('never contradicts its own band table: the deployed-estate case', () => {
    const deployed = analysis({
      split: {
        total: 85,
        assessed: 54,
        unassessable: 31,
        neverProbed: 0,
        trusted: 0,
        focusDisqualified: 0,
        byBand: [
          { band: 'dead', total: 55, placed: 54 },
          { band: 'trusted', total: 26, placed: 0 },
        ],
      },
    });
    const md = gapAnalysisMarkdown(deployed);
    // The exact false sentence that shipped on 15 Sep.
    expect(md).not.toContain('0 of 85 cameras have never had a health check');
    // And the recommendation that asserted the same thing is withheld when it does not apply.
    expect(md).not.toContain('trusted coverage cannot be non-zero for a camera that has never been measured');
  });
});
