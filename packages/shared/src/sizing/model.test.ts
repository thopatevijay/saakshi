/**
 * D3-08 — the arithmetic, checked against numbers computed by hand.
 *
 * The point of this ticket is that a judge can verify the model on a napkin. This suite is that
 * napkin: the fixture uses deliberately round inputs, every expected value is worked out longhand in
 * a comment above its assertion, and the assertions are exact rather than approximate wherever the
 * arithmetic is exact. A model whose own test only checks that outputs "look plausible" would prove
 * nothing that a static table does not already prove.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSTANT_KEYS,
  EVENT_RATE_ANCHORS,
  PROJECT_MD_SECTION_9,
  SIZING_CONSTANTS,
  acceleratorClasses,
  constantValue,
  deriveExtrapolatedStreams,
  extrapolatedStreamFps,
  resolvedConstant,
  venueBStreamFps,
} from './constants.js';
import { type SizingInputs, computeSizing } from './model.js';
import { SECTION_9_REPRODUCTION, SIZING_PRESETS, presetById } from './presets.js';

/**
 * The hand-computed fixture.
 *
 * Round numbers chosen so every intermediate can be done in the head:
 * 1,000 cameras, half of them on ANPR, all analysed at the edge, 1,000 events per camera per day,
 * one sighting per event, 10-day metadata retention, 10-day crop retention.
 *
 * Constants are overridden to round values too, so the fixture tests the *arithmetic* and not the
 * measured constants (which have their own tests below).
 */
const FIXTURE: SizingInputs = {
  cameras: 1_000,
  anprCoveragePct: 50,
  edgeSharePct: 100,
  eventsPerCameraPerDay: 1_000,
  sightingsPerEvent: 1,
  metadataRetentionDays: 10,
  cropRetentionDays: 10,
  acceleratorClassId: 'nvidia-l4',
};

const FIXTURE_OVERRIDES = {
  videoBitrateMbps: 2, // Mbps
  eventWireBytes: 500, // B
  sightingRowBytes: 400, // B
  cropsPer1000Sightings: 50, // crops per 1,000
  cropBytesMeasured: 1_000, // B
  cropBytesCeiling: 5_000, // B
  districtNodes: 10,
  hotTierDays: 4,
  warmTierDays: 8, // cumulative, so warm is days 4..8 and cold is 8..10
  acceleratorNodeCapexInr: 100_000,
  acceleratorNodePowerW: 1_000,
  datacentrePue: 2,
  powerTariffInrPerKwh: 10,
  hotStorageInrPerTbMonth: 1_000,
  warmStorageInrPerTbMonth: 100,
  coldStorageInrPerTbMonth: 10,
  backhaulInrPerMbpsMonth: 100,
  nodesPerFte: 10,
  opsFteInrPerYear: 1_000_000,
  softwareLicenceInrPerCameraYear: 0,
  hardwareRefreshYears: 5,
  costUncertainty: 0, // off, so the fixture asserts point values
} as const;

