/**
 * Every number the sizing model uses, and where it came from (D3-08).
 *
 * **There is no bare number in this model.** A capacity claim a judge cannot trace is worth less
 * than no claim at all, so every quantity is a {@link SizingConstant} carrying a value, a unit, a
 * provenance tag and the ticket, vendor or reasoning it came from. `model.ts` reads this registry
 * and never inlines a literal.
 *
 * The three provenance tags mean exactly this:
 *
 * - `measured` — **we** measured it, on this stack, and the ticket that measured it is named. The
 *   run is reproducible from that ticket's evidence.
 * - `listed` — a vendor, a tariff or a published figure. Not ours. We have not verified it.
 * - `assumed` — a modelling choice. Defensible, stated, and editable in the UI so a reader who
 *   disagrees can substitute their own and watch the answer move.
 *
 * ## Two traps this file is built around
 *
 * **1 · Feed capacity and hardware capacity are different quantities.** The Sentinel sandbox
 * delivers about 4 effective fps per camera against streams that *carry* 15–30 (D1-09 #13), and the
 * analytics node spends 92% of its wall time blocked in `decode()`. A number taken there sizes *the
 * government feed*; it is not a hardware ceiling. Constants are tagged `sandbox` or `venue-b` in
 * their notes and the model never mixes them.
 *
 * **2 · A per-camera event average is a fiction.** D1-09 measured a **500x** sighting-yield spread
 * across eight cameras in one city in one hour — `cam04` 33,548 against `cam03` 67. The mean is not
 * the median, and {@link EVENT_RATE_ANCHORS} exposes the distribution rather than hiding it behind
 * one slider default.
 *
 * Nothing here was measured today. Every throughput figure is cited from the ticket that gathered
 * it — D1-09 (#13) took its numbers while another wave worker loaded the same laptop and its own
 * handoff says to re-measure on a quiet `main` before anything quotes them. **That re-run is D4-04's
 * job.** Re-taking them here would have measured our own contention.
 */

/** How much a number is worth. See the file header. */
export type Provenance = 'measured' | 'listed' | 'assumed';

export interface SizingConstant {
  /** Stable identifier — the override key, and the anchor the UI and the export both cite. */
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly provenance: Provenance;
  /** The ticket, vendor or reasoning. Never empty — a test enforces it. */
  readonly source: string;
  /** What the reader has to know to use the number correctly. Never empty. */
  readonly note: string;
  /** True when the value is meant to be edited in the UI (a cost or policy assumption). */
  readonly editable: boolean;
}

function c(k: Omit<SizingConstant, 'editable'> & { editable?: boolean }): SizingConstant {
  return { editable: false, ...k };
}

// ── Measured: throughput and yield ──────────────────────────────────────────────────────────────

/**
 * The 22-minute sandbox soak, as published on #13. These four raw totals are the base every
 * derived throughput figure in this file is computed from, so a reader can redo the division.
 */
export const SOAK = {
  windowSeconds: 1319.5,
  cameras: 8,
  framesDecoded: 34_494,
  inferenceCalls: 23_023,
  sightings: 112_817,
  busiestCameraSightings: 33_548, // cam04
  quietestCameraSightings: 67, // cam03
} as const;

/** The 5-minute ANPR run, as published on #15. */
export const ANPR_RUN = {
  windowSeconds: 302.7,
  cameras: 8,
  frames: 9_670,
  sightings: 27_918,
  tracks: 640,
  plateDetectionCalls: 4_127,
  ocrCalls: 83,
} as const;

export const CAMERA_EFFECTIVE_FPS = c({
  key: 'cameraEffectiveFps',
  label: 'Effective fps delivered per sandbox camera',
  value: 4.0,
  unit: 'fps',
  provenance: 'measured',
  source: 'D1-09 (#13) — 8-camera, 22-minute soak',
  note: 'Median of the effective (wall-clock) column: min 1.92 / median 4.00 / max 4.98. The streams *carry* 15–30 fps by PTS; the gateway *delivers* about 4. Every capacity claim about the government feed must use this column, never the PTS one — the difference is roughly tenfold.',
});

export const INFERENCE_P50_MS = c({
  key: 'inferenceP50Ms',
  label: 'Vehicle detection latency, p50',
  value: 18.91,
  unit: 'ms',
  provenance: 'measured',
  source: 'D1-09 (#13) — YOLO11n, Apple Silicon MPS, 8 cameras concurrent',
  note: 'p95 47.02 ms. Latency under 8-way concurrency, not a serial cost — quoting it without the concurrency is meaningless.',
});

