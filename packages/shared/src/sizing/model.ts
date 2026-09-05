/**
 * The sizing model (D3-08) — pure, synchronous, dependency-free.
 *
 * *Infrastructure Sizing* and *Cost-Benefit Analysis* are two of the ten mandatory design
 * dimensions. Every other team will put a static table in a PDF. This is the same table with its
 * arithmetic exposed: `computeSizing` takes the inputs a reader can move and the constants a reader
 * can edit, and returns every intermediate quantity, so the whole chain is checkable on a napkin.
 *
 * The function is deliberately free of I/O, randomness, dates and allocation-heavy work: the screen
 * calls it on every keystroke and must recompute with no perceptible lag, and the export CLI calls
 * the identical function so the document and the screen can never disagree.
 *
 * **Units.** Bytes, seconds, days and INR throughout; Gbps and TB only at the boundary, and always
 * decimal (1 TB = 1e12 B), because storage is procured in decimal terabytes.
 *
 * Provenance for every constant lives in `constants.ts`. Nothing here inlines a literal that a
 * reader might want to challenge.
 */
import {
  type AcceleratorClass,
  type ConstantKey,
  type SizingConstant,
  type SizingOverrides,
  acceleratorClasses,
  constantValue,
  resolvedConstant,
} from './constants.js';

export interface SizingInputs {
  /** Cameras in the estate. */
  readonly cameras: number;
  /** Share of the estate running continuous ANPR, 0–100. */
  readonly anprCoveragePct: number;
  /** Share of the estate analysed at the edge, 0–100. The remainder streams video centrally. */
  readonly edgeSharePct: number;
  /** Events emitted per camera per day. See `EVENT_RATE_ANCHORS` — the mean is not the median. */
  readonly eventsPerCameraPerDay: number;
  /**
   * How many raw per-frame sightings one event stands for: 1 for per-frame sightings, 43.62 for
   * per-track summaries (D2-01 #15).
   *
   * Crop volume follows the *sighting* rate, because D2-02's 33 crops per 1,000 is a ratio against
   * sightings. Without this factor a per-track scenario would undercount crops by 43.6x — the
   * vehicle passages are the same, only the metadata rows were summarised.
   */
  readonly sightingsPerEvent: number;
  /** How long metadata is kept. */
  readonly metadataRetentionDays: number;
  /** How long best-shot crops are kept. */
  readonly cropRetentionDays: number;
  /** Which accelerator to price, from `acceleratorClasses()`. */
  readonly acceleratorClassId: string;
}

/** A low/high band. Every storage and cost figure in this model is one, never a point estimate. */
export interface Band {
  readonly low: number;
  readonly high: number;
}

export interface BackhaulResult {
  readonly edgeCameras: number;
  readonly centralCameras: number;
  /** What Model 4 as written costs: every camera streamed centrally. */
  readonly allCentralVideoGbps: number;
  /** Video still travelling under the chosen edge/central split. */
  readonly videoBackhaulGbps: number;
  /** Events travelling from the cameras analysed at the edge. */
  readonly metadataBackhaulGbps: number;
  readonly totalBackhaulGbps: number;
  /** `allCentralVideoGbps / totalBackhaulGbps`. The 125x claim, recomputed from the inputs. */
  readonly reductionRatio: number;
  /** Metadata alone, so the pure edge-versus-central ratio is visible at any split. */
  readonly metadataOnlyRatio: number;
}

export interface ComputeResult {
  readonly anprCameras: number;
  readonly acceleratorClass: AcceleratorClass;
  readonly streamsPerAccelerator: number;
  readonly acceleratorsRequired: number;
  readonly districtNodes: number;
  /** Exact mean, so `PROJECT.md`'s "~29 per district node" is reproducible. */
  readonly acceleratorsPerDistrictNodeMean: number;
  /** What must actually be racked, per node. */
  readonly acceleratorsPerDistrictNode: number;
  /** Aggregate frames per second the estate's ANPR cameras present at the class's rate. */
  readonly aggregateStreamFps: number;
}

export interface TierSplit {
  readonly hotDays: number;
  readonly warmDays: number;
  readonly coldDays: number;
  readonly hotTB: Band;
  readonly warmTB: Band;
  readonly coldTB: Band;
}

export interface StorageResult {
  readonly eventsPerDay: number;
  /** The underlying vehicle-passage rate the crops are cut from. */
  readonly sightingsPerDay: number;
  readonly metadataTBPerYear: number;
  readonly metadataRetainedTB: number;
  readonly cropsPerDay: number;
  readonly cropTBPerYear: Band;
  readonly cropRetainedTB: Band;
  readonly totalRetainedTB: Band;
  readonly tiers: TierSplit;
}