describe('computeSizing — hand-computed fixture', () => {
  const r = computeSizing(FIXTURE, FIXTURE_OVERRIDES);

  it('splits the estate as stated', () => {
    // 100% at the edge: 1,000 edge, 0 central.
    expect(r.backhaul.edgeCameras).toBe(1_000);
    expect(r.backhaul.centralCameras).toBe(0);
    // 50% of 1,000 on ANPR.
    expect(r.compute.anprCameras).toBe(500);
  });

  it('computes central video backhaul', () => {
    // 1,000 cameras x 2 Mbps = 2,000 Mbps = 2 Gbps.
    expect(r.backhaul.allCentralVideoGbps).toBe(2);
    // Nothing streams centrally under a full edge split.
    expect(r.backhaul.videoBackhaulGbps).toBe(0);
  });

  it('computes metadata backhaul', () => {
    // Per camera: 1,000 events/day x 500 B = 500,000 B/day.
    //             500,000 x 8 = 4,000,000 bits/day.
    //             4,000,000 / 86,400 = 46.296296... bits/s.
    // Estate:     46.296296... x 1,000 cameras = 46,296.296... bits/s = 0.0000462963 Gbps.
    expect(r.backhaul.metadataBackhaulGbps).toBeCloseTo(4.62962962963e-5, 15);
    expect(r.backhaul.totalBackhaulGbps).toBeCloseTo(4.62962962963e-5, 15);
  });

  it('computes the reduction ratio', () => {
    // 2 Gbps / 0.0000462963 Gbps = 43,200.
    // Sanity: 2 Mbps of video is 2,000,000 bits/s; metadata is 46.2963 bits/s per camera;
    // 2,000,000 / 46.2963 = 43,200 exactly.
    expect(r.backhaul.reductionRatio).toBeCloseTo(43_200, 6);
    expect(r.backhaul.metadataOnlyRatio).toBeCloseTo(43_200, 6);
  });

  it('computes accelerator counts', () => {
    // 500 ANPR cameras / 25 streams per L4 = 20 accelerators.
    expect(r.compute.streamsPerAccelerator).toBe(25);
    expect(r.compute.acceleratorsRequired).toBe(20);
    // 20 across 10 district nodes = 2 each, exactly.
    expect(r.compute.acceleratorsPerDistrictNodeMean).toBe(2);
    expect(r.compute.acceleratorsPerDistrictNode).toBe(2);
    // 500 cameras x 25 fps = 12,500 stream-fps.
    expect(r.compute.aggregateStreamFps).toBe(12_500);
  });

  it('computes metadata storage', () => {
    // 1,000 cameras x 1,000 events = 1,000,000 events/day.
    expect(r.storage.eventsPerDay).toBe(1_000_000);
    expect(r.storage.sightingsPerDay).toBe(1_000_000);
    // 1,000,000 x 400 B = 400,000,000 B/day = 0.0004 TB/day.
    // x 365 = 0.146 TB/year.
    expect(r.storage.metadataTBPerYear).toBeCloseTo(0.146, 12);
    // x 10 days retained = 0.004 TB.
    expect(r.storage.metadataRetainedTB).toBeCloseTo(0.004, 12);
  });

  it('computes crop storage as a band', () => {
    // 1,000,000 sightings/day x 50 per 1,000 = 50,000 crops/day.
    expect(r.storage.cropsPerDay).toBe(50_000);
    // Low:  50,000 x 1,000 B = 50,000,000 B/day = 0.00005 TB/day -> x365 = 0.01825 TB/year.
    // High: 50,000 x 5,000 B = 250,000,000 B/day = 0.00025 TB/day -> x365 = 0.09125 TB/year.
    expect(r.storage.cropTBPerYear.low).toBeCloseTo(0.01825, 12);
    expect(r.storage.cropTBPerYear.high).toBeCloseTo(0.09125, 12);
    // Retained 10 days: 0.0005 TB and 0.0025 TB.
    expect(r.storage.cropRetainedTB.low).toBeCloseTo(0.0005, 12);
    expect(r.storage.cropRetainedTB.high).toBeCloseTo(0.0025, 12);
    // Total retained = metadata 0.004 + crops.
    expect(r.storage.totalRetainedTB.low).toBeCloseTo(0.0045, 12);
    expect(r.storage.totalRetainedTB.high).toBeCloseTo(0.0065, 12);
  });

  it('apportions storage across hot, warm and cold', () => {
    // hotTierDays 4, warmTierDays 8 cumulative, retention 10 => 4 hot, 4 warm, 2 cold.
    expect(r.storage.tiers.hotDays).toBe(4);
    expect(r.storage.tiers.warmDays).toBe(4);
    expect(r.storage.tiers.coldDays).toBe(2);
    // Metadata 0.0004 TB/day; crops 0.00005–0.00025 TB/day.
    // Hot  = 4  x (0.0004 + 0.00005..0.00025) = 0.0018 .. 0.0026 TB
    expect(r.storage.tiers.hotTB.low).toBeCloseTo(0.0018, 12);
    expect(r.storage.tiers.hotTB.high).toBeCloseTo(0.0026, 12);
    // Warm = same 4 days = same figures
    expect(r.storage.tiers.warmTB.low).toBeCloseTo(0.0018, 12);
    expect(r.storage.tiers.warmTB.high).toBeCloseTo(0.0026, 12);
    // Cold = 2  x (0.0004 + 0.00005..0.00025) = 0.0009 .. 0.0013 TB
    expect(r.storage.tiers.coldTB.low).toBeCloseTo(0.0009, 12);
    expect(r.storage.tiers.coldTB.high).toBeCloseTo(0.0013, 12);
    // The three tiers must add back up to the retained total.
    const sumLow =
      r.storage.tiers.hotTB.low + r.storage.tiers.warmTB.low + r.storage.tiers.coldTB.low;
    expect(sumLow).toBeCloseTo(r.storage.totalRetainedTB.low, 12);
  });

  it('computes capex', () => {
    // 20 accelerators x INR 100,000 = INR 2,000,000. Uncertainty is 0 in this fixture.
    expect(r.cost.capexInr.low).toBe(2_000_000);
    expect(r.cost.capexInr.high).toBe(2_000_000);
    // Amortised over 5 years = INR 400,000/year.
    expect(r.cost.amortisedCapexInrPerYear.low).toBe(400_000);
  });

  it('computes each opex line', () => {
    const line = (key: string) => {
      const found = r.cost.lines.find((l) => l.key === key);
      if (found === undefined) throw new Error(`no cost line ${key}`);
      return found.inrPerYear;
    };

    // Power: 20 accelerators x 1,000 W = 20 kW; x 8,760 h = 175,200 kWh;
    //        x PUE 2 = 350,400 kWh; x INR 10 = INR 3,504,000.
    expect(line('power').low).toBeCloseTo(3_504_000, 6);

    // Backhaul: 0.0000462963 Gbps x 1,000 = 0.0462963 Mbps; x INR 100 x 12 = INR 55.5555...
    expect(line('backhaul').low).toBeCloseTo(55.5555555556, 6);

    // Storage: hot 0.0018 TB x 1,000 x 12 = 21.6
    //          warm 0.0018 TB x 100  x 12 = 2.16
    //          cold 0.0009 TB x 10   x 12 = 0.108
    //          = INR 23.868 at the low end.
    expect(line('storage').low).toBeCloseTo(23.868, 9);

    // Ops: ceil(20 / 10) = 2 FTE x INR 1,000,000 = INR 2,000,000.
    expect(line('ops').low).toBe(2_000_000);

    // Licences: the stack is open source.
    expect(line('licence').low).toBe(0);

    // Opex total = 3,504,000 + 55.5556 + 23.868 + 2,000,000 + 0 = 5,504,079.42...
    expect(r.cost.annualOpexInr.low).toBeCloseTo(5_504_079.4236, 3);
    // Total annual = opex + amortised capex 400,000.
    expect(r.cost.totalAnnualCostInr.low).toBeCloseTo(5_904_079.4236, 3);
    // Per camera = / 1,000.
    expect(r.cost.annualCostPerCameraInr.low).toBeCloseTo(5_904.0794236, 6);
  });

  it('applies the uncertainty band outward, without hiding the crop band', () => {
    const widened = computeSizing(FIXTURE, { ...FIXTURE_OVERRIDES, costUncertainty: 0.25 });
    // Capex has no crop term, so it is exactly +/-25% of the point value.
    expect(widened.cost.capexInr.low).toBeCloseTo(2_000_000 * 0.75, 6);
    expect(widened.cost.capexInr.high).toBeCloseTo(2_000_000 * 1.25, 6);
    // Storage carries both: the crop band first, then the uncertainty on top.
    const storage = widened.cost.lines.find((l) => l.key === 'storage');
    expect(storage?.inrPerYear.low).toBeCloseTo(23.868 * 0.75, 9);
    expect(storage?.inrPerYear.high).toBeGreaterThan(23.868 * 1.25);
  });
});