export const PLATE_DETECT_P50_MS = c({
  key: 'plateDetectP50Ms',
  label: 'Plate detection latency, p50',
  value: 252.0,
  unit: 'ms',
  provenance: 'measured',
  source: 'D2-01 (#15) — YOLO-v9-s ONNX on CPU, 8 cameras concurrent',
  note: 'The same model measured 46 ms against ONE camera and 252 ms against eight: eight decode threads serialise on one ONNX session behind a lock. A capacity claim extrapolated from the single-camera figure is wrong by 5x. This is 13x the vehicle detector and it runs on the CPU, so the ANPR bottleneck on this stack is not the GPU.',
});

export const OCR_P50_MS = c({
  key: 'ocrP50Ms',
  label: 'Plate OCR latency, p50',
  value: 19.2,
  unit: 'ms',
  provenance: 'measured',
  source: 'D2-01 (#15) — fast_plate_ocr ONNX on CPU',
  note: 'Runs three times per track against plate detection once per tracked vehicle per examined frame: 4,127 detection calls against 83 OCR calls in the same run, a 50x call ratio and a 654x time ratio. Optimising the OCR is optimising the wrong stage.',
});

export const MOTION_GATE_SKIP_RATIO = c({
  key: 'motionGateSkipRatio',
  label: 'Frames skipped by the motion gate',
  value: 0.325,
  unit: 'fraction',
  provenance: 'measured',
  source: 'D1-09 (#13) — live sandbox traffic',
  note: '59.9% on the local MediaMTX mix. Each frame is compared against the last *inferred* one with a 2 s-of-PTS keep-alive, so a camera that is idle most of the time costs proportionally less. This is the lever: most cameras in a 100,000-camera estate are idle most of the day.',
});

export const UPSTREAM_BOUND_SHARE = c({
  key: 'upstreamBoundShare',
  label: 'Analytics wall time blocked waiting on the gateway',
  value: 0.92,
  unit: 'fraction',
  provenance: 'measured',
  source: 'D1-09 (#13) — 8-camera sandbox soak',
  note: "D3-10 (#33) recomputed 93.9% from a different pair of published totals; the two use different denominators and must not be mixed. This model quotes D1-09's own headline 92% throughout. Either way the finding is the same: the node running the government feed is idle roughly fifteen-sixteenths of the time, so on that feed the bottleneck is the gateway, not the accelerator.",
});

export const VENUE_B_UTILISATION = c({
  key: 'venueBUtilisation',
  label: 'Loop utilisation at real-time rates (local MediaMTX)',
  value: 0.4729,
  unit: 'fraction',
  provenance: 'measured',
  source: 'D1-09 (#13) — 681 s of loop work in a 180 s window across 8 threads',
  note: '681 / (8 x 180) = 47.29%. The sources publish with `-re`, i.e. at real time, so 199.78 aggregate fps is what the pipeline *sustained* while holding all 8 cameras at 25 fps — a floor, not a ceiling. Vehicle detection only: this run did not carry the ANPR plate detector.',
});

export const MEASURED_STREAMS_PER_NODE = c({
  key: 'measuredStreamsPerNode',
  label: 'Streams demonstrated concurrently on one node',
  value: 8,
  unit: 'streams',
  provenance: 'measured',
  source: 'D1-09 (#13) 22-minute soak and D2-01 (#15) 5-minute ANPR run',
  note: 'Eight of eight, no reconnects, ANPR on, sustained. This is what was *demonstrated* on one Apple Silicon laptop — and the node was 92% idle while doing it, so 8 is a floor set by how many cameras were pointed at it, not a ceiling set by the hardware.',
});

export const SIGHTINGS_PER_TRACK = c({
  key: 'sightingsPerTrack',
  label: 'Per-frame sightings per tracked vehicle',
  value: ANPR_RUN.sightings / ANPR_RUN.tracks, // 27,918 / 640 = 43.62
  unit: 'sightings/track',
  provenance: 'measured',
  source: 'D2-01 (#15) — 27,918 sightings over 640 tracks',
  note: 'The compression available for free: one summary row per track instead of one per frame is a 43.6x reduction in metadata, and it is the same argument best-shot selection already makes for crops.',
});

export const OBJECTS_PER_DECODED_FRAME = c({
  key: 'objectsPerDecodedFrame',
  label: 'Tracked objects per decoded frame',
  value: SOAK.sightings / SOAK.framesDecoded, // 112,817 / 34,494 = 3.27
  unit: 'objects/frame',
  provenance: 'measured',
  source: 'D1-09 (#13) — 112,817 sightings over 34,494 decoded frames',
  note: 'Junction cameras in daylight. A rural approach road will be far lower; see the 500x spread.',
});

