/**
 * Scenario -> Markdown, for direct paste into the HLD and the deck (D3-08).
 *
 * D3-08's handoff to D4-04 and D4-05 says it plainly: *Infrastructure Sizing* and *Cost-Benefit
 * Analysis* are mandatory HLD dimensions and must not be hand-written. They are generated here, from
 * the same `computeSizing` the screen calls, so the document and the product can never drift apart.
 *
 * The output is deliberately plain CommonMark — headings, tables, bullets — with no HTML and no
 * front matter, because it is pasted into another document rather than rendered on its own.
 */
import {
  type ConstantKey,
  EVENT_RATE_ANCHORS,
  PROJECT_MD_SECTION_9,
  type SizingOverrides,
  acceleratorClasses,
  constantValue,
  deriveExtrapolatedStreams,
  extrapolatedStreamFps,
  resolvedConstant,
  venueBStreamFps,
} from './constants.js';
import { type Band, type SizingResult, computeSizing } from './model.js';
import { SECTION_9_REPRODUCTION, type SizingPreset } from './presets.js';

const PROVENANCE_LABEL: Record<string, string> = {
  measured: '**measured**',
  listed: 'listed',
  assumed: 'assumed',
};

function num(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return '∞';
  return n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function int(n: number): string {
  return Math.round(n).toLocaleString('en-GB');
}

/** Indian numbering, because the reader budgets in crore and lakh, not in millions. */
export function formatInr(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e7) return `INR ${num(n / 1e7, 2)} crore`;
  if (abs >= 1e5) return `INR ${num(n / 1e5, 2)} lakh`;
  return `INR ${int(n)}`;
}

export function formatInrBand(b: Band): string {
  if (Math.abs(b.high - b.low) < 1e-9) return formatInr(b.low);
  return `${formatInr(b.low)} – ${formatInr(b.high)}`;
}

function tbBand(b: Band, dp = 1): string {
  if (Math.abs(b.high - b.low) < 1e-9) return `${num(b.low, dp)} TB`;
  return `${num(b.low, dp)} – ${num(b.high, dp)} TB`;
}

export interface ScenarioMarkdownOptions {
  readonly preset: SizingPreset;
  readonly overrides?: SizingOverrides;
  /** Include the PROJECT.md section 9 reconciliation. On for the generated doc. */
  readonly includeSection9?: boolean;
  /** Include the full provenance table. On for the generated doc. */
  readonly includeProvenance?: boolean;
}

function backhaulSection(r: SizingResult): string {
  const b = r.backhaul;
  return [
    '## 1 · Backhaul',
    '',
    '| | Gbps |',
    '|---|---|',
    `| Every camera streamed centrally (Model 4 as written) | **${num(b.allCentralVideoGbps)}** |`,
    `| Video still travelling under this split | ${num(b.videoBackhaulGbps, 3)} |`,
    `| Events from the ${int(b.edgeCameras)} cameras analysed at the edge | **${num(b.metadataBackhaulGbps, 3)}** |`,
    `| Total under this architecture | **${num(b.totalBackhaulGbps, 3)}** |`,
    `| **Reduction** | **${num(b.reductionRatio, 1)}x** |`,
    '',
    `At a full edge split the ratio is **${num(b.metadataOnlyRatio, 1)}x**: video stays where it is and`,
    'only events travel, with video pulled on demand per incident over the existing feed path.',
    '',
    'The arithmetic, so it can be checked without the source:',
    '',
    `- Video: ${int(r.inputs.cameras)} cameras x ${num(constantValueOf(r, 'videoBitrateMbps'), 1)} Mbps = ${num(b.allCentralVideoGbps)} Gbps`,
    `- Events: ${int(b.edgeCameras)} cameras x ${int(r.inputs.eventsPerCameraPerDay)} events/day x ${num(constantValueOf(r, 'eventWireBytes'), 1)} B x 8 / 86,400 s = ${num(b.metadataBackhaulGbps, 3)} Gbps`,
    '',
  ].join('\n');
}

function constantValueOf(r: SizingResult, key: string): number {
  const found = r.constantsUsed.find((c) => c.key === key);
  return found === undefined ? Number.NaN : found.value;
}