describe('PROJECT.md section 9 — reproduction and reconciliation (AC 2)', () => {
  const r = computeSizing(SECTION_9_REPRODUCTION.inputs, SECTION_9_REPRODUCTION.overrides);

  it('reproduces the 160 Gbps central-video figure exactly', () => {
    // 80,000 cameras x 2 Mbps = 160,000 Mbps = 160 Gbps.
    expect(r.backhaul.allCentralVideoGbps).toBe(PROJECT_MD_SECTION_9.publishedVideoGbps);
  });

  it('reproduces the ~1.3 Gbps metadata figure exactly', () => {
    // 432,000 events/day x 400 B = 172,800,000 B/day = 2,000 B/s = 16,000 bits/s per camera.
    // x 80,000 = 1,280,000,000 bits/s = 1.28 Gbps, which rounds to section 9's "~1.3".
    expect(r.backhaul.metadataBackhaulGbps).toBeCloseTo(1.28, 9);
    expect(Number(r.backhaul.metadataBackhaulGbps.toFixed(1))).toBe(
      PROJECT_MD_SECTION_9.publishedMetadataGbps,
    );
  });

  it('reproduces the ~125x ratio exactly', () => {
    // 160 / 1.28 = 125.
    expect(r.backhaul.reductionRatio).toBeCloseTo(PROJECT_MD_SECTION_9.publishedRatio, 9);
  });

  it('reproduces the ~960 GPU figure exactly', () => {
    // 30% of 80,000 = 24,000 ANPR cameras; 24,000 / 25 streams per L4 = 960.
    expect(r.compute.anprCameras).toBe(24_000);
    expect(r.compute.streamsPerAccelerator).toBe(PROJECT_MD_SECTION_9.streamsPerGpu);
    expect(r.compute.acceleratorsRequired).toBe(PROJECT_MD_SECTION_9.publishedGpus);
  });

  it('reproduces the ~29 GPUs per district node figure', () => {
    // 960 / 33 districts = 29.09...
    expect(Math.round(r.compute.acceleratorsPerDistrictNodeMean)).toBe(29);
  });

  it('shows that section 9 cannot reproduce its own metadata storage figure', () => {
    // Section 9 sized backhaul from ~2 KB/s (432,000 events/day) and storage from 200 events/day,
    // in adjacent bullets. Run its own backhaul rate through its own byte figure and the metadata
    // storage is three orders of magnitude above its published 2.3 TB/year.
    //   80,000 x 432,000 = 3.456e10 events/day; x 400 B = 1.3824e13 B/day = 13.824 TB/day
    //   x 365 = 5,045.76 TB/year.
    expect(r.storage.metadataTBPerYear).toBeCloseTo(5_045.76, 6);
    expect(
      r.storage.metadataTBPerYear / PROJECT_MD_SECTION_9.publishedMetadataTbPerYear,
    ).toBeGreaterThan(2_000);
    // The two rates section 9 quotes differ by 2,160x.
    expect(
      PROJECT_MD_SECTION_9.eventsPerCameraPerDay /
        PROJECT_MD_SECTION_9.storageBulletEventsPerCameraPerDay,
    ).toBe(2_160);
  });

  it("places section 9's assumed event rate inside the measured range", () => {
    // The correction is not that section 9 was wildly wrong on backhaul: its assumed rate sits
    // between the measured per-track and per-frame rates. It used a different rate per output.
    const perTrack = EVENT_RATE_ANCHORS.find((a) => a.id === 'per-track');
    const perFrame = EVENT_RATE_ANCHORS.find((a) => a.id === 'per-frame-mean');
    expect(perTrack).toBeDefined();
    expect(perFrame).toBeDefined();
    expect(PROJECT_MD_SECTION_9.eventsPerCameraPerDay).toBeGreaterThan(
      perTrack!.eventsPerCameraPerDay,
    );
    expect(PROJECT_MD_SECTION_9.eventsPerCameraPerDay).toBeLessThan(
      perFrame!.eventsPerCameraPerDay,
    );
  });
});