export const CAMERA_YIELD_SPREAD = c({
  key: 'cameraYieldSpread',
  label: 'Per-camera sighting yield spread',
  value: SOAK.busiestCameraSightings / SOAK.quietestCameraSightings, // 500.7
  unit: 'x',
  provenance: 'measured',
  source: 'D1-09 (#13) — cam04 33,548 against cam03 67, same city, same hour',
  note: 'The single most important caveat in this model. An events/camera/day mean is not a median and must never be presented as a typical camera: cam03 is not broken, it decoded 5,582 frames and simply watches a quiet road. Size storage from a distribution, and size peak backhaul from the busy tail.',
});

// ── Measured: bytes ─────────────────────────────────────────────────────────────────────────────

export const EVENT_WIRE_BYTES = c({
  key: 'eventWireBytes',
  label: 'One sighting event on the wire (JSON)',
  value: 358.3,
  unit: 'B/event',
  provenance: 'measured',
  source: 'D3-08 — `JSON.stringify` of the shipped `Sighting` schema, blended 967:33',
  note: "A plain sighting serialises to 348 B and a best shot with a plate read and two crop URIs to 659 B; blended at D2-02's measured 33 best shots per 1,000 sightings gives 358.3 B. Serialiser-measured, so it excludes stream framing and any transport compression — Valkey Streams field names and gzip both move it, in opposite directions. PROJECT.md section 9 assumed 400 B, which this corroborates as a fair conservative round-up.",
});

export const SIGHTING_ROW_BYTES = c({
  key: 'sightingRowBytes',
  label: 'One sighting at rest in PostgreSQL, including indexes',
  value: 327.4,
  unit: 'B/row',
  provenance: 'measured',
  source: 'D3-08 — 100,000 rows into a `like sightings including indexes` probe table',
  note: 'Heap 19,505,152 B (195.1 B/row) plus indexes 13,189,120 B, total 32,735,232 B over 100,000 rows. Measured on `saakshi_d3_08` and the probe table dropped afterwards. This is a storage-layout fact, not a rate, so it does not depend on machine load. It excludes TimescaleDB columnar compression, which is not enabled on this hypertable and would reduce it substantially — headroom this model deliberately does not claim.',
});

export const CROP_BYTES_MEASURED = c({
  key: 'cropBytesMeasured',
  label: 'One stored best-shot crop, measured',
  value: 2912,
  unit: 'B/crop',
  provenance: 'measured',
  source: 'D2-02 (#16) — 838 crops, 2,440,661 B, JPEG quality 82',
  note: 'PROVISIONAL, and D2-02 says so in `docs/evidence-store.md` section 7. The replay frames were 682x384 to 1536x864 with a median box long edge of 75 px, so a 1080p live feed will produce larger crops. Do not adopt this as the estate figure; the model uses it as the LOW end of a band.',
});

export const CROP_BYTES_CEILING = c({
  key: 'cropBytesCeiling',
  label: 'One stored best-shot crop, conservative ceiling',
  value: 15_000,
  unit: 'B/crop',
  provenance: 'assumed',
  source: 'PROJECT.md section 9 first-pass estimate, retained deliberately',
  note: "D2-02 measured 2,912 B on small frames and explicitly instructed D3-08 *not* to rewrite section 9's 15 KB down to it. The honest statement is a band: the true figure on this estate is between 3 KB and 15 KB pending a live-feed measurement, which is one command once the gateway is free. Every storage and cost output in this model is a range for exactly this reason.",
});

export const CROPS_PER_1000_SIGHTINGS = c({
  key: 'cropsPer1000Sightings',
  label: 'Best-shot crops kept per 1,000 sightings',
  value: 33.0,
  unit: 'crops/1000',
  provenance: 'measured',
  source: 'D2-02 (#16) — 838 crops from 25,367 sightings',
  note: 'The figure in D2-02 that is NOT provisional. Best-shot selection discards about 97% of the crops a naive design would store, and that ratio is a property of the tracker and the selector rather than of the frame size — it holds at any resolution.',
});

export const CROP_BYTES_PER_1000_SIGHTINGS = c({
  key: 'cropBytesPer1000Sightings',
  label: 'Crop bytes per 1,000 sightings, measured',
  value: 96_214,
  unit: 'B/1000 sightings',
  provenance: 'measured',
  source: 'D2-02 (#16) — 96,214 B = 94.0 KiB per 1,000 sightings',
  note: "The measured product of the two constants above (33.0 x 2,912 = 96,096, within rounding). Carried explicitly because it is the figure D2-02 published and the one this ticket's AC names.",
});

// ── Listed / assumed: the feed and the estate ───────────────────────────────────────────────────