function computeSection(r: SizingResult, overrides: SizingOverrides): string {
  const c = r.compute;
  const classRows = acceleratorClasses(overrides).map((k) => {
    const needed = Math.ceil(c.anprCameras / k.streams);
    return `| ${k.label} | ${num(k.streams, 1)} @ ${num(k.atFps, 2)} fps | ${int(needed)} | ${PROVENANCE_LABEL[k.provenance]} |`;
  });

  return [
    '## 2 · Compute',
    '',
    `${int(c.anprCameras)} of ${int(r.inputs.cameras)} cameras run continuous ANPR (${num(r.inputs.anprCoveragePct, 0)}%).`,
    '',
    '| Accelerator class | Streams each | Accelerators needed | Provenance |',
    '|---|---|---|---|',
    ...classRows,
    '',
    `**This scenario prices ${c.acceleratorClass.label}: ${int(c.acceleratorsRequired)} accelerators`,
    `across ${int(c.districtNodes)} district nodes — ${num(c.acceleratorsPerDistrictNodeMean, 1)} per node`,
    `(${int(c.acceleratorsPerDistrictNode)} racked).**`,
    '',
    '### Where the streams-per-accelerator figure comes from',
    '',
    'It is measured, and it is measured twice, in two venues, with two different bottlenecks.',
    '',
    `- **Demonstrated.** ${int(constantValue('measuredStreamsPerNode', overrides))} concurrent camera streams with ANPR running, sustained over a 22-minute soak and a separate 5-minute ANPR run, zero reconnects, on one Apple Silicon laptop (D1-09 #13, D2-01 #15).`,
    `- **The node was ${num(constantValue('upstreamBoundShare', overrides) * 100, 0)}% blocked in \`decode()\` the whole time** (D1-09 #13). On the government feed the bottleneck is the gateway, not the accelerator — which is the single most important sizing fact in this document.`,
    `- **Extrapolated linearly** to a saturated node: ${int(deriveExtrapolatedStreams(overrides))} streams at the sandbox's ${num(constantValue('cameraEffectiveFps', overrides), 2)} effective fps, i.e. about ${int(extrapolatedStreamFps(overrides))} stream-fps of capacity.`,
    `- **Cross-check.** An independent run against local MediaMTX held 8 cameras at 25 fps with the loop ${num(constantValue('venueBUtilisation', overrides) * 100, 1)}% utilised, which extrapolates to about ${int(venueBStreamFps(overrides))} stream-fps. Two venues, two bottlenecks, **${num((Math.abs(venueBStreamFps(overrides) - extrapolatedStreamFps(overrides)) / venueBStreamFps(overrides)) * 100, 0)}% apart**.`,
    `- Expressed at 25 fps per stream, our own extrapolation is about ${num(extrapolatedStreamFps(overrides) / 25, 0)} streams per node — beside the ${int(PROJECT_MD_SECTION_9.streamsPerGpu)} an L4/A10 is listed at. The first-pass estimate was fair.`,
    '',
    '**Honesty about the NVIDIA rows.** There is no NVIDIA GPU on this machine. The CUDA path in the',
    'analytics worker is unit-tested by monkeypatching `torch`, never by execution, so every NVIDIA',
    'figure above is vendor-listed and is labelled as such. Nothing in this document presents a CUDA',
    'number as ours.',
    '',
    '**The ANPR bottleneck is not the GPU.** Plate detection measured',
    `${num(constantValue('plateDetectP50Ms', overrides), 1)} ms p50 against eight concurrent cameras on the CPU,`,
    `against ${num(constantValue('inferenceP50Ms', overrides), 2)} ms for vehicle detection on the GPU — 13x — and the same plate`,
    'detector measured 46 ms against a *single* camera, so a capacity claim extrapolated from a',
    'one-camera measurement is wrong by 5x (D2-01 #15). Buying GPUs will not move this line; raising',
    'the size floor (`VEHICLE_MIN_BOX_PX`, `MAX_EXAMINE_PER_TRACK`) will.',
    '',
  ].join('\n');
}