describe('streams per accelerator is derived from measured throughput (AC 3)', () => {
  it('derives the extrapolated figure from the measured base and the measured idle share', () => {
    // 8 demonstrated streams, node 92% blocked in decode() => 8 / 0.08 = 100 streams saturated.
    expect(constantValue('measuredStreamsPerNode')).toBe(8);
    expect(constantValue('upstreamBoundShare')).toBe(0.92);
    expect(deriveExtrapolatedStreams()).toBeCloseTo(100, 9);
  });

  it('cross-checks against the independent local-MediaMTX run to within 10%', () => {
    // Sandbox: 100 streams x 4.00 effective fps = 400 stream-fps.
    // MediaMTX: 8 streams / 47.29% utilisation x 25 fps = 422.9 stream-fps.
    // Two venues, two bottlenecks, two different motion-gate skip ratios.
    const a = extrapolatedStreamFps();
    const b = venueBStreamFps();
    expect(a).toBeCloseTo(400, 6);
    expect(b).toBeCloseTo(422.92, 1);
    expect(Math.abs(a - b) / b).toBeLessThan(0.1);
  });

  it('lands in the same place as the vendor L4 figure when expressed at 25 fps', () => {
    // 400 stream-fps / 25 fps = 16 streams, against a listed 25 for an L4/A10.
    // Same order, which is the reassurance the first-pass estimate never had.
    const ourStreamsAt25 = extrapolatedStreamFps() / 25;
    expect(ourStreamsAt25).toBeCloseTo(16, 6);
    expect(ourStreamsAt25).toBeGreaterThan(PROJECT_MD_SECTION_9.streamsPerGpu / 2);
    expect(ourStreamsAt25).toBeLessThan(PROJECT_MD_SECTION_9.streamsPerGpu * 2);
  });

  it('tags the two Apple Silicon classes honestly and the NVIDIA classes as listed', () => {
    const classes = acceleratorClasses();
    expect(classes.find((c) => c.id === 'measured-demonstrated')?.provenance).toBe('measured');
    // The extrapolation is an assumption on top of a measured base, and says so.
    expect(classes.find((c) => c.id === 'measured-extrapolated')?.provenance).toBe('assumed');
    for (const c of classes.filter((k) => k.id.startsWith('nvidia'))) {
      expect(c.provenance).toBe('listed');
      expect(c.note).toMatch(/NOT ours|vendor/i);
    }
  });
});