export const VIDEO_BITRATE_MBPS = c({
  key: 'videoBitrateMbps',
  label: 'Per-camera video bitrate if streamed centrally',
  value: 2.0,
  unit: 'Mbps',
  provenance: 'assumed',
  source: 'PROJECT.md section 9 first-pass estimate',
  note: 'A mixed-resolution H.264 estate average. The real estate carries six distinct resolutions (D1-05 #9): 854x480 x12, 1920x1080 x11, 1280x960 x3, 1280x720 x2, 640x480, 960x576 — so a single bitrate is a simplification, and 2 Mbps sits in the right place for that mix. Editable, because a department that streams 1080p at 4 Mbps should see its own number.',
  editable: true,
});

export const DISTRICT_NODES = c({
  key: 'districtNodes',
  label: 'District edge nodes',
  value: 33,
  unit: 'nodes',
  provenance: 'listed',
  source: 'Gujarat has 33 districts',
  note: 'One aggregation node per district is the natural administrative boundary and matches how the estate is owned — 26 departments publish into it. Editable: a design that puts nodes at police-range level instead would use 4.',
  editable: true,
});

export const GATEWAY_THROTTLE_SLOW_S = c({
  key: 'gatewayThrottleSlowS',
  label: 'Worst observed gateway response for a 1.3 KB fetch',
  value: 63,
  unit: 's',
  provenance: 'measured',
  source: 'D1-03 (#7) — same `cameras.json`, 4.2 s against 63 s',
  note: "Not an input to any output here. Carried because it is the third independent corroboration of the throttle that makes the effective-fps column what it is, alongside D1-09's ~4 fps and D3-07's 6 s HLS segment delivered in 22–49 s (0.12x–0.28x real time).",
});

// ── Listed / assumed: hot-warm-cold policy ──────────────────────────────────────────────────────

export const HOT_TIER_DAYS = c({
  key: 'hotTierDays',
  label: 'Hot tier window',
  value: 7,
  unit: 'days',
  provenance: 'assumed',
  source: 'D3-08 modelling choice',
  note: 'NVMe, sub-second retrieval. Chosen to cover the window in which an investigation is actively running. D3-05 (#28) found that 0 of 30 sandbox cameras declare a retention period at all, so there is no departmental policy to copy here — this is our proposal, not their practice.',
  editable: true,
});

export const WARM_TIER_DAYS = c({
  key: 'warmTierDays',
  label: 'Warm tier window (cumulative)',
  value: 90,
  unit: 'days',
  provenance: 'assumed',
  source: 'D3-08 modelling choice',
  note: 'Object store, seconds to retrieve. Matches the 90-day rule already applied to `evidence/watchlist/` by `npm run evidence:retention` (D2-02). Anything older is cold archive.',
  editable: true,
});

// ── Listed / assumed: unit costs (INR) ──────────────────────────────────────────────────────────

export const ACCELERATOR_NODE_CAPEX_INR = c({
  key: 'acceleratorNodeCapexInr',
  label: 'Capex per accelerator, including its share of the host',
  value: 650_000,
  unit: 'INR/accelerator',
  provenance: 'assumed',
  source: 'D3-08 modelling choice — Indian list pricing for an L4-class 1U inference server',
  note: 'We have not procured one. Treat as an order-of-magnitude placeholder and replace it with a real quotation before any budget rests on it; the whole point of making it editable is that a procurement officer can.',
  editable: true,
});

export const ACCELERATOR_NODE_POWER_W = c({
  key: 'acceleratorNodePowerW',
  label: 'Sustained draw per accelerator node',
  value: 450,
  unit: 'W',
  provenance: 'listed',
  source: 'Vendor TDP for an L4-class 1U inference server under sustained load',
  note: 'Vendor-listed, not measured by us. For contrast, the measured Apple Silicon node carried 8 concurrent ANPR streams inside a laptop power envelope — but it was 92% idle on this feed, so that comparison flatters us and the model does not use it.',
  editable: true,
});

export const DATACENTRE_PUE = c({
  key: 'datacentrePue',
  label: 'Power usage effectiveness',
  value: 1.5,
  unit: 'x',
  provenance: 'assumed',
  source: 'D3-08 modelling choice — typical for a district-level room, not a hyperscale hall',
  note: 'District edge rooms are small and rarely well cooled. A state data centre would be nearer 1.3.',
  editable: true,
});

export const POWER_TARIFF_INR_PER_KWH = c({
  key: 'powerTariffInrPerKwh',
  label: 'Electricity tariff',
  value: 8.0,
  unit: 'INR/kWh',
  provenance: 'listed',
  source: 'Gujarat HT industrial tariff band, order of magnitude',
  note: 'Government establishments are billed on their own schedule and the real figure should come from the department. Editable.',
  editable: true,
});