function storageSection(r: SizingResult): string {
  const s = r.storage;
  const t = s.tiers;
  return [
    '## 3 · Storage',
    '',
    `| | |`,
    `|---|---|`,
    `| Events written per day | ${int(s.eventsPerDay)} |`,
    `| Vehicle passages behind them per day | ${int(s.sightingsPerDay)} |`,
    `| Metadata | **${num(s.metadataTBPerYear, 1)} TB/year**, ${num(s.metadataRetainedTB, 1)} TB retained at ${int(r.inputs.metadataRetentionDays)} days |`,
    `| Best-shot crops kept per day | ${int(s.cropsPerDay)} |`,
    `| Crops | **${tbBand(s.cropTBPerYear)}/year**, ${tbBand(s.cropRetainedTB)} retained at ${int(r.inputs.cropRetentionDays)} days |`,
    `| **Total retained** | **${tbBand(s.totalRetainedTB)}** |`,
    '',
    '### Hot / warm / cold',
    '',
    '| Tier | Window | Retained |',
    '|---|---|---|',
    `| Hot (NVMe) | 0–${int(t.hotDays)} days | ${tbBand(t.hotTB)} |`,
    `| Warm (object store) | ${int(t.hotDays)}–${int(t.hotDays + t.warmDays)} days | ${tbBand(t.warmTB)} |`,
    `| Cold (archive) | beyond ${int(t.hotDays + t.warmDays)} days | ${tbBand(t.coldTB)} |`,
    '',
    '**Read the crop line with the assumption that drives it.** Crops follow vehicle passages, not',
    'metadata rows, so summarising the rows does not reduce them — the same vehicles still drove past.',
    `This scenario carries ${int(s.sightingsPerDay / r.inputs.cameras)} passages per camera per day, which is D1-09's measured`,
    '8-camera rate extrapolated across a full 24 hours. **That extrapolation is the single largest',
    'lever on every figure in this section**, and it overstates the overnight hours on every one of',
    'those cameras. It is stated rather than silently corrected, because a correction factor would be',
    'an unmeasured number wearing a measured number\'s clothes. Halve the event rate and halve this',
    'table; the calculator exists so a reader can do exactly that and watch it move.',
    '',
    '**Why crops are a range and metadata is not.** The metadata figure rests on a storage-layout',
    'measurement that does not vary — 100,000 rows into a `like sightings including indexes` probe',
    'table gave 195.1 B of heap and 327.4 B including indexes. The crop figure rests on a measurement',
    'D2-02 explicitly marked provisional: mean 2,912 B, but taken on 682x384–1536x864 replay frames',
    'with a median box long edge of 75 px, so a 1080p live feed will produce larger crops. The honest',
    "statement is a band between 3 KB and 15 KB, and it is one command to close once the gateway is",
    'free. Every storage and cost figure here is a range for that reason.',
    '',
    '**The compression that is not provisional: 33 crops per 1,000 sightings.** Best-shot selection',
    'discards about 97% of the crops a naive design would store, and that ratio is a property of the',
    'tracker and the selector rather than of the frame size, so it holds at any resolution (D2-02 #16).',
    '',
    '**Not claimed:** TimescaleDB columnar compression is not enabled on the sightings hypertable, so',
    'the metadata figure above is uncompressed. That is headroom this model deliberately leaves on the',
    'table rather than counting.',
    '',
  ].join('\n');
}

function costSection(r: SizingResult): string {
  const c = r.cost;
  const lines = c.lines.map(
    (l) => `| ${l.label} | ${formatInrBand(l.inrPerYear)} | ${l.basis} |`,
  );
  return [
    '## 4 · Cost',
    '',
    'Every unit cost below is an editable assumption, and the calculator shows it as one. A',
    'single-figure cost estimate for an estate this size would be the least credible number on the',
    `page, so each line carries the crop-size band and a further +/-${num(constantValueOf(r, 'costUncertainty') * 100, 0)}% uncertainty on top of it.`,
    '',
    '| Line | Per year | Basis |',
    '|---|---|---|',
    ...lines,
    `| **Annual opex** | **${formatInrBand(c.annualOpexInr)}** | sum of the above |`,
    '',
    '| | |',
    '|---|---|',
    `| Capex (accelerators) | ${formatInrBand(c.capexInr)} |`,
    `| Capex amortised over ${int(constantValueOf(r, 'hardwareRefreshYears'))} years | ${formatInrBand(c.amortisedCapexInrPerYear)}/year |`,
    `| **Total annual cost** | **${formatInrBand(c.totalAnnualCostInr)}** |`,
    `| **Per camera per year** | **${formatInrBand(c.annualCostPerCameraInr)}** |`,
    '',
    '**The licence line is zero, and that is a fact about the repository rather than a promise.** The',
    'whole stack is open source. The one proprietary dependency is the optional natural-language query',
    'LLM, and it sits behind a `QueryCompiler` interface with an `ollama` local provider and a `none`',
    'provider — with either selected the system is fully functional and fully open. A commercial',
    'VMS-plus-ANPR estate prices this line per camera per year, and at this camera count that single',
    'term would dominate every other number in this table.',
    '',
  ].join('\n');
}

