'use client';

/**
 * The in-product infrastructure sizing and cost calculator (D3-08).
 *
 * *Infrastructure Sizing* and *Cost-Benefit Analysis* are two of the ten mandatory design
 * dimensions, and *Scalability and PoC Readiness* is a scored area. Every other team will put a
 * static table in a PDF. This is the table with its arithmetic exposed and its sources attached: the
 * reader moves the inputs, edits the unit costs, and watches the answer move — and every constant on
 * the page says whether we measured it, a vendor listed it, or we assumed it.
 *
 * **No network, no server action, no effect.** `computeSizing` is pure and synchronous, so every
 * keystroke recomputes inside the render that handled it. There is nothing to await and therefore
 * nothing that can lag or fall out of date.
 */
import { useMemo, useState } from 'react';
import {
  type ConstantKey,
  EDITABLE_CONSTANT_KEYS,
  EVENT_RATE_ANCHORS,
  SIZING_CONSTANTS,
  SIZING_PRESETS,
  type SizingInputs,
  type SizingOverrides,
  acceleratorClasses,
  computeSizing,
  formatInrBand,
  renderScenarioMarkdown,
  resolvedConstant,
} from '@saakshi/shared';
import {
  type BoundedInput,
  INPUT_BOUNDS,
  clampInput,
  formatCount,
  formatGbps,
  formatRatio,
  formatTB,
  formatTBBand,
  matchesPreset,
  provenanceCounts,
  scenarioForExport,
} from '@/src/lib/sizing/present';
import { ProvenanceChip } from './provenance-chip';

const FIELD =
  'h-9 w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 text-sm text-slate-100 tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400';
const LABEL = 'text-[11px] font-semibold tracking-wide text-slate-400 uppercase';
const CARD = 'rounded-lg border border-slate-800 bg-slate-900/40 p-4';

const DEFAULT_PRESET = SIZING_PRESETS[2] ?? SIZING_PRESETS[0]!;