export const HOT_STORAGE_INR_PER_TB_MONTH = c({
  key: 'hotStorageInrPerTbMonth',
  label: 'Hot tier storage',
  value: 2_500,
  unit: 'INR/TB/month',
  provenance: 'assumed',
  source: 'D3-08 modelling choice — on-premise NVMe, amortised',
  note: 'On-premise, so this is amortised hardware plus its share of the room, not a cloud line item.',
  editable: true,
});

export const WARM_STORAGE_INR_PER_TB_MONTH = c({
  key: 'warmStorageInrPerTbMonth',
  label: 'Warm tier storage',
  value: 700,
  unit: 'INR/TB/month',
  provenance: 'assumed',
  source: 'D3-08 modelling choice — on-premise object store (MinIO on spinning disk)',
  note: 'The shipped evidence store is MinIO, which is what this line prices.',
  editable: true,
});

export const COLD_STORAGE_INR_PER_TB_MONTH = c({
  key: 'coldStorageInrPerTbMonth',
  label: 'Cold tier storage',
  value: 180,
  unit: 'INR/TB/month',
  provenance: 'assumed',
  source: 'D3-08 modelling choice — archive tier, retrieval measured in hours',
  note: 'Deep archive. Anything a live investigation might need should not be here.',
  editable: true,
});

export const BACKHAUL_INR_PER_MBPS_MONTH = c({
  key: 'backhaulInrPerMbpsMonth',
  label: 'Managed backhaul capacity',
  value: 400,
  unit: 'INR/Mbps/month',
  provenance: 'assumed',
  source: 'D3-08 modelling choice — leased capacity on GSWAN-class connectivity',
  note: 'The single most leveraged cost line in the whole model, because it is the one the architecture actually changes. Editable, and worth editing first.',
  editable: true,
});

export const NODES_PER_FTE = c({
  key: 'nodesPerFte',
  label: 'Accelerator nodes one engineer can operate',
  value: 40,
  unit: 'nodes/FTE',
  provenance: 'assumed',
  source: 'D3-08 modelling choice',
  note: 'Assumes the observability shipped in D3-10 (#33) — Prometheus, Grafana, camera-down alerting verified firing at exactly `for: 5m`. Without it this number is far lower, which is the cost-benefit argument for having built it.',
  editable: true,
});

export const OPS_FTE_INR_PER_YEAR = c({
  key: 'opsFteInrPerYear',
  label: 'Fully loaded cost of one operations engineer',
  value: 1_800_000,
  unit: 'INR/year',
  provenance: 'assumed',
  source: 'D3-08 modelling choice',
  note: 'Editable.',
  editable: true,
});

export const SOFTWARE_LICENCE_INR_PER_CAMERA_YEAR = c({
  key: 'softwareLicenceInrPerCameraYear',
  label: 'Per-camera software licence',
  value: 0,
  unit: 'INR/camera/year',
  provenance: 'measured',
  source: 'D3-08 — the shipped dependency set, verified in `docs/model-licences.md`',
  note: 'Zero, and this is a fact about the repository rather than a promise. The entire stack is open source. The one proprietary dependency is the optional NL-query LLM, and it sits behind a `QueryCompiler` interface with an `ollama` local provider and a `none` provider — with either of those the system is fully functional and fully open. A commercial VMS-plus-ANPR estate typically prices this line per camera per year, and at 80,000 cameras that term alone dominates every other number on this page.',
  editable: true,
});

export const HARDWARE_REFRESH_YEARS = c({
  key: 'hardwareRefreshYears',
  label: 'Hardware refresh cycle',
  value: 5,
  unit: 'years',
  provenance: 'assumed',
  source: 'D3-08 modelling choice',
  note: 'Used to amortise capex into the annual opex comparison.',
  editable: true,
});

export const COST_UNCERTAINTY = c({
  key: 'costUncertainty',
  label: 'Cost uncertainty band',
  value: 0.25,
  unit: 'fraction',
  provenance: 'assumed',
  source: 'D3-08 modelling choice',
  note: 'Applied outward on top of the crop-size band, so every cost in this model is a range and never a single figure. A single-figure cost estimate for an 80,000-camera estate would be the least credible number on the page.',
  editable: true,
});

// ── PROJECT.md section 9\'s own constants, kept so the discrepancy stays visible ─────────────────

/**
 * The first-pass constants from `PROJECT.md` section 9, preserved verbatim so that
 * `computeSizing` can reproduce its published figures exactly and the divergence from the measured
 * set is a diff rather than an assertion. See `docs/sizing-model.md` section 6.
 */