function section9Section(overrides: SizingOverrides): string {
  const repro = computeSizing(SECTION_9_REPRODUCTION.inputs, {
    ...SECTION_9_REPRODUCTION.overrides,
  });
  const s9 = PROJECT_MD_SECTION_9;
  const anchors = EVENT_RATE_ANCHORS.map(
    (a) =>
      `| ${a.label} | ${int(a.eventsPerCameraPerDay)} | ${PROVENANCE_LABEL[a.provenance]} | ${a.source} |`,
  );

  return [
    '## 5 · Reconciliation with `PROJECT.md` section 9',
    '',
    "Section 9's figures were a first pass, and this ticket's acceptance criterion allows either",
    'reproducing them or correcting them. Both happened: the backhaul and GPU figures reproduce',
    "*exactly* under section 9's own constants, and the storage figures do not reproduce at all,",
    'because section 9 sized three different outputs from three mutually inconsistent event rates.',
    '',
    '### What reproduces exactly',
    '',
    "Running `computeSizing` on section 9's own inputs — 80,000 cameras, 2 Mbps, 2,000 B/s of events,",
    '400 B per event, 30% ANPR coverage, 25 streams per GPU, 33 district nodes:',
    '',
    '| Section 9 says | Model gives | |',
    '|---|---|---|',
    `| ${s9.publishedVideoGbps} Gbps central video | **${num(repro.backhaul.allCentralVideoGbps)} Gbps** | reproduced |`,
    `| ~${s9.publishedMetadataGbps} Gbps metadata | **${num(repro.backhaul.metadataBackhaulGbps, 2)} Gbps** | reproduced |`,
    `| ~${s9.publishedRatio}x | **${num(repro.backhaul.reductionRatio, 1)}x** | reproduced |`,
    `| ~${s9.publishedGpus} GPUs | **${int(repro.compute.acceleratorsRequired)}** | reproduced |`,
    `| ~29 GPUs per district node | **${num(repro.compute.acceleratorsPerDistrictNodeMean, 1)}** | reproduced |`,
    '',
    '### What does not, and why',
    '',
    'Section 9 quotes three different per-camera event rates in adjacent bullets:',
    '',
    `- **${int(s9.eventsPerCameraPerDay)} events/camera/day** — implied by "~2 KB/s events", which is what produces its ${s9.publishedMetadataGbps} Gbps.`,
    `- **${int(s9.storageBulletEventsPerCameraPerDay)} events/camera/day** — stated outright in its metadata-storage bullet, which is what produces its ${s9.publishedMetadataTbPerYear} TB/year.`,
    `- **~1,212 events/camera/day** — implied by its crop bullet's "~40/day" at D2-02's measured 33 crops per 1,000 sightings.`,
    '',
    `The first two differ by **${int(s9.eventsPerCameraPerDay / s9.storageBulletEventsPerCameraPerDay)}x**. They cannot both be right, and no single scenario can reproduce both.`,
    `Run the reproduction above — which uses the *backhaul* rate — and the metadata storage it implies is`,
    `**${num(repro.storage.metadataTBPerYear, 0)} TB/year**, not ${s9.publishedMetadataTbPerYear} TB/year.`,
    '',
    '### What the measured rates give instead',
    '',
    '| Anchor | Events/camera/day | Provenance | Source |',
    '|---|---|---|---|',
    ...anchors,
    '',
    'The correction is not that section 9 was wildly wrong — its backhaul assumption sits inside the',
    'measured range, between the per-track and per-frame rates. The correction is that it used a',
    'different rate for each output. `PROJECT.md` section 9 has been rewritten to derive all three',
    'from one rate, with this document as its source.',
    '',
  ].join('\n');
}

/**
 * Constants the document *cites in prose* without `computeSizing` reading them arithmetically —
 * the throughput measurements the compute section argues from. They belong in the provenance table
 * for the same reason as the rest: a number a reader meets in this document must be traceable from
 * this document.
 */
const DOCUMENT_CITED_CONSTANTS: readonly ConstantKey[] = [
  'measuredStreamsPerNode',
  'upstreamBoundShare',
  'cameraEffectiveFps',
  'venueBUtilisation',
  'inferenceP50Ms',
  'plateDetectP50Ms',
  'ocrP50Ms',
  'motionGateSkipRatio',
  'sightingsPerTrack',
  'cameraYieldSpread',
  'cropBytesPer1000Sightings',
  'gatewayThrottleSlowS',
];