describe('storage uses the measured D2-02 figures (AC 4)', () => {
  it("carries D2-02's bytes per 1,000 sightings and crops per 1,000 sightings", () => {
    expect(SIZING_CONSTANTS.cropBytesPer1000Sightings.value).toBe(96_214);
    expect(SIZING_CONSTANTS.cropBytesPer1000Sightings.provenance).toBe('measured');
    expect(SIZING_CONSTANTS.cropBytesPer1000Sightings.source).toMatch(/D2-02/);
    expect(SIZING_CONSTANTS.cropsPer1000Sightings.value).toBe(33.0);
    expect(SIZING_CONSTANTS.cropsPer1000Sightings.provenance).toBe('measured');
    expect(SIZING_CONSTANTS.cropBytesMeasured.value).toBe(2_912);
  });

  it("is internally consistent: 33.0 crops x 2,912 B is D2-02's 96,214 B per 1,000, to 0.2%", () => {
    const derived =
      SIZING_CONSTANTS.cropsPer1000Sightings.value * SIZING_CONSTANTS.cropBytesMeasured.value;
    const published = SIZING_CONSTANTS.cropBytesPer1000Sightings.value;
    expect(Math.abs(derived - published) / published).toBeLessThan(0.002);
  });

  it("reproduces D2-02's per-1,000-sightings figure through the model at the low end", () => {
    // 1,000 cameras x 1,000 sightings = 1,000,000 sightings/day.
    // At 96,214 B per 1,000 that is 96,214,000 B/day.
    const r = computeSizing({ ...FIXTURE, sightingsPerEvent: 1 }, { costUncertainty: 0 });
    const cropBytesPerDayLow = (r.storage.cropRetainedTB.low / r.inputs.cropRetentionDays) * 1e12;
    expect(cropBytesPerDayLow).toBeCloseTo(96_096_000, 0); // 33.0 x 2,912 x 1,000
  });

  it('prices the crop term as a 3–15 KB band, never a point estimate', () => {
    const r = computeSizing(SIZING_PRESETS[2]!.inputs);
    expect(r.storage.cropTBPerYear.high).toBeGreaterThan(r.storage.cropTBPerYear.low * 4);
    expect(SIZING_CONSTANTS.cropBytesCeiling.value).toBe(15_000);
    expect(SIZING_CONSTANTS.cropBytesMeasured.note).toMatch(/PROVISIONAL/);
  });

  it('uses the sighting rate for crops, not the summarised event rate', () => {
    // Summarising 43.62 per-frame rows into one track row does not reduce how many vehicles drove
    // past, so the crop count must not fall by 43.62x when the metadata rate does.
    const perFrame = computeSizing({
      ...FIXTURE,
      eventsPerCameraPerDay: 43_620,
      sightingsPerEvent: 1,
    });
    const perTrack = computeSizing({
      ...FIXTURE,
      eventsPerCameraPerDay: 1_000,
      sightingsPerEvent: 43.62,
    });
    expect(perTrack.storage.cropsPerDay).toBeCloseTo(perFrame.storage.cropsPerDay, 6);
    // Metadata, however, does fall by 43.62x — that is the whole point of summarising.
    expect(perFrame.storage.metadataTBPerYear / perTrack.storage.metadataTBPerYear).toBeCloseTo(
      43.62,
      6,
    );
  });
});