export const PROJECT_MD_SECTION_9 = {
  cameras: 80_000,
  videoBitrateMbps: 2.0,
  /**
   * Section 9's "~2 KB/s events" per camera, converted: 2,000 B/s x 86,400 / 400 B.
   *
   * Read as 2,000 B/s decimal rather than 2,048 — that is the reading that reproduces section 9's
   * own 1.28 Gbps and its own 125x, so it is what section 9 meant.
   */
  eventsPerCameraPerDay: 432_000,
  eventBytes: 400,
  /** The *other* number section 9 gives, from its metadata-storage bullet. They disagree. */
  storageBulletEventsPerCameraPerDay: 200,
  anprCoveragePct: 30,
  streamsPerGpu: 25,
  districtNodes: 33,
  publishedVideoGbps: 160,
  publishedMetadataGbps: 1.3,
  publishedRatio: 125,
  publishedGpus: 960,
  publishedMetadataTbPerYear: 2.3,
  publishedCropTbPerYear: 17,
} as const;

// ── Registry ────────────────────────────────────────────────────────────────────────────────────

export const SIZING_CONSTANTS = {
  cameraEffectiveFps: CAMERA_EFFECTIVE_FPS,
  inferenceP50Ms: INFERENCE_P50_MS,
  plateDetectP50Ms: PLATE_DETECT_P50_MS,
  ocrP50Ms: OCR_P50_MS,
  motionGateSkipRatio: MOTION_GATE_SKIP_RATIO,
  upstreamBoundShare: UPSTREAM_BOUND_SHARE,
  venueBUtilisation: VENUE_B_UTILISATION,
  measuredStreamsPerNode: MEASURED_STREAMS_PER_NODE,
  sightingsPerTrack: SIGHTINGS_PER_TRACK,
  objectsPerDecodedFrame: OBJECTS_PER_DECODED_FRAME,
  cameraYieldSpread: CAMERA_YIELD_SPREAD,
  eventWireBytes: EVENT_WIRE_BYTES,
  sightingRowBytes: SIGHTING_ROW_BYTES,
  cropBytesMeasured: CROP_BYTES_MEASURED,
  cropBytesCeiling: CROP_BYTES_CEILING,
  cropsPer1000Sightings: CROPS_PER_1000_SIGHTINGS,
  cropBytesPer1000Sightings: CROP_BYTES_PER_1000_SIGHTINGS,
  videoBitrateMbps: VIDEO_BITRATE_MBPS,
  districtNodes: DISTRICT_NODES,
  gatewayThrottleSlowS: GATEWAY_THROTTLE_SLOW_S,
  hotTierDays: HOT_TIER_DAYS,
  warmTierDays: WARM_TIER_DAYS,
  acceleratorNodeCapexInr: ACCELERATOR_NODE_CAPEX_INR,
  acceleratorNodePowerW: ACCELERATOR_NODE_POWER_W,
  datacentrePue: DATACENTRE_PUE,
  powerTariffInrPerKwh: POWER_TARIFF_INR_PER_KWH,
  hotStorageInrPerTbMonth: HOT_STORAGE_INR_PER_TB_MONTH,
  warmStorageInrPerTbMonth: WARM_STORAGE_INR_PER_TB_MONTH,
  coldStorageInrPerTbMonth: COLD_STORAGE_INR_PER_TB_MONTH,
  backhaulInrPerMbpsMonth: BACKHAUL_INR_PER_MBPS_MONTH,
  nodesPerFte: NODES_PER_FTE,
  opsFteInrPerYear: OPS_FTE_INR_PER_YEAR,
  softwareLicenceInrPerCameraYear: SOFTWARE_LICENCE_INR_PER_CAMERA_YEAR,
  hardwareRefreshYears: HARDWARE_REFRESH_YEARS,
  costUncertainty: COST_UNCERTAINTY,
} as const;

export type ConstantKey = keyof typeof SIZING_CONSTANTS;

/** Numeric overrides keyed by constant. Anything absent falls back to the registry value. */
export type SizingOverrides = Partial<Record<ConstantKey, number>>;

export const CONSTANT_KEYS = Object.keys(SIZING_CONSTANTS) as ConstantKey[];

/** The constants a reader is expected to edit — the cost and policy assumptions. */
export const EDITABLE_CONSTANT_KEYS: ConstantKey[] = CONSTANT_KEYS.filter(
  (k) => SIZING_CONSTANTS[k].editable,
);

export function constantValue(key: ConstantKey, overrides: SizingOverrides = {}): number {
  const override = overrides[key];
  return override === undefined ? SIZING_CONSTANTS[key].value : override;
}