export interface CostLine {
  readonly key: string;
  readonly label: string;
  readonly inrPerYear: Band;
  /** The arithmetic, spelled out, so the line can be checked without reading the source. */
  readonly basis: string;
}

export interface CostResult {
  readonly capexInr: Band;
  readonly amortisedCapexInrPerYear: Band;
  readonly annualOpexInr: Band;
  readonly totalAnnualCostInr: Band;
  readonly lines: readonly CostLine[];
  /** Annual cost divided by camera count — the number a department actually compares. */
  readonly annualCostPerCameraInr: Band;
}

export interface SizingResult {
  readonly inputs: SizingInputs;
  readonly backhaul: BackhaulResult;
  readonly compute: ComputeResult;
  readonly storage: StorageResult;
  readonly cost: CostResult;
  /** Every constant this computation actually read, with any override folded in. */
  readonly constantsUsed: readonly SizingConstant[];
}

const BYTES_PER_TB = 1e12;
const SECONDS_PER_DAY = 86_400;
const BITS_PER_BYTE = 8;
const DAYS_PER_YEAR = 365;
const MONTHS_PER_YEAR = 12;
const HOURS_PER_YEAR = 24 * 365;

function band(low: number, high: number): Band {
  return { low, high };
}

function scaleBand(b: Band, factor: number): Band {
  return band(b.low * factor, b.high * factor);
}

function addBands(...bands: Band[]): Band {
  return bands.reduce<Band>((acc, b) => band(acc.low + b.low, acc.high + b.high), band(0, 0));
}

/** Widen a band outward by a fraction. Applied last, so it never hides the crop-size band. */
function widen(b: Band, fraction: number): Band {
  return band(b.low * (1 - fraction), b.high * (1 + fraction));
}

/** The constants `computeSizing` reads. Listed explicitly so the export can cite exactly these. */
const USED_CONSTANTS: readonly ConstantKey[] = [
  'videoBitrateMbps',
  'eventWireBytes',
  'sightingRowBytes',
  'cropsPer1000Sightings',
  'cropBytesMeasured',
  'cropBytesCeiling',
  'districtNodes',
  'hotTierDays',
  'warmTierDays',
  'acceleratorNodeCapexInr',
  'acceleratorNodePowerW',
  'datacentrePue',
  'powerTariffInrPerKwh',
  'hotStorageInrPerTbMonth',
  'warmStorageInrPerTbMonth',
  'coldStorageInrPerTbMonth',
  'backhaulInrPerMbpsMonth',
  'nodesPerFte',
  'opsFteInrPerYear',
  'softwareLicenceInrPerCameraYear',
  'hardwareRefreshYears',
  'costUncertainty',
];

/**
 * Apportion a retained volume across hot, warm and cold by age.
 *
 * Days are cumulative from the retention window's start: hot is days 0..hot, warm runs to the
 * cumulative warm boundary, cold is whatever is left. A retention shorter than the hot window puts
 * everything in hot, which is correct rather than a special case.
 */
function tierDays(
  retentionDays: number,
  hotTierDays: number,
  warmTierDays: number,
): { hotDays: number; warmDays: number; coldDays: number } {
  const hotDays = Math.min(hotTierDays, retentionDays);
  const warmDays = Math.max(0, Math.min(warmTierDays, retentionDays) - hotDays);
  const coldDays = Math.max(0, retentionDays - hotDays - warmDays);
  return { hotDays, warmDays, coldDays };
}