describe('every constant carries provenance (AC 5)', () => {
  it('has a non-empty label, unit, source and note on every registry entry', () => {
    expect(CONSTANT_KEYS.length).toBeGreaterThan(20);
    for (const key of CONSTANT_KEYS) {
      const c = SIZING_CONSTANTS[key];
      expect(c.key, `${key}.key`).toBe(key);
      expect(c.label.length, `${key}.label`).toBeGreaterThan(0);
      expect(c.unit.length, `${key}.unit`).toBeGreaterThan(0);
      expect(c.source.length, `${key}.source`).toBeGreaterThan(0);
      expect(c.note.length, `${key}.note`).toBeGreaterThan(0);
      expect(['measured', 'listed', 'assumed'], `${key}.provenance`).toContain(c.provenance);
      expect(Number.isFinite(c.value), `${key}.value`).toBe(true);
    }
  });

  it('names the originating ticket on every measured constant', () => {
    for (const key of CONSTANT_KEYS) {
      const c = SIZING_CONSTANTS[key];
      if (c.provenance !== 'measured') continue;
      // D-something (#n), or this ticket for the two measurements taken here.
      expect(c.source, `${key}.source`).toMatch(/D\d-\d\d/);
    }
  });

  it('exposes provenance on every constant the model actually reads', () => {
    const r = computeSizing(SIZING_PRESETS[2]!.inputs);
    expect(r.constantsUsed.length).toBeGreaterThan(15);
    for (const c of r.constantsUsed) {
      expect(c.source.length).toBeGreaterThan(0);
      expect(['measured', 'listed', 'assumed']).toContain(c.provenance);
    }
  });

  it('demotes an overridden constant to "assumed" and keeps the original in its source', () => {
    const overridden = resolvedConstant('videoBitrateMbps', { videoBitrateMbps: 4 });
    expect(overridden.value).toBe(4);
    expect(overridden.provenance).toBe('assumed');
    expect(overridden.source).toMatch(/Overridden by the reader/);
    expect(overridden.source).toMatch(/registry default 2/);
  });

  it('labels every event-rate anchor', () => {
    expect(EVENT_RATE_ANCHORS.length).toBeGreaterThanOrEqual(5);
    for (const a of EVENT_RATE_ANCHORS) {
      expect(a.source.length).toBeGreaterThan(0);
      expect(a.note.length).toBeGreaterThan(0);
      expect(['measured', 'listed', 'assumed']).toContain(a.provenance);
      expect(a.eventsPerCameraPerDay).toBeGreaterThan(0);
      expect(a.sightingsPerEvent).toBeGreaterThan(0);
    }
  });

  it('records the 500x spread rather than hiding it behind a mean', () => {
    // cam04 33,548 against cam03 67, same city, same hour.
    expect(SIZING_CONSTANTS.cameraYieldSpread.value).toBeCloseTo(500.7, 1);
    const busiest = EVENT_RATE_ANCHORS.find((a) => a.id === 'per-frame-busiest');
    const quietest = EVENT_RATE_ANCHORS.find((a) => a.id === 'per-frame-quietest');
    expect(busiest!.eventsPerCameraPerDay / quietest!.eventsPerCameraPerDay).toBeCloseTo(500.7, 0);
  });
});