/** The registry entry with any override folded in, so the UI and the export cite what was used. */
export function resolvedConstant(
  key: ConstantKey,
  overrides: SizingOverrides = {},
): SizingConstant {
  const override = overrides[key];
  if (override === undefined) return SIZING_CONSTANTS[key];
  return {
    ...SIZING_CONSTANTS[key],
    value: override,
    provenance: 'assumed',
    source: `Overridden by the reader (registry default ${SIZING_CONSTANTS[key].value} ${SIZING_CONSTANTS[key].unit}, ${SIZING_CONSTANTS[key].provenance})`,
  };
}

// ── Event-rate anchors: the distribution, not a single default ──────────────────────────────────

export interface EventRateAnchor {
  readonly id: string;
  readonly label: string;
  readonly eventsPerCameraPerDay: number;
  /**
   * How many raw per-frame sightings one event of this kind stands for.
   *
   * 1 when the event *is* a per-frame sighting; 43.62 when it is a per-track summary. Crop volume
   * follows the sighting rate, not the event rate — D2-02's 33 crops per 1,000 is a ratio against
   * *sightings* — so without this factor a per-track scenario would undercount crops by 43.6x.
   */
  readonly sightingsPerEvent: number;
  readonly provenance: Provenance;
  readonly source: string;
  readonly note: string;
}

const perCameraPerSecond = SOAK.sightings / SOAK.cameras / SOAK.windowSeconds; // 10.687
const busiestPerSecond = SOAK.busiestCameraSightings / SOAK.windowSeconds; // 25.42
const quietestPerSecond = SOAK.quietestCameraSightings / SOAK.windowSeconds; // 0.0508

/**
 * What to put in the events/camera/day field, and why none of them is "the" answer.
 *
 * D1-09 measured a 500x spread across eight cameras in one city in one hour. Offering a single
 * default would hide the only thing about this input that matters, so the UI offers the
 * distribution and the export prints all of it.
 *
 * Every figure here extrapolates a daytime measurement across 24 hours, which overstates the
 * overnight hours on every one of these cameras. Stated rather than silently corrected, because a
 * correction factor would be an unmeasured number pretending to be a measured one.
 */
export const EVENT_RATE_ANCHORS: readonly EventRateAnchor[] = [
  {
    id: 'per-frame-mean',
    label: 'Per-frame sightings, 8-camera mean',
    eventsPerCameraPerDay: Math.round(perCameraPerSecond * 86_400),
    sightingsPerEvent: 1,
    provenance: 'measured',
    source: 'D1-09 (#13) — 112,817 sightings / 8 cameras / 1319.5 s',
    note: 'What the PoC write path produces today: one row per tracked object per inferred frame. At estate scale this is not storable, and saying so is the finding — it is what motivates the per-track anchor below.',
  },
  {
    id: 'per-frame-busiest',
    label: 'Per-frame sightings, busiest camera (cam04)',
    eventsPerCameraPerDay: Math.round(busiestPerSecond * 86_400),
    sightingsPerEvent: 1,
    provenance: 'measured',
    source: 'D1-09 (#13) — cam04, 33,548 sightings in 1319.5 s',
    note: 'Size peak backhaul from this, not from the mean.',
  },
  {
    id: 'per-frame-quietest',
    label: 'Per-frame sightings, quietest camera (cam03)',
    eventsPerCameraPerDay: Math.round(quietestPerSecond * 86_400),
    sightingsPerEvent: 1,
    provenance: 'measured',
    source: 'D1-09 (#13) — cam03, 67 sightings in 1319.5 s',
    note: 'cam03 is not broken: it decoded 5,582 frames and watches a quiet road. 500x below cam04 in the same city in the same hour.',
  },
  {
    id: 'per-track',
    label: 'One summary row per track',
    eventsPerCameraPerDay: Math.round((perCameraPerSecond * 86_400) / SIGHTINGS_PER_TRACK.value),
    sightingsPerEvent: SIGHTINGS_PER_TRACK.value,
    provenance: 'measured',
    source: 'D1-09 (#13) rate divided by D2-01 (#15) 43.62 sightings per track',
    note: 'The mean rate summarised one row per vehicle-passage instead of one per frame. This is the design the estate-scale numbers assume, and it is the same compression best-shot selection already applies to crops.',
  },
  {
    id: 'project-md',
    label: 'PROJECT.md section 9 storage bullet',
    eventsPerCameraPerDay: PROJECT_MD_SECTION_9.storageBulletEventsPerCameraPerDay,
    sightingsPerEvent: 1,
    provenance: 'assumed',
    source: 'PROJECT.md section 9, "~200 events/day"',
    note: 'Kept so the discrepancy stays visible: section 9 sized its metadata *backhaul* from ~2 KB/s (about 442,000 events/day) and its metadata *storage* from 200 events/day, in adjacent bullets. Those disagree by roughly 2,200x and both cannot be right.',
  },
];

