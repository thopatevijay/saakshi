/**
 * Presentation helpers for the sizing calculator (D3-08).
 *
 * The arithmetic lives in `@saakshi/shared`'s pure model and is tested there. What lives here is the
 * part the screen owns: clamping what a reader types, labelling a scenario once it stops matching a
 * preset, and turning a provenance tag into something visible. Kept out of the component so it can
 * be tested without a DOM.
 */
import {
  type ConstantKey,
  type Provenance,
  SIZING_CONSTANTS,
  type SizingInputs,
  type SizingPreset,
  presetById,
} from '@saakshi/shared';

/** The inputs a reader can move, with the bounds each one is meaningful within. */
export const INPUT_BOUNDS = {
  cameras: { min: 1, max: 1_000_000, step: 100 },
  anprCoveragePct: { min: 0, max: 100, step: 1 },
  edgeSharePct: { min: 0, max: 100, step: 1 },
  eventsPerCameraPerDay: { min: 1, max: 5_000_000, step: 1 },
  sightingsPerEvent: { min: 1, max: 1_000, step: 0.01 },
  metadataRetentionDays: { min: 1, max: 3_650, step: 1 },
  cropRetentionDays: { min: 1, max: 3_650, step: 1 },
} as const satisfies Record<string, { min: number; max: number; step: number }>;

export type BoundedInput = keyof typeof INPUT_BOUNDS;

/**
 * Keep a typed value inside its bounds without fighting the reader mid-keystroke.
 *
 * A cleared field or a half-typed number returns the bound's minimum rather than `NaN`, because a
 * `NaN` reaching the model would render every output as "NaN" and look like a crash.
 */
export function clampInput(field: BoundedInput, raw: number | string): number {
  const bounds = INPUT_BOUNDS[field];
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/** True when the current inputs still match the preset they came from, field for field. */
export function matchesPreset(inputs: SizingInputs, presetId: string): boolean {
  const preset = presetById(presetId);
  if (preset === undefined) return false;
  const keys = Object.keys(preset.inputs) as (keyof SizingInputs)[];
  return keys.every((k) => preset.inputs[k] === inputs[k]);
}

/**
 * Wrap the live inputs as a preset so the Markdown exporter can render them.
 *
 * Once a reader has moved anything the scenario is theirs, not ours, and the exported document says
 * so — a document headed "Statewide" that no longer contains the statewide numbers would be the
 * worst possible output of a tool whose whole purpose is traceability.
 */
export function scenarioForExport(inputs: SizingInputs, presetId: string): SizingPreset {
  const preset = presetById(presetId);
  if (preset !== undefined && matchesPreset(inputs, presetId)) return preset;

  const base = preset?.label ?? 'Custom';
  return {
    id: 'custom',
    label: `Custom (${inputs.cameras.toLocaleString('en-GB')} cameras)`,
    rationale: `Adjusted in the calculator from the ${base} preset. The inputs below are the reader's, not the defaults; every constant still carries the provenance it shipped with, and any constant the reader overrode is retagged as assumed.`,
    inputs,
  };
}

export const PROVENANCE_TEXT: Record<Provenance, string> = {
  measured: 'measured',
  listed: 'vendor-listed',
  assumed: 'assumed',
};

/**
 * Provenance as colour as well as text.
 *
 * Never colour alone: the word is always rendered beside the chip, because a reader who cannot
 * distinguish the hues must still be able to tell a measurement from a guess — and that distinction
 * is the entire argument this screen makes.
 */
export const PROVENANCE_CLASS: Record<Provenance, string> = {
  measured: 'border-emerald-800 bg-emerald-950/40 text-emerald-300',
  listed: 'border-sky-800 bg-sky-950/40 text-sky-300',
  assumed: 'border-amber-800 bg-amber-950/40 text-amber-300',
};

/** How many of the constants on the page are ours, for the headline count. */
export function provenanceCounts(keys: readonly ConstantKey[]): Record<Provenance, number> {
  const counts: Record<Provenance, number> = { measured: 0, listed: 0, assumed: 0 };
  for (const key of keys) counts[SIZING_CONSTANTS[key].provenance] += 1;
  return counts;
}

export function formatGbps(gbps: number): string {
  if (!Number.isFinite(gbps)) return '—';
  if (gbps >= 1) return `${gbps.toFixed(2)} Gbps`;
  if (gbps >= 0.001) return `${(gbps * 1000).toFixed(1)} Mbps`;
  return `${(gbps * 1e6).toFixed(1)} kbps`;
}

export function formatTB(tb: number): string {
  if (!Number.isFinite(tb)) return '—';
  if (tb >= 1000) return `${(tb / 1000).toFixed(2)} PB`;
  if (tb >= 1) return `${tb.toFixed(1)} TB`;
  return `${(tb * 1000).toFixed(1)} GB`;
}

export function formatTBBand(band: { low: number; high: number }): string {
  if (Math.abs(band.high - band.low) < 1e-9) return formatTB(band.low);
  return `${formatTB(band.low)} – ${formatTB(band.high)}`;
}

export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return '∞';
  if (ratio >= 100) return `${Math.round(ratio).toLocaleString('en-GB')}x`;
  return `${ratio.toFixed(1)}x`;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-GB');
}