describe('presets (AC 1, scope)', () => {
  it('offers exactly the four scenarios the ticket names, including the 100,000 benchmark', () => {
    expect(SIZING_PRESETS.map((p) => p.inputs.cameras)).toEqual([500, 5_000, 80_000, 100_000]);
    expect(presetById('benchmark')?.inputs.cameras).toBe(100_000);
    expect(presetById('statewide')?.inputs.cameras).toBe(80_000);
  });

  it('computes every preset without throwing and with finite outputs', () => {
    for (const p of SIZING_PRESETS) {
      const r = computeSizing(p.inputs);
      expect(Number.isFinite(r.backhaul.totalBackhaulGbps), p.id).toBe(true);
      expect(Number.isFinite(r.cost.totalAnnualCostInr.high), p.id).toBe(true);
      expect(r.compute.acceleratorsRequired, p.id).toBeGreaterThan(0);
      expect(r.storage.totalRetainedTB.high, p.id).toBeGreaterThan(0);
    }
  });

  it('reaches the 1,00,000 target the evaluation criteria state, above the 80,000 on /problems', () => {
    const benchmark = computeSizing(presetById('benchmark')!.inputs);
    const statewide = computeSizing(presetById('statewide')!.inputs);
    expect(benchmark.inputs.cameras).toBeGreaterThan(statewide.inputs.cameras);
    expect(benchmark.backhaul.allCentralVideoGbps).toBe(200); // 100,000 x 2 Mbps
  });

  it('recomputes with no I/O and no measurable lag', () => {
    // The screen calls this on every keystroke. 2,000 recomputations of the largest preset must
    // finish well inside a frame budget, and the function must be pure — same inputs, same output.
    const inputs = presetById('benchmark')!.inputs;
    const started = performance.now();
    for (let i = 0; i < 2_000; i += 1) computeSizing(inputs);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(1_000);
    expect(JSON.stringify(computeSizing(inputs))).toBe(JSON.stringify(computeSizing(inputs)));
  });

  it('responds to every input', () => {
    const base = presetById('statewide')!.inputs;
    const b = computeSizing(base);

    expect(computeSizing({ ...base, cameras: base.cameras * 2 }).backhaul.allCentralVideoGbps).toBe(
      b.backhaul.allCentralVideoGbps * 2,
    );
    expect(
      computeSizing({ ...base, anprCoveragePct: 60 }).compute.acceleratorsRequired,
    ).toBeGreaterThan(b.compute.acceleratorsRequired);
    expect(computeSizing({ ...base, edgeSharePct: 0 }).backhaul.videoBackhaulGbps).toBeGreaterThan(
      b.backhaul.videoBackhaulGbps,
    );
    expect(
      computeSizing({ ...base, eventsPerCameraPerDay: base.eventsPerCameraPerDay * 2 }).storage
        .metadataTBPerYear,
    ).toBeCloseTo(b.storage.metadataTBPerYear * 2, 6);
    expect(
      computeSizing({ ...base, metadataRetentionDays: 730 }).storage.metadataRetainedTB,
    ).toBeCloseTo(b.storage.metadataRetainedTB * 2, 6);
    expect(
      computeSizing({ ...base, cropRetentionDays: 180 }).storage.cropRetainedTB.low,
    ).toBeCloseTo(b.storage.cropRetainedTB.low * 2, 6);
    expect(computeSizing({ ...base, sightingsPerEvent: 1 }).storage.cropsPerDay).toBeLessThan(
      b.storage.cropsPerDay,
    );
    expect(
      computeSizing({ ...base, acceleratorClassId: 'nvidia-a100' }).compute.acceleratorsRequired,
    ).not.toBe(b.compute.acceleratorsRequired);
    // And every editable constant moves something.
    expect(
      computeSizing(base, { backhaulInrPerMbpsMonth: 4_000 }).cost.annualOpexInr.low,
    ).toBeGreaterThan(b.cost.annualOpexInr.low);
  });

  it('falls back to the first accelerator class rather than throwing on an unknown id', () => {
    const r = computeSizing({ ...FIXTURE, acceleratorClassId: 'does-not-exist' });
    expect(r.compute.acceleratorClass.id).toBe('measured-demonstrated');
  });
});
