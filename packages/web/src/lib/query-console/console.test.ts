/**
 * D3-09 · the query console.
 *
 * AC 2 and AC 5 (`QUERY_COMPILER=none` and every provider failure leave a fully usable manual
 * filter, with no broken screen), AC 8 (the compiled filter is displayed and editable *before* it
 * runs, and the edit is what runs), and this screen's share of D3-04's purpose binding.
 *
 * The gate runs this as `QUERY_COMPILER=none npm run test -w packages/web -- query-console`, which
 * is the graceful-degradation case specifically. Everything here is pure, so it holds in either
 * configuration — the module never reads the environment, because the *screen* must not decide
 * whether a compiler exists. The server tells it, in the compile outcome, and the screen renders
 * what it is told.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_CONSOLE_STATE,
  canCompile,
  canRun,
  degradation,
  emptyReasonText,
  isEdited,
  removeChip,
  toChips,
  toCompileRequest,
  toRunRequest,
  type CompileOutcomePayload,
  type ConsoleDsl,
  type ConsoleState,
} from './console';

function dsl(patch: (d: ConsoleDsl) => void = () => undefined): ConsoleDsl {
  const base: ConsoleDsl = {
    version: 1,
    entity: 'sightings',
    filters: {
      plate: null,
      classes: [],
      colours: [],
      place: { cameraExternalIds: [], districts: [], nearName: null, radius: null },
      time: { from: null, to: null },
      minConfidence: 0,
      bestShotOnly: false,
    },
    sequence: null,
    limit: 100,
  };
  patch(base);
  return base;
}

function state(patch: Partial<ConsoleState> = {}): ConsoleState {
  return { ...EMPTY_CONSOLE_STATE, ...patch };
}

const compiled = dsl((d) => {
  d.filters.plate = { pattern: 'GJ01AB1234', mode: 'fuzzy', maxDistance: 2 };
  d.filters.classes = ['car'];
  d.filters.colours = ['white'];
  d.filters.place.cameraExternalIds = ['cam05'];
  d.filters.time.from = '2026-09-05T02:00:00.000Z';
});

const failure = (
  reason: CompileOutcomePayload['reason'],
  message: string,
  issues: string[] = [],
): CompileOutcomePayload => ({
  ok: false,
  provider: reason === 'not_configured' ? 'none' : 'openai',
  model: null,
  dsl: null,
  summary: [],
  unconstrained: false,
  reason,
  message,
  issues,
  degradeTo: 'manual_filter',
  tookMs: 12,
  disclaimer: 'the model never saw a result row',
});

describe('AC 2 / AC 5 — degradation, with no broken screen in any case', () => {
  it('`QUERY_COMPILER=none` is a notice, not a warning — it is a deployment choice', () => {
    const result = degradation(failure('not_configured', 'No query model is configured…'));
    expect(result.mode).toBe('manual');
    expect(result.tone).toBe('notice');
    // Not retryable: pressing the button again will not conjure a compiler, and offering that would
    // be a worse screen than saying plainly that the filters below are the interface.
    expect(result.retryable).toBe(false);
    expect(result.message).toMatch(/configured/);
  });

  it('a provider failure is a warning, and is retryable', () => {
    for (const reason of ['provider_error', 'schema_rejected', 'not_understood'] as const) {
      const result = degradation(failure(reason, 'something went wrong'));
      expect(result.mode, reason).toBe('manual');
      expect(result.tone, reason).toBe('warning');
      expect(result.retryable, reason).toBe(true);
    }
  });

  it('every outcome has a mode — there is no state the screen cannot render', () => {
    const outcomes: (CompileOutcomePayload | null)[] = [
      null,
      failure('not_configured', 'x'),
      failure('provider_error', 'x'),
      failure('schema_rejected', 'x', ['filters.plate: bad']),
      failure('not_understood', 'x'),
      {
        ok: true,
        provider: 'ollama',
        model: 'qwen2.5:7b-instruct',
        dsl: compiled,
        summary: [],
        unconstrained: false,
        reason: null,
        message: null,
        issues: [],
        degradeTo: null,
        tookMs: 9,
        disclaimer: 'the model never saw a result row',
      },
    ];
    for (const outcome of outcomes) {
      expect(['idle', 'compiled', 'manual']).toContain(degradation(outcome).mode);
    }
  });

  it('a rejection carries its issues, so the officer can see what was wrong', () => {
    const result = degradation(
      failure('schema_rejected', 'rejected', ['filters.plate.maxDistance: Too big']),
    );
    expect(result.issues).toEqual(['filters.plate.maxDistance: Too big']);
  });

  it('the manual filter is never gated on the compiler — nothing here disables it', () => {
    // Structural: this module exposes no flag that could switch the manual filter off, and the
    // component below it renders that filter unconditionally. `none` is a fully working screen.
    const keys = Object.keys(degradation(failure('not_configured', 'x')));
    expect(keys).not.toContain('disableManualFilter');
    expect(keys).not.toContain('hideFilters');
  });
});

describe('AC 8 — the compiled filter is displayed and editable before it runs', () => {
  it('renders one chip per set constraint, and none for an unset one', () => {
    const chips = toChips(compiled, compiled);
    expect(chips.map((c) => c.id)).toEqual(['plate', 'classes', 'colours', 'cameras', 'from']);
    // No chip reads "colour: any". An unconstrained field is absent, not shown as a non-constraint.
    expect(chips.some((c) => c.value === 'any')).toBe(false);
  });

  it('shows the match mode in the chip, because it changes what the search means', () => {
    const chips = toChips(compiled, compiled);
    expect(chips.find((c) => c.id === 'plate')?.value).toBe('GJ01AB1234 ± 2');
    const exact = toChips(
      dsl((d) => {
        d.filters.plate = { pattern: 'GJ01AB1234', mode: 'exact', maxDistance: 0 };
      }),
      null,
    );
    expect(exact.find((c) => c.id === 'plate')?.value).toBe('GJ01AB1234');
  });

  it('removing a chip produces a new filter and leaves the original untouched', () => {
    const edited = removeChip(compiled, 'classes');
    expect(edited.filters.classes).toEqual([]);
    // The model's proposal is kept, so the console can show what changed.
    expect(compiled.filters.classes).toEqual(['car']);
  });

  it('marks an edited chip as edited, so the change is visible before it runs', () => {
    const edited = removeChip(compiled, 'colours');
    const chips = toChips(edited, compiled);
    expect(chips.find((c) => c.id === 'classes')?.origin).toBe('model');
    expect(chips.some((c) => c.id === 'colours')).toBe(false);
    expect(isEdited({ ...state(), compiled, draft: edited })).toBe(true);
  });

  it('every chip id can actually be removed', () => {
    const everything = dsl((d) => {
      d.filters.plate = { pattern: 'GJ01AB1234', mode: 'exact', maxDistance: 0 };
      d.filters.classes = ['car'];
      d.filters.colours = ['white'];
      d.filters.place = {
        cameraExternalIds: ['cam05'],
        districts: ['Ahmedabad'],
        nearName: 'Adalaj',
        radius: { lat: 23.02, lon: 72.57, metres: 500 },
      };
      d.filters.time = { from: '2026-09-05T02:00:00.000Z', to: '2026-09-05T04:00:00.000Z' };
      d.filters.minConfidence = 0.8;
      d.filters.bestShotOnly = true;
      d.sequence = {
        place: { cameraExternalIds: ['cam01'], districts: [], nearName: null, radius: null },
        withinMinutes: 60,
      };
    });
    let current = everything;
    for (const chip of toChips(everything, null)) current = removeChip(current, chip.id);
    // Removing every chip leaves a filter that constrains nothing — no chip is un-removable.
    expect(toChips(current, null)).toEqual([]);
  });

  it('**the run request carries the edit, not the model’s proposal**', () => {
    // The single most important assertion in this file. If this used `compiled`, the officer's
    // review would be theatre: they would edit a filter and a different one would run.
    const edited = removeChip(compiled, 'classes');
    const request = toRunRequest(
      state({
        text: 'white cars at cam05',
        purpose: 'FIR 118/2026 vehicle trace',
        compiled,
        draft: edited,
      }),
    );
    expect(request?.dsl.filters.classes).toEqual([]);
    expect(request?.dsl).not.toEqual(compiled);
  });

  it('the run request’s question is recorded, never executed', () => {
    const request = toRunRequest(
      state({ text: 'white cars at cam05', purpose: 'FIR 118/2026', compiled, draft: compiled }),
    );
    // It rides along for the audit entry. The filter is what runs, and it is a separate field.
    expect(request?.text).toBe('white cars at cam05');
    expect(request?.dsl).toEqual(compiled);
  });

  it('there is nothing to run before something has been compiled or built', () => {
    expect(toRunRequest(state({ purpose: 'a stated reason' }))).toBeNull();
  });
});

describe('D3-04 — the officer states the purpose, and nothing else may', () => {
  it('will not compile without one', () => {
    expect(canCompile(state({ text: 'white cars at cam05' }))).toBe(false);
    expect(canCompile(state({ text: 'white cars at cam05', purpose: 'ab' }))).toBe(false);
    expect(canCompile(state({ text: 'white cars at cam05', purpose: 'FIR 118/2026' }))).toBe(true);
  });

  it('will not compile without a question either', () => {
    expect(canCompile(state({ text: '  ', purpose: 'FIR 118/2026' }))).toBe(false);
  });

  it('will not run a filter once the purpose is cleared, even one compiled a moment ago', () => {
    // A purpose that *was* stated is not a purpose recorded against *this* search.
    expect(canRun(state({ purpose: 'FIR 118/2026', draft: compiled }))).toBe(true);
    expect(canRun(state({ purpose: '', draft: compiled }))).toBe(false);
  });

  it('never carries a purpose the officer did not type', () => {
    const request = toCompileRequest(state({ text: 'white cars', purpose: '  FIR 118/2026  ' }));
    expect(request.purpose).toBe('FIR 118/2026');
    // No default, no placeholder, no auto-fill anywhere in the module.
    expect(EMPTY_CONSOLE_STATE.purpose).toBe('');
  });

  it('omits an empty case reference rather than sending a blank one', () => {
    expect(toCompileRequest(state({ text: 'x', purpose: 'y' })).case_ref).toBeUndefined();
    expect(
      toCompileRequest(state({ text: 'x', purpose: 'y', caseRef: 'FIR/2026/00123' })).case_ref,
    ).toBe('FIR/2026/00123');
  });
});

describe('an empty result is an answer, with a reason (D2-08’s rule)', () => {
  it('gives four different sentences for four different situations', () => {
    const reasons = ['plate_not_searchable', 'no_matching_plate', 'unknown_camera', 'no_rows'];
    const sentences = reasons.map((r) => emptyReasonText(r));
    expect(new Set(sentences).size).toBe(4);
    for (const sentence of sentences) expect(sentence?.length).toBeGreaterThan(20);
  });

  it('says plainly that a refused plate was not searched at all', () => {
    // The distinction that matters most: "we looked and found nothing" versus "we did not look".
    expect(emptyReasonText('plate_not_searchable')).toMatch(/not searched|not look/i);
  });

  it('has nothing to say when there is a result', () => {
    expect(emptyReasonText(null)).toBeNull();
  });

  it('falls back to a sentence rather than showing a raw enum for an unknown reason', () => {
    expect(emptyReasonText('something_new')).toMatch(/matched no sightings/);
  });
});