function provenanceSection(r: SizingResult, overrides: SizingOverrides): string {
  const seen = new Set(r.constantsUsed.map((c) => c.key));
  const cited = DOCUMENT_CITED_CONSTANTS.filter((k) => !seen.has(k)).map((k) =>
    resolvedConstant(k, overrides),
  );
  const all = [...cited, ...r.constantsUsed];
  const rows = all.map(
    (c) =>
      `| \`${c.key}\` | ${c.label} | ${num(c.value, c.value >= 1000 ? 0 : 2)} ${c.unit} | ${PROVENANCE_LABEL[c.provenance]} | ${c.source} |`,
  );
  const counts = all.reduce<Record<string, number>>((acc, c) => {
    acc[c.provenance] = (acc[c.provenance] ?? 0) + 1;
    return acc;
  }, {});

  return [
    '## 6 · Every constant, and where it came from',
    '',
    `${all.length} constants: **${counts['measured'] ?? 0} measured** on this stack,`,
    `${counts['listed'] ?? 0} vendor-listed, ${counts['assumed'] ?? 0} assumed. There is no`,
    'unattributed number in this model — a test fails the build if any constant lacks a provenance tag',
    'or a source.',
    '',
    '| Key | Constant | Value | Provenance | Source |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '### Notes that change how a number should be read',
    '',
    ...all
      .filter((c) => c.provenance === 'measured')
      .map((c) => `- **${c.label}** — ${c.note}`),
    '',
  ].join('\n');
}

export function renderScenarioMarkdown(options: ScenarioMarkdownOptions): string {
  const overrides = options.overrides ?? {};
  const r = computeSizing(options.preset.inputs, overrides);
  const i = r.inputs;

  const parts: string[] = [
    `# Infrastructure sizing — ${options.preset.label}`,
    '',
    '> Generated by `npm run export:sizing`. Do not edit by hand: this file is the output of the same',
    '> model the `/sizing` screen runs, and editing it here would let the document and the product',
    "> disagree. Change the model or the scenario instead. Source: D3-08 (#31).",
    '',
    options.preset.rationale,
    '',
    '## 0 · Scenario',
    '',
    '| Input | Value |',
    '|---|---|',
    `| Cameras | ${int(i.cameras)} |`,
    `| Continuous ANPR coverage | ${num(i.anprCoveragePct, 0)}% |`,
    `| Analysed at the edge | ${num(i.edgeSharePct, 0)}% |`,
    `| Events per camera per day | ${int(i.eventsPerCameraPerDay)} |`,
    `| Vehicle passages per event | ${num(i.sightingsPerEvent, 2)} |`,
    `| Metadata retention | ${int(i.metadataRetentionDays)} days |`,
    `| Crop retention | ${int(i.cropRetentionDays)} days |`,
    `| Accelerator | ${r.compute.acceleratorClass.label} |`,
    '',
    '**The mean is not the median.** D1-09 measured a **500x** spread in sighting yield across eight',
    'cameras in one city in one hour — `cam04` produced 33,548 and `cam03` produced 67. `cam03` is not',
    'broken; it decoded 5,582 frames and watches a quiet road. Any single events-per-camera figure,',
    'including the one in the table above, describes no actual camera. Size retained storage from the',
    'mean and peak backhaul from the busy tail, and never present either as typical.',
    '',
    backhaulSection(r),
    computeSection(r, overrides),
    storageSection(r),
    costSection(r),
  ];

  if (options.includeSection9 !== false) parts.push(section9Section(overrides));
  if (options.includeProvenance !== false) parts.push(provenanceSection(r, overrides));

  parts.push(
    [
      '## 7 · What this model does not claim',
      '',
      '- **No figure here was measured today.** Every throughput constant is cited from the ticket that',
      '  gathered it. D1-09 (#13) recorded its numbers while another worker loaded the same laptop and',
      '  its own handoff instructs a re-measurement on a quiet checkout before anything quotes them;',
      '  **that re-run belongs to D4-04**, and until it lands these figures carry D1-09\'s caveat with them.',
      '- **The sandbox figures size the government feed, not hardware.** The gateway delivers about 4',
      '  effective fps against streams carrying 15–30 by PTS, and the analytics node sits 92% blocked in',
      '  `decode()`. Three independent measurements agree: D1-03 timed the same 1.3 KB fetch at 4.2 s and',
      '  63 s, and D3-07 measured a 6-second HLS segment arriving in 22–49 s, 0.12x–0.28x real time.',
      '- **No NVIDIA figure is ours.** There is no NVIDIA GPU on this machine.',
      '- **The crop size is provisional** and is presented as a 3–15 KB band, per D2-02.',
      '- **Cost unit rates are assumptions, not quotations.** Nothing here has been procured.',
      '- **0 of 30 cameras in the Gujarat catalogue declare a retention period** (D3-05 #28), so the',
      '  hot/warm/cold windows above are our proposal and not a reflection of departmental practice.',
      '',
    ].join('\n'),
  );

  return parts.join('\n');
}
