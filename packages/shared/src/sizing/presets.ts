/**
 * The four scenarios the calculator opens with (D3-08).
 *
 * `Benchmark (100,000)` exists because the challenge's own two pages disagree: `/problems` describes
 * an 80,000-camera estate and `/evaluation-criteria` states a 1,00,000+ target. The calculator has
 * to reach the higher number, so it does, and both are presets rather than a footnote.
 *
 * Every preset defaults its event rate to the **per-track** anchor rather than the per-frame one.
 * That is a design statement, not a convenience: the PoC write path emits one row per tracked object
 * per inferred frame — measured at about 923,000 per camera per day — and at estate scale that is not
 * storable. One summary row per vehicle passage is 43.6x smaller (D2-01 #15), which is the same
 * compression best-shot selection already applies to crops. The per-frame anchors stay one click
 * away so the gap is visible rather than quietly assumed away.
 */
import {
  EVENT_RATE_ANCHORS,
  type EventRateAnchor,
  PROJECT_MD_SECTION_9,
  type SizingOverrides,
} from './constants.js';
import type { SizingInputs } from './model.js';

function anchor(id: string): EventRateAnchor {
  const found = EVENT_RATE_ANCHORS.find((a) => a.id === id);
  if (found === undefined) throw new Error(`unknown event-rate anchor: ${id}`);
  return found;
}

const PER_TRACK = anchor('per-track');

/** One summary row per vehicle passage, at the measured 8-camera mean rate. */
export const PER_TRACK_EVENTS_PER_CAMERA_PER_DAY = PER_TRACK.eventsPerCameraPerDay;

export interface SizingPreset {
  readonly id: string;
  readonly label: string;
  /** Why this scenario exists and where its camera count comes from. */
  readonly rationale: string;
  readonly inputs: SizingInputs;
}

export const SIZING_PRESETS: readonly SizingPreset[] = [
  {
    id: 'pilot',
    label: 'Pilot (500 cameras)',
    rationale:
      'One city command centre. ANPR on every camera because a pilot is chosen for road-facing sites, and priced on the accelerator we actually demonstrated — 8 concurrent ANPR streams on one node, sustained, with zero reconnects (D1-09 #13, D2-01 #15). Nothing here is extrapolated.',
    inputs: {
      cameras: 500,
      anprCoveragePct: 100,
      edgeSharePct: 100,
      eventsPerCameraPerDay: PER_TRACK_EVENTS_PER_CAMERA_PER_DAY,
      sightingsPerEvent: PER_TRACK.sightingsPerEvent,
      metadataRetentionDays: 90,
      cropRetentionDays: 30,
      acceleratorClassId: 'measured-demonstrated',
    },
  },
  {
    id: 'district',
    label: 'District (5,000 cameras)',
    rationale:
      'One district edge node standing alone. Half the estate on continuous ANPR: a district mixes road-facing junctions with premises cameras that need detection and attributes but not a plate read on every vehicle.',
    inputs: {
      cameras: 5_000,
      anprCoveragePct: 50,
      edgeSharePct: 100,
      eventsPerCameraPerDay: PER_TRACK_EVENTS_PER_CAMERA_PER_DAY,
      sightingsPerEvent: PER_TRACK.sightingsPerEvent,
      metadataRetentionDays: 180,
      cropRetentionDays: 90,
      acceleratorClassId: 'measured-extrapolated',
    },
  },
  {
    id: 'statewide',
    label: 'Statewide (80,000 cameras)',
    rationale:
      "The estate size on the challenge's `/problems` page. 30% continuous ANPR is PROJECT.md section 9's own assumption — road-facing cameras are about a third of the estate — kept so the two can be compared line by line.",
    inputs: {
      cameras: PROJECT_MD_SECTION_9.cameras,
      anprCoveragePct: PROJECT_MD_SECTION_9.anprCoveragePct,
      edgeSharePct: 100,
      eventsPerCameraPerDay: PER_TRACK_EVENTS_PER_CAMERA_PER_DAY,
      sightingsPerEvent: PER_TRACK.sightingsPerEvent,
      metadataRetentionDays: 365,
      cropRetentionDays: 90,
      acceleratorClassId: 'measured-extrapolated',
    },
  },
  {
    id: 'benchmark',
    label: 'Benchmark (100,000 cameras)',
    rationale:
      'The `/evaluation-criteria` page states a 1,00,000+ camera target, above the 80,000 on `/problems`. This preset exists so the calculator reaches the higher of the two numbers the challenge itself publishes, rather than the more comfortable one.',
    inputs: {
      cameras: 100_000,
      anprCoveragePct: 30,
      edgeSharePct: 100,
      eventsPerCameraPerDay: PER_TRACK_EVENTS_PER_CAMERA_PER_DAY,
      sightingsPerEvent: PER_TRACK.sightingsPerEvent,
      metadataRetentionDays: 365,
      cropRetentionDays: 90,
      acceleratorClassId: 'measured-extrapolated',
    },
  },
];

export function presetById(id: string): SizingPreset | undefined {
  return SIZING_PRESETS.find((p) => p.id === id);
}

/**
 * `PROJECT.md` section 9's first pass, expressed as inputs and overrides to this model.
 *
 * Not offered as a preset in the UI — it is not a scenario anybody should size against. It exists so
 * that `computeSizing` can reproduce section 9's published figures *exactly*, under section 9's own
 * constants, which turns "the estimate was wrong" from an assertion into a diff. See
 * `docs/sizing-model.md` section 6 and the test that asserts each published figure.
 */
export const SECTION_9_REPRODUCTION: {
  readonly inputs: SizingInputs;
  readonly overrides: SizingOverrides;
} = {
  inputs: {
    cameras: PROJECT_MD_SECTION_9.cameras,
    anprCoveragePct: PROJECT_MD_SECTION_9.anprCoveragePct,
    edgeSharePct: 100,
    eventsPerCameraPerDay: PROJECT_MD_SECTION_9.eventsPerCameraPerDay,
    sightingsPerEvent: 1,
    metadataRetentionDays: 365,
    cropRetentionDays: 365,
    acceleratorClassId: 'nvidia-l4',
  },
  overrides: {
    videoBitrateMbps: PROJECT_MD_SECTION_9.videoBitrateMbps,
    eventWireBytes: PROJECT_MD_SECTION_9.eventBytes,
    // Section 9 used one 400 B figure for both the wire and the row. Kept, so the reproduction runs
    // entirely on section 9's own constants and the divergence is attributable to them.
    sightingRowBytes: PROJECT_MD_SECTION_9.eventBytes,
    districtNodes: PROJECT_MD_SECTION_9.districtNodes,
  },
};