// ── Accelerator classes ─────────────────────────────────────────────────────────────────────────

export interface AcceleratorClass {
  readonly id: string;
  readonly label: string;
  /** Concurrent camera streams one accelerator carries at {@link atFps}. */
  readonly streams: number;
  readonly atFps: number;
  readonly provenance: Provenance;
  readonly source: string;
  readonly note: string;
}

/**
 * Streams per accelerator, derived from measured throughput.
 *
 * The demonstrated figure is 8 streams on one Apple Silicon node with ANPR running, and D1-09
 * measured that node **92% blocked in `decode()`** — so the linear extrapolation to a saturated
 * node is `8 / (1 - 0.92)`. It is an extrapolation and it is tagged as one: D1-09's handoff states
 * plainly that the device ceiling has not been measured.
 *
 * The extrapolation is worth doing because it can be cross-checked against a second, independent
 * measurement. At the sandbox's ~4 effective fps it gives about 400 stream-fps of capacity. The
 * local-MediaMTX run held 8 cameras at 25 fps with the loop 47.29% utilised, which extrapolates to
 * about 423 stream-fps. **Two runs, two venues, two different bottlenecks, 6% apart** — which is
 * the reassurance a first-pass estimate never gets.
 */
export function deriveExtrapolatedStreams(overrides: SizingOverrides = {}): number {
  const demonstrated = constantValue('measuredStreamsPerNode', overrides);
  const idle = constantValue('upstreamBoundShare', overrides);
  return demonstrated / (1 - idle);
}

/** The same capacity expressed as stream-fps, for the cross-check above. */
export function extrapolatedStreamFps(overrides: SizingOverrides = {}): number {
  return deriveExtrapolatedStreams(overrides) * constantValue('cameraEffectiveFps', overrides);
}

export function venueBStreamFps(overrides: SizingOverrides = {}): number {
  const demonstrated = constantValue('measuredStreamsPerNode', overrides);
  return (demonstrated / constantValue('venueBUtilisation', overrides)) * 25;
}

export function acceleratorClasses(overrides: SizingOverrides = {}): readonly AcceleratorClass[] {
  const effectiveFps = constantValue('cameraEffectiveFps', overrides);
  const extrapolated = deriveExtrapolatedStreams(overrides);
  return [
    {
      id: 'measured-demonstrated',
      label: 'Apple Silicon MPS — demonstrated',
      streams: constantValue('measuredStreamsPerNode', overrides),
      atFps: effectiveFps,
      provenance: 'measured',
      source: 'D1-09 (#13) 22-minute soak + D2-01 (#15) ANPR run',
      note: 'Eight concurrent streams with ANPR on, sustained, zero reconnects — on a laptop. The honest floor: it is what we ran, not what the hardware can do, and the node was 92% idle throughout.',
    },
    {
      id: 'measured-extrapolated',
      label: 'Apple Silicon MPS — extrapolated to a saturated node',
      streams: extrapolated,
      atFps: effectiveFps,
      provenance: 'assumed',
      source: 'Measured base (8 streams, 92% idle, D1-09 #13) scaled linearly',
      note: 'Linear scaling of a measured base, and linear scaling is the assumption. Cross-checks to within 6% of the independent local-MediaMTX run. D1-09 states the true ceiling has not been measured.',
    },
    {
      id: 'nvidia-t4',
      label: 'NVIDIA T4',
      streams: 12,
      atFps: 25,
      provenance: 'listed',
      source: 'Vendor class figure for a T4-class DeepStream ANPR pipeline',
      note: "NOT ours. There is no NVIDIA GPU on this machine and D1-09's CUDA path is unit-tested by monkeypatching `torch`, never by execution. Any CUDA figure in this model is vendor-sourced and labelled as such.",
    },
    {
      id: 'nvidia-l4',
      label: 'NVIDIA L4 / A10 class',
      streams: PROJECT_MD_SECTION_9.streamsPerGpu,
      atFps: 25,
      provenance: 'listed',
      source: 'PROJECT.md section 9 first-pass, an L4/A10-class vendor figure',
      note: "NOT ours — vendor-listed, and the basis of section 9's ~960 GPUs, kept so that figure can be reproduced exactly. Our own measured node extrapolates to about 16 streams at 25 fps, which lands in the same order: the section 9 estimate was fair, and now it has a measurement beside it instead of only a citation.",
    },
    {
      id: 'nvidia-a100',
      label: 'NVIDIA A100',
      streams: 60,
      atFps: 25,
      provenance: 'listed',
      source: 'Vendor class figure',
      note: 'NOT ours. Listed for procurement comparison only.',
    },
  ];
}

export type AcceleratorClassId = ReturnType<typeof acceleratorClasses>[number]['id'];