function NumberField({
  field,
  label,
  value,
  onChange,
  hint,
  slider = true,
}: {
  field: BoundedInput;
  label: string;
  value: number;
  onChange: (next: number) => void;
  hint?: string;
  slider?: boolean;
}) {
  const bounds = INPUT_BOUNDS[field];
  return (
    <div className="space-y-1.5">
      <label className={LABEL} htmlFor={`sizing-${field}`}>
        {label}
      </label>
      <input
        id={`sizing-${field}`}
        name={field}
        type="number"
        className={FIELD}
        value={value}
        min={bounds.min}
        max={bounds.max}
        onChange={(e) => onChange(clampInput(field, e.target.value))}
      />
      {slider ? (
        <input
          type="range"
          aria-label={`${label} slider`}
          className="w-full accent-sky-400"
          value={value}
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          onChange={(e) => onChange(clampInput(field, e.target.value))}
        />
      ) : null}
      {hint === undefined ? null : <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function Stat({
  label,
  value,
  emphasis = false,
  note,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  note?: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className={LABEL}>{label}</p>
      <p
        className={
          emphasis
            ? 'text-2xl font-semibold text-slate-100 tabular-nums'
            : 'text-base text-slate-200 tabular-nums'
        }
      >
        {value}
      </p>
      {note === undefined ? null : <p className="text-xs text-slate-500">{note}</p>}
    </div>
  );
}

export function Calculator() {
  const [presetId, setPresetId] = useState(DEFAULT_PRESET.id);
  const [inputs, setInputs] = useState<SizingInputs>(DEFAULT_PRESET.inputs);
  const [overrides, setOverrides] = useState<SizingOverrides>({});
  const [showExport, setShowExport] = useState(false);
  const [copied, setCopied] = useState(false);

  // Pure and synchronous: this is the whole "recomputes live" mechanism. No fetch, no effect.
  const result = useMemo(() => computeSizing(inputs, overrides), [inputs, overrides]);
  const classes = useMemo(() => acceleratorClasses(overrides), [overrides]);
  const counts = useMemo(() => provenanceCounts(EDITABLE_CONSTANT_KEYS), []);

  const markdown = useMemo(
    () => renderScenarioMarkdown({ preset: scenarioForExport(inputs, presetId), overrides }),
    [inputs, presetId, overrides],
  );

  const set = <K extends keyof SizingInputs>(key: K, value: SizingInputs[K]): void => {
    setInputs((prev) => ({ ...prev, [key]: value }));
    setCopied(false);
  };

  const applyPreset = (id: string): void => {
    const preset = SIZING_PRESETS.find((p) => p.id === id);
    if (preset === undefined) return;
    setPresetId(id);
    setInputs(preset.inputs);
    setCopied(false);
  };

  const setOverride = (key: ConstantKey, raw: string): void => {
    setCopied(false);
    setOverrides((prev) => {
      const next = { ...prev };
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(value)) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const copy = (): void => {
    void navigator.clipboard?.writeText(markdown).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  const isPristine = matchesPreset(inputs, presetId);
  const b = result.backhaul;
  const c = result.compute;
  const s = result.storage;

  return (
    <div className="space-y-8">
      <div className="max-w-3xl space-y-2">
        <h1 className="text-xl font-semibold text-slate-100">Infrastructure sizing and cost</h1>
        <p className="text-sm text-slate-400">
          Not a table in a slide — a model. Move any input and every figure below recomputes from
          our own measured throughput. Each constant says where it came from:{' '}
          <span className="text-emerald-300">measured</span> on this stack, with the ticket that
          measured it, <span className="text-sky-300">vendor-listed</span>, or{' '}
          <span className="text-amber-300">assumed</span> — and every assumption on this page is
          editable, so a reader who disagrees can substitute their own and watch the answer move.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {SIZING_PRESETS.map((p) => {
          const active = p.id === presetId;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.id)}
              aria-pressed={active}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? 'border-sky-600 bg-sky-950/50 text-sky-200'
                  : 'border-slate-700 bg-slate-900/60 text-slate-300 hover:border-slate-600'
              }`}
            >
              {p.label}
            </button>
          );
        })}
        {isPristine ? null : (
          <span className="text-xs text-amber-300" data-testid="scenario-modified">
            modified — exports as a custom scenario
          </span>
        )}
      </div>

      <p className="max-w-3xl rounded-md border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-400">
        {SIZING_PRESETS.find((p) => p.id === presetId)?.rationale}
      </p>

      <div className="grid gap-8 xl:grid-cols-[22rem_minmax(0,1fr)]">
        {/* ── Inputs ─────────────────────────────────────────────────────────────────────── */}
        <section className="space-y-5" aria-label="Scenario inputs">
          <h2 className="text-base font-semibold text-slate-100">Scenario</h2>

          <NumberField
            field="cameras"
            label="Cameras"
            value={inputs.cameras}
            onChange={(v) => set('cameras', v)}
          />
          <NumberField
            field="anprCoveragePct"
            label="Continuous ANPR coverage (%)"
            value={inputs.anprCoveragePct}
            onChange={(v) => set('anprCoveragePct', v)}
            hint="Road-facing cameras only need continuous plate reading. PROJECT.md assumes ~30% of the estate."
          />
          <NumberField
            field="edgeSharePct"
            label="Analysed at the edge (%)"
            value={inputs.edgeSharePct}
            onChange={(v) => set('edgeSharePct', v)}
            hint="The remainder streams video centrally. Drag this to 0 to price Model 4 as written."
          />

          <div className="space-y-1.5">
            <NumberField
              field="eventsPerCameraPerDay"
              label="Events per camera per day"
              value={inputs.eventsPerCameraPerDay}
              onChange={(v) => set('eventsPerCameraPerDay', v)}
              slider={false}
            />
            <p className="text-xs text-amber-300">
              The mean is not the median. D1-09 measured a <strong>500x</strong> spread across eight
              cameras in one city in one hour — cam04 produced 33,548 sightings and cam03 produced
              67. No single figure here describes an actual camera.
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {EVENT_RATE_ANCHORS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  title={`${a.source} — ${a.note}`}
                  onClick={() => {
                    setInputs((prev) => ({
                      ...prev,
                      eventsPerCameraPerDay: a.eventsPerCameraPerDay,
                      sightingsPerEvent: a.sightingsPerEvent,
                    }));
                    setCopied(false);
                  }}
                  className="flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900/60 px-2 py-1 text-xs text-slate-300 hover:border-slate-500"
                >
                  <span>{a.label}</span>
                  <span className="tabular-nums text-slate-500">
                    {formatCount(a.eventsPerCameraPerDay)}
                  </span>
                  <ProvenanceChip provenance={a.provenance} source={a.source} />
                </button>
              ))}
            </div>
          </div>

          <NumberField
            field="metadataRetentionDays"
            label="Metadata retention (days)"
            value={inputs.metadataRetentionDays}
            onChange={(v) => set('metadataRetentionDays', v)}
          />
          <NumberField
            field="cropRetentionDays"
            label="Crop retention (days)"
            value={inputs.cropRetentionDays}
            onChange={(v) => set('cropRetentionDays', v)}
            hint="0 of 30 cameras in the Gujarat catalogue declare a retention period at all (D3-05), so this is our proposal, not their practice."
          />
          <NumberField
            field="sightingsPerEvent"
            label="Vehicle passages per event"
            value={inputs.sightingsPerEvent}
            onChange={(v) => set('sightingsPerEvent', v)}
            slider={false}
            hint="1 when every frame is written; 43.62 when one summary row stands for a whole track (D2-01). Crops follow passages, not rows."
          />

          <div className="space-y-1.5">
            <label className={LABEL} htmlFor="sizing-accelerator">
              Accelerator class
            </label>
            <select
              id="sizing-accelerator"
              name="acceleratorClassId"
              className={FIELD}
              value={inputs.acceleratorClassId}
              onChange={(e) => set('acceleratorClassId', e.target.value)}
            >
              {classes.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} — {formatCount(k.streams)} streams @ {k.atFps} fps
                </option>
              ))}
            </select>
            <p className="flex items-start gap-2 text-xs text-slate-500">
              <ProvenanceChip provenance={c.acceleratorClass.provenance} />
              <span>{c.acceleratorClass.note}</span>
            </p>
          </div>
        </section>

        {/* ── Outputs ────────────────────────────────────────────────────────────────────── */}
        <section className="space-y-6" aria-label="Computed outputs" data-testid="outputs">
          <div className={CARD} data-testid="backhaul">
            <h2 className="mb-4 text-base font-semibold text-slate-100">Backhaul</h2>
            <div className="grid gap-5 sm:grid-cols-3">
              <Stat
                label="All video, streamed centrally"
                value={formatGbps(b.allCentralVideoGbps)}
                note={`${formatCount(inputs.cameras)} cameras — Model 4 as written`}
              />
              <Stat
                label="This architecture"
                value={formatGbps(b.totalBackhaulGbps)}
                note={`${formatCount(b.edgeCameras)} at the edge, ${formatCount(b.centralCameras)} central`}
              />
              <Stat
                label="Reduction"
                value={formatRatio(b.reductionRatio)}
                emphasis
                note="Video stays where it is; only events travel"
              />
            </div>
          </div>

          <div className={CARD} data-testid="compute">
            <h2 className="mb-4 text-base font-semibold text-slate-100">Compute</h2>
            <div className="grid gap-5 sm:grid-cols-3">
              <Stat label="Cameras on ANPR" value={formatCount(c.anprCameras)} />
              <Stat
                label="Accelerators"
                value={formatCount(c.acceleratorsRequired)}
                emphasis
                note={`${formatCount(c.streamsPerAccelerator)} streams each at ${c.acceleratorClass.atFps} fps`}
              />
              <Stat
                label="Per district node"
                value={formatCount(c.acceleratorsPerDistrictNode)}
                note={`${c.acceleratorsPerDistrictNodeMean.toFixed(1)} average across ${formatCount(c.districtNodes)} nodes`}
              />
            </div>
            <p className="mt-4 border-t border-slate-800 pt-3 text-xs text-slate-500">
              The measured node carried{' '}
              <strong className="text-slate-300">8 concurrent ANPR streams</strong> while sitting{' '}
              <strong className="text-slate-300">92% blocked in decode()</strong>. On the government
              feed as delivered, the bottleneck is the gateway, not the accelerator — and the ANPR
              cost is dominated by a <em>CPU</em> plate detector at 252 ms p50 under eight-way
              concurrency, not by the GPU.
            </p>
          </div>

          <div className={CARD} data-testid="storage">
            <h2 className="mb-4 text-base font-semibold text-slate-100">Storage</h2>
            <div className="grid gap-5 sm:grid-cols-3">
              <Stat
                label="Metadata"
                value={formatTB(s.metadataTBPerYear)}
                note={`per year · ${formatTB(s.metadataRetainedTB)} retained at ${formatCount(inputs.metadataRetentionDays)} days`}
              />
              <Stat
                label="Crops"
                value={formatTBBand(s.cropTBPerYear)}
                note={`per year · ${formatCount(s.cropsPerDay)} crops/day`}
              />
              <Stat label="Total retained" value={formatTBBand(s.totalRetainedTB)} emphasis />
            </div>
            <table className="mt-4 w-full border-t border-slate-800 pt-3 text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1.5 font-medium">Tier</th>
                  <th className="py-1.5 font-medium">Window</th>
                  <th className="py-1.5 text-right font-medium">Retained</th>
                </tr>
              </thead>
              <tbody className="text-slate-300">
                <tr>
                  <td className="py-1">Hot (NVMe)</td>
                  <td className="py-1 text-slate-500">0–{s.tiers.hotDays} days</td>
                  <td className="py-1 text-right tabular-nums">{formatTBBand(s.tiers.hotTB)}</td>
                </tr>
                <tr>
                  <td className="py-1">Warm (object store)</td>
                  <td className="py-1 text-slate-500">
                    {s.tiers.hotDays}–{s.tiers.hotDays + s.tiers.warmDays} days
                  </td>
                  <td className="py-1 text-right tabular-nums">{formatTBBand(s.tiers.warmTB)}</td>
                </tr>
                <tr>
                  <td className="py-1">Cold (archive)</td>
                  <td className="py-1 text-slate-500">
                    beyond {s.tiers.hotDays + s.tiers.warmDays} days
                  </td>
                  <td className="py-1 text-right tabular-nums">{formatTBBand(s.tiers.coldTB)}</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-xs text-slate-500">
              Crops are a range because D2-02 marked the 2,912 B mean provisional — measured on
              small replay frames, so a 1080p feed will be larger. The honest figure is 3–15 KB
              pending one live measurement. The ratio that is <em>not</em> provisional is 33 crops
              per 1,000 sightings: best-shot selection discards ~97% of what a naive design would
              keep.
            </p>
          </div>

          <div className={CARD} data-testid="cost">
            <h2 className="mb-4 text-base font-semibold text-slate-100">Cost</h2>
            <div className="grid gap-5 sm:grid-cols-3">
              <Stat label="Capex" value={formatInrBand(result.cost.capexInr)} />
              <Stat label="Annual opex" value={formatInrBand(result.cost.annualOpexInr)} />
              <Stat
                label="Total per year"
                value={formatInrBand(result.cost.totalAnnualCostInr)}
                emphasis
                note={`${formatInrBand(result.cost.annualCostPerCameraInr)} per camera per year`}
              />
            </div>
            <table className="mt-4 w-full border-t border-slate-800 pt-3 text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1.5 font-medium">Line</th>
                  <th className="py-1.5 text-right font-medium">Per year</th>
                </tr>
              </thead>
              <tbody className="text-slate-300">
                {result.cost.lines.map((l) => (
                  <tr key={l.key} title={l.basis}>
                    <td className="py-1">{l.label}</td>
                    <td className="py-1 text-right tabular-nums">{formatInrBand(l.inrPerYear)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-slate-500">
              The licence line is zero, and that is a fact about the repository rather than a
              promise: the whole stack is open source, and the one proprietary dependency sits
              behind an interface with a local and a disabled provider. A commercial VMS-plus-ANPR
              estate prices that line per camera per year, and at this camera count it would
              dominate every other number here.
            </p>
          </div>
        </section>
      </div>

      {/* ── Editable assumptions ───────────────────────────────────────────────────────────── */}
      <section className="space-y-3" aria-label="Assumptions">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-100">
            Assumptions — every one editable
          </h2>
          <p className="text-xs text-slate-500">
            {counts.measured} measured · {counts.listed} vendor-listed · {counts.assumed} assumed.
            Change any value and the figures above move. Clear a field to restore the default.
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="bg-slate-900/60 text-left text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">Constant</th>
                <th className="px-3 py-2 font-medium">Value</th>
                <th className="px-3 py-2 font-medium">Provenance</th>
                <th className="px-3 py-2 font-medium">Source and caveat</th>
              </tr>
            </thead>
            <tbody>
              {EDITABLE_CONSTANT_KEYS.map((key) => {
                const resolved = resolvedConstant(key, overrides);
                const base = SIZING_CONSTANTS[key];
                return (
                  <tr key={key} className="border-t border-slate-800 align-top">
                    <td className="px-3 py-2 text-slate-200">
                      {base.label}
                      <span className="block text-[11px] text-slate-600">{base.unit}</span>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        aria-label={base.label}
                        name={key}
                        className={`${FIELD} w-32`}
                        value={overrides[key] ?? base.value}
                        onChange={(e) => setOverride(key, e.target.value)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <ProvenanceChip provenance={resolved.provenance} />
                    </td>
                    <td className="max-w-xl px-3 py-2 text-xs text-slate-500">
                      <span className="block text-slate-400">{resolved.source}</span>
                      {base.note}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500">
          The measured constants behind the throughput figures — inference latency, the motion-gate
          skip ratio, the plate-detector cost, the crop size — are not editable here, because
          overwriting a measurement would defeat the purpose. They are listed in full, with their
          runs, in the exported document below.
        </p>
      </section>

      {/* ── Export ─────────────────────────────────────────────────────────────────────────── */}
      <section className="space-y-3" aria-label="Export">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold text-slate-100">Export</h2>
          <button
            type="button"
            onClick={() => setShowExport((v) => !v)}
            className="rounded-md border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-600"
          >
            {showExport ? 'Hide Markdown' : 'Show Markdown'}
          </button>
          <button
            type="button"
            onClick={copy}
            className="rounded-md border border-sky-700 bg-sky-950/50 px-3 py-1.5 text-sm text-sky-200 hover:border-sky-600"
          >
            {copied ? 'Copied' : 'Copy Markdown'}
          </button>
          <p className="text-xs text-slate-500">
            The same document <code className="text-slate-400">npm run export:sizing</code> writes
            to <code className="text-slate-400">docs/sizing-model.md</code> — generated from this
            model, never hand-written, so the deck and the product cannot disagree.
          </p>
        </div>
        {showExport ? (
          <pre
            data-testid="export-markdown"
            className="max-h-[32rem] overflow-auto rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-xs whitespace-pre-wrap text-slate-300"
          >
            {markdown}
          </pre>
        ) : null}
      </section>
    </div>
  );
}