export function computeSizing(inputs: SizingInputs, overrides: SizingOverrides = {}): SizingResult {
  const v = (key: ConstantKey): number => constantValue(key, overrides);

  // ── Backhaul ──────────────────────────────────────────────────────────────────────────────────
  const edgeCameras = Math.round((inputs.cameras * inputs.edgeSharePct) / 100);
  const centralCameras = inputs.cameras - edgeCameras;
  const bitrate = v('videoBitrateMbps');

  const allCentralVideoGbps = (inputs.cameras * bitrate) / 1000;
  const videoBackhaulGbps = (centralCameras * bitrate) / 1000;

  const eventBitsPerCameraPerSecond =
    (inputs.eventsPerCameraPerDay * v('eventWireBytes') * BITS_PER_BYTE) / SECONDS_PER_DAY;
  const metadataBackhaulGbps = (edgeCameras * eventBitsPerCameraPerSecond) / 1e9;
  const totalBackhaulGbps = videoBackhaulGbps + metadataBackhaulGbps;

  const metadataOnlyGbps = (inputs.cameras * eventBitsPerCameraPerSecond) / 1e9;

  const backhaul: BackhaulResult = {
    edgeCameras,
    centralCameras,
    allCentralVideoGbps,
    videoBackhaulGbps,
    metadataBackhaulGbps,
    totalBackhaulGbps,
    reductionRatio: totalBackhaulGbps === 0 ? Infinity : allCentralVideoGbps / totalBackhaulGbps,
    metadataOnlyRatio: metadataOnlyGbps === 0 ? Infinity : allCentralVideoGbps / metadataOnlyGbps,
  };

  // ── Compute ───────────────────────────────────────────────────────────────────────────────────
  const classes = acceleratorClasses(overrides);
  const acceleratorClass =
    classes.find((k) => k.id === inputs.acceleratorClassId) ??
    classes[0] ??
    (() => {
      throw new Error('no accelerator classes are defined');
    })();

  const anprCameras = Math.round((inputs.cameras * inputs.anprCoveragePct) / 100);
  const districtNodes = Math.max(1, Math.round(v('districtNodes')));
  const acceleratorsRequired = Math.ceil(anprCameras / acceleratorClass.streams);

  const compute: ComputeResult = {
    anprCameras,
    acceleratorClass,
    streamsPerAccelerator: acceleratorClass.streams,
    acceleratorsRequired,
    districtNodes,
    acceleratorsPerDistrictNodeMean: acceleratorsRequired / districtNodes,
    acceleratorsPerDistrictNode: Math.ceil(acceleratorsRequired / districtNodes),
    aggregateStreamFps: anprCameras * acceleratorClass.atFps,
  };

  // ── Storage ───────────────────────────────────────────────────────────────────────────────────
  const eventsPerDay = inputs.cameras * inputs.eventsPerCameraPerDay;
  const metadataBytesPerDay = eventsPerDay * v('sightingRowBytes');
  const metadataTBPerDay = metadataBytesPerDay / BYTES_PER_TB;

  // Crops are cut from vehicle passages, not from metadata rows. Summarising the rows does not
  // reduce the number of vehicles that drove past, so the crop term uses the sighting rate.
  const sightingsPerDay = eventsPerDay * inputs.sightingsPerEvent;
  const cropsPerDay = (sightingsPerDay * v('cropsPer1000Sightings')) / 1000;
  const cropBytesPerDay = band(
    cropsPerDay * v('cropBytesMeasured'),
    cropsPerDay * v('cropBytesCeiling'),
  );
  const cropTBPerDay = scaleBand(cropBytesPerDay, 1 / BYTES_PER_TB);

  const metaDays = tierDays(inputs.metadataRetentionDays, v('hotTierDays'), v('warmTierDays'));
  const cropDays = tierDays(inputs.cropRetentionDays, v('hotTierDays'), v('warmTierDays'));

  const hotTB = addBands(
    band(metadataTBPerDay * metaDays.hotDays, metadataTBPerDay * metaDays.hotDays),
    scaleBand(cropTBPerDay, cropDays.hotDays),
  );
  const warmTB = addBands(
    band(metadataTBPerDay * metaDays.warmDays, metadataTBPerDay * metaDays.warmDays),
    scaleBand(cropTBPerDay, cropDays.warmDays),
  );
  const coldTB = addBands(
    band(metadataTBPerDay * metaDays.coldDays, metadataTBPerDay * metaDays.coldDays),
    scaleBand(cropTBPerDay, cropDays.coldDays),
  );

  const metadataRetainedTB = metadataTBPerDay * inputs.metadataRetentionDays;
  const cropRetainedTB = scaleBand(cropTBPerDay, inputs.cropRetentionDays);

  const storage: StorageResult = {
    eventsPerDay,
    sightingsPerDay,
    metadataTBPerYear: metadataTBPerDay * DAYS_PER_YEAR,
    metadataRetainedTB,
    cropsPerDay,
    cropTBPerYear: scaleBand(cropTBPerDay, DAYS_PER_YEAR),
    cropRetainedTB,
    totalRetainedTB: addBands(band(metadataRetainedTB, metadataRetainedTB), cropRetainedTB),
    tiers: {
      hotDays: Math.max(metaDays.hotDays, cropDays.hotDays),
      warmDays: Math.max(metaDays.warmDays, cropDays.warmDays),
      coldDays: Math.max(metaDays.coldDays, cropDays.coldDays),
      hotTB,
      warmTB,
      coldTB,
    },
  };

  // ── Cost ──────────────────────────────────────────────────────────────────────────────────────
  const uncertainty = v('costUncertainty');

  const capexRaw = acceleratorsRequired * v('acceleratorNodeCapexInr');
  const capexInr = widen(band(capexRaw, capexRaw), uncertainty);

  const powerInrPerYear =
    ((acceleratorsRequired * v('acceleratorNodePowerW')) / 1000) *
    HOURS_PER_YEAR *
    v('datacentrePue') *
    v('powerTariffInrPerKwh');

  const storageInrPerYear = addBands(
    scaleBand(hotTB, v('hotStorageInrPerTbMonth') * MONTHS_PER_YEAR),
    scaleBand(warmTB, v('warmStorageInrPerTbMonth') * MONTHS_PER_YEAR),
    scaleBand(coldTB, v('coldStorageInrPerTbMonth') * MONTHS_PER_YEAR),
  );

  const backhaulInrPerYear =
    totalBackhaulGbps * 1000 * v('backhaulInrPerMbpsMonth') * MONTHS_PER_YEAR;

  const opsInrPerYear =
    Math.ceil(acceleratorsRequired / Math.max(1, v('nodesPerFte'))) * v('opsFteInrPerYear');

  const licenceInrPerYear = inputs.cameras * v('softwareLicenceInrPerCameraYear');

  const lines: readonly CostLine[] = [
    {
      key: 'backhaul',
      label: 'Backhaul capacity',
      inrPerYear: widen(band(backhaulInrPerYear, backhaulInrPerYear), uncertainty),
      basis: `${totalBackhaulGbps.toFixed(3)} Gbps x 1,000 x INR ${v('backhaulInrPerMbpsMonth')}/Mbps/month x 12`,
    },
    {
      key: 'storage',
      label: 'Storage, all tiers',
      inrPerYear: widen(storageInrPerYear, uncertainty),
      basis: `hot ${hotTB.low.toFixed(1)}–${hotTB.high.toFixed(1)} TB, warm ${warmTB.low.toFixed(1)}–${warmTB.high.toFixed(1)} TB, cold ${coldTB.low.toFixed(1)}–${coldTB.high.toFixed(1)} TB at INR ${v('hotStorageInrPerTbMonth')} / ${v('warmStorageInrPerTbMonth')} / ${v('coldStorageInrPerTbMonth')} per TB-month`,
    },
    {
      key: 'power',
      label: 'Power and cooling',
      inrPerYear: widen(band(powerInrPerYear, powerInrPerYear), uncertainty),
      basis: `${acceleratorsRequired} accelerators x ${v('acceleratorNodePowerW')} W x 8,760 h x PUE ${v('datacentrePue')} x INR ${v('powerTariffInrPerKwh')}/kWh`,
    },
    {
      key: 'ops',
      label: 'Operations staff',
      inrPerYear: widen(band(opsInrPerYear, opsInrPerYear), uncertainty),
      basis: `ceil(${acceleratorsRequired} / ${v('nodesPerFte')}) FTE x INR ${v('opsFteInrPerYear').toLocaleString('en-IN')}/year`,
    },
    {
      key: 'licence',
      label: 'Software licences',
      inrPerYear: widen(band(licenceInrPerYear, licenceInrPerYear), uncertainty),
      basis: `${inputs.cameras.toLocaleString('en-IN')} cameras x INR ${v('softwareLicenceInrPerCameraYear')}/camera/year — the whole stack is open source`,
    },
  ];

  const annualOpexInr = addBands(...lines.map((l) => l.inrPerYear));
  const amortisedCapexInrPerYear = scaleBand(capexInr, 1 / Math.max(1, v('hardwareRefreshYears')));
  const totalAnnualCostInr = addBands(annualOpexInr, amortisedCapexInrPerYear);

  const cost: CostResult = {
    capexInr,
    amortisedCapexInrPerYear,
    annualOpexInr,
    totalAnnualCostInr,
    lines,
    annualCostPerCameraInr:
      inputs.cameras === 0 ? band(0, 0) : scaleBand(totalAnnualCostInr, 1 / inputs.cameras),
  };

  return {
    inputs,
    backhaul,
    compute,
    storage,
    cost,
    constantsUsed: USED_CONSTANTS.map((k) => resolvedConstant(k, overrides)),
  };
}
