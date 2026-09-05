/**
 * The query console's logic (D3-09) — everything about the screen that is not JSX.
 *
 * Kept out of the component for the reason every `src/lib/**` module in this package exists: the
 * rules here are the acceptance criteria, and a rule that can only be exercised by rendering React
 * is a rule that does not get tested. The four that matter:
 *
 * 1. **The compiled filter is editable before it runs.** `editChip` produces a new DSL; the run
 *    request carries *that* one. The API makes this structural — `POST /api/v1/query/run` accepts a
 *    filter and has no natural-language field at all — but the screen has to actually use it, and
 *    `consoleState` is where that is decided rather than assumed.
 * 2. **`none`, and every provider failure, degrades to the manual filter with no broken screen.**
 *    `degradation()` turns a compile outcome into a rendering decision, and there is no outcome it
 *    does not have an answer for.
 * 3. **The officer states the purpose; nothing else may.** `canCompile` and `canRun` both gate on
 *    it, matching D3-04's server-side rule, so the field is visibly waiting rather than producing a
 *    400 the officer has to interpret.
 * 4. **An empty result is an answer.** Four different reasons, four different sentences — D2-08's
 *    rule, applied to this screen.
 */
import { MIN_PURPOSE_LENGTH } from '@/src/lib/trace/query';

/**
 * The filter's wire types, **derived from the generated OpenAPI document** rather than restated.
 *
 * The API's zod `QueryDSL` is the single source of truth; `npm run generate:api` turns it into
 * `schema.d.ts`, and these aliases read it. Restating the colour and class enums here would give
 * the web layer a second copy of a list that lives in the database — exactly the drift
 * `packages/shared/src/rbac.ts` warns about for capabilities, and with the same consequence: a
 * screen that offers a filter value the database has no room for.
 */
import type { paths } from '@/src/lib/api/schema';

type RunRequestBody =
  paths['/api/v1/query/run']['post']['requestBody']['content']['application/json'];

export type ConsoleDsl = RunRequestBody['dsl'];
export type ConsolePlaceFilter = ConsoleDsl['filters']['place'];

export type CompileOutcomePayload =
  paths['/api/v1/query/compile']['post']['responses'][200]['content']['application/json'];

/**
 * What the screen should show, derived from a compile outcome.
 *
 * `manual` is not an error state and must never be styled as one. With `QUERY_COMPILER=none` it is
 * the *normal* state of a fully open-source deployment, and a red banner would tell an officer
 * something is broken when nothing is.
 */
export type ConsoleMode = 'idle' | 'compiled' | 'manual';

export interface Degradation {
  mode: ConsoleMode;
  /** `notice` is informational; `warning` means the model was reachable and something went wrong. */
  tone: 'none' | 'notice' | 'warning';
  message: string | null;
  /** The validation issues, shown so a rejection is reviewable rather than merely reported. */
  issues: string[];
  /** True when the officer should be able to keep using the plain-English box. */
  retryable: boolean;
}

export function degradation(outcome: CompileOutcomePayload | null): Degradation {
  if (outcome === null) {
    return { mode: 'idle', tone: 'none', message: null, issues: [], retryable: true };
  }
  if (outcome.ok && outcome.dsl !== null) {
    return { mode: 'compiled', tone: 'none', message: null, issues: [], retryable: true };
  }
  // `not_configured` is a deployment choice, not a fault. Everything else is a fault, but a fault
  // whose consequence is only that one convenience is unavailable.
  const configured = outcome.reason === 'not_configured';
  return {
    mode: 'manual',
    tone: configured ? 'notice' : 'warning',
    message: outcome.message,
    issues: outcome.issues,
    retryable: !configured,
  };
}

export interface ConsoleState {
  /** The officer's question. */
  text: string;
  /** Why this search is being run. D3-04: never defaulted, never auto-filled, never from a link. */
  purpose: string;
  caseRef: string | null;
  /** What the model proposed. Kept so the console can show what was changed before it ran. */
  compiled: ConsoleDsl | null;
  /** What will actually run. Starts as `compiled` and diverges as the officer edits. */
  draft: ConsoleDsl | null;
}

export const EMPTY_CONSOLE_STATE: ConsoleState = {
  text: '',
  purpose: '',
  caseRef: null,
  compiled: null,
  draft: null,
};

/** The API refuses a question shorter than this, so the screen must not send one. */
export const MIN_QUESTION_LENGTH = 3;

export function canCompile(state: ConsoleState): boolean {
  return (
    state.text.trim().length >= MIN_QUESTION_LENGTH &&
    state.purpose.trim().length >= MIN_PURPOSE_LENGTH
  );
}

/**
 * A filter may only run once there is a filter *and* a stated purpose.
 *
 * Both halves, every time. An officer who compiles a filter, clears the purpose and presses Run is
 * running a search with no recorded reason, and the fact that a purpose was present a moment ago is
 * not the same as one being recorded against this search.
 */
export function canRun(state: ConsoleState): boolean {
  return state.draft !== null && state.purpose.trim().length >= MIN_PURPOSE_LENGTH;
}

/** The compile request body. Note there is no filter in it — compiling is not running. */
export function toCompileRequest(state: ConsoleState): {
  text: string;
  purpose: string;
  case_ref?: string;
} {
  return {
    text: state.text.trim(),
    purpose: state.purpose.trim(),
    ...(state.caseRef !== null && state.caseRef !== '' ? { case_ref: state.caseRef } : {}),
  };
}

/**
 * The run request body.
 *
 * It carries `state.draft` — the filter as the officer left it — and never `state.compiled`. That
 * one line is the difference between "the officer may edit the filter" and "the officer may edit
 * the filter *and it matters*", and `console.test.ts` asserts it directly.
 *
 * `text` rides along for the audit entry only. It is recorded and never executed.
 */
export function toRunRequest(state: ConsoleState): {
  dsl: ConsoleDsl;
  purpose: string;
  case_ref?: string;
  text?: string;
} | null {
  if (state.draft === null) return null;
  return {
    dsl: state.draft,
    purpose: state.purpose.trim(),
    ...(state.caseRef !== null && state.caseRef !== '' ? { case_ref: state.caseRef } : {}),
    ...(state.text.trim() !== '' ? { text: state.text.trim() } : {}),
  };
}

/** One editable constraint, as the console renders it. */
export interface Chip {
  /** Addresses the constraint for `removeChip`. */
  id: ChipId;
  label: string;
  value: string;
  /** `inferred` chips came from the model; an officer's edit makes a chip `edited`. */
  origin: 'model' | 'edited';
}

export type ChipId =
  | 'plate'
  | 'classes'
  | 'colours'
  | 'cameras'
  | 'districts'
  | 'nearName'
  | 'radius'
  | 'from'
  | 'to'
  | 'minConfidence'
  | 'bestShotOnly'
  | 'sequence';

/**
 * The filter, as chips.
 *
 * Only constraints that are *set* become chips: an unconstrained field is not a chip reading
 * "colour: any", because a screen full of "any" is a screen nobody reads, and the officer's review
 * is the whole point of showing it.
 */
export function toChips(dsl: ConsoleDsl, compiled: ConsoleDsl | null): Chip[] {
  const chips: Chip[] = [];
  const f = dsl.filters;
  const origin = (id: ChipId): 'model' | 'edited' =>
    compiled === null || chipValue(compiled, id) === chipValue(dsl, id) ? 'model' : 'edited';

  if (f.plate !== null) {
    chips.push({
      id: 'plate',
      label: 'registration',
      // The mode is part of the value, because "exactly GJ01AB1234" and "within 2 of GJ01AB1234"
      // are very different searches and a chip showing only the plate would hide which one ran.
      value:
        f.plate.mode === 'exact'
          ? f.plate.pattern
          : f.plate.mode === 'prefix'
            ? `${f.plate.pattern}… (starts with)`
            : `${f.plate.pattern} ± ${String(f.plate.maxDistance)}`,
      origin: origin('plate'),
    });
  }
  if (f.classes.length > 0) {
    chips.push({
      id: 'classes',
      label: 'class',
      value: f.classes.join(', '),
      origin: origin('classes'),
    });
  }
  if (f.colours.length > 0) {
    chips.push({
      id: 'colours',
      label: 'colour',
      value: f.colours.join(', '),
      origin: origin('colours'),
    });
  }
  if (f.place.cameraExternalIds.length > 0) {
    chips.push({
      id: 'cameras',
      label: 'camera',
      value: f.place.cameraExternalIds.join(', '),
      origin: origin('cameras'),
    });
  }
  if (f.place.districts.length > 0) {
    chips.push({
      id: 'districts',
      label: 'district',
      value: f.place.districts.join(', '),
      origin: origin('districts'),
    });
  }
  if (f.place.nearName !== null) {
    chips.push({
      id: 'nearName',
      label: 'near',
      value: f.place.nearName,
      origin: origin('nearName'),
    });
  }
  if (f.place.radius !== null) {
    chips.push({
      id: 'radius',
      label: 'within',
      value: `${String(f.place.radius.metres)} m of ${String(f.place.radius.lat)}, ${String(f.place.radius.lon)}`,
      origin: origin('radius'),
    });
  }
  if (f.time.from !== null) {
    chips.push({ id: 'from', label: 'from', value: f.time.from, origin: origin('from') });
  }
  if (f.time.to !== null) {
    chips.push({ id: 'to', label: 'to', value: f.time.to, origin: origin('to') });
  }
  if (f.minConfidence > 0) {
    chips.push({
      id: 'minConfidence',
      label: 'confidence ≥',
      value: String(f.minConfidence),
      origin: origin('minConfidence'),
    });
  }
  if (f.bestShotOnly) {
    chips.push({
      id: 'bestShotOnly',
      label: 'frames',
      value: 'best only',
      origin: origin('bestShotOnly'),
    });
  }
  if (dsl.sequence !== null) {
    const where = [
      ...dsl.sequence.place.cameraExternalIds,
      ...dsl.sequence.place.districts,
      ...(dsl.sequence.place.nearName !== null ? [dsl.sequence.place.nearName] : []),
    ];
    chips.push({
      id: 'sequence',
      label: 'then seen',
      value: `${where.join(', ') || 'anywhere'} within ${String(dsl.sequence.withinMinutes)} min`,
      origin: origin('sequence'),
    });
  }
  return chips;
}

function chipValue(dsl: ConsoleDsl, id: ChipId): string {
  const f = dsl.filters;
  switch (id) {
    case 'plate':
      return JSON.stringify(f.plate);
    case 'classes':
      return f.classes.join(',');
    case 'colours':
      return f.colours.join(',');
    case 'cameras':
      return f.place.cameraExternalIds.join(',');
    case 'districts':
      return f.place.districts.join(',');
    case 'nearName':
      return f.place.nearName ?? '';
    case 'radius':
      return JSON.stringify(f.place.radius);
    case 'from':
      return f.time.from ?? '';
    case 'to':
      return f.time.to ?? '';
    case 'minConfidence':
      return String(f.minConfidence);
    case 'bestShotOnly':
      return String(f.bestShotOnly);
    case 'sequence':
      return JSON.stringify(dsl.sequence);
  }
}

/**
 * Removes one constraint, returning a new filter.
 *
 * Removal rather than free-text editing is the primary affordance on purpose. The most valuable
 * correction an officer can make to a compiled filter is *deleting a constraint the model invented*
 * — that is the failure mode that silently hides the sightings they were looking for, and it was
 * the dominant miss measured against the local model (`docs/nl-query.md` § accuracy). Widening is
 * always safe; narrowing is what needs a keyboard, and that is what the manual filter is for.
 */
export function removeChip(dsl: ConsoleDsl, id: ChipId): ConsoleDsl {
  const next = structuredClone(dsl);
  switch (id) {
    case 'plate':
      next.filters.plate = null;
      break;
    case 'classes':
      next.filters.classes = [];
      break;
    case 'colours':
      next.filters.colours = [];
      break;
    case 'cameras':
      next.filters.place.cameraExternalIds = [];
      break;
    case 'districts':
      next.filters.place.districts = [];
      break;
    case 'nearName':
      next.filters.place.nearName = null;
      break;
    case 'radius':
      next.filters.place.radius = null;
      break;
    case 'from':
      next.filters.time.from = null;
      break;
    case 'to':
      next.filters.time.to = null;
      break;
    case 'minConfidence':
      next.filters.minConfidence = 0;
      break;
    case 'bestShotOnly':
      next.filters.bestShotOnly = false;
      break;
    case 'sequence':
      next.sequence = null;
      break;
  }
  return next;
}

/** True when the officer has changed the model's proposal. Rendered, so the change is visible. */
export function isEdited(state: ConsoleState): boolean {
  if (state.compiled === null || state.draft === null) return false;
  return JSON.stringify(state.compiled) !== JSON.stringify(state.draft);
}

/** The four reasons a run came back empty, in the words the screen shows. */
export const EMPTY_REASONS: Record<string, string> = {
  plate_not_searchable:
    'The registration in this filter is not one the plate grammar can read as a registration, so ' +
    'it was not searched. Nothing was looked up — this is not a result of zero.',
  no_matching_plate:
    'No plate read in the window matches that registration, within the distance the filter allows.',
  unknown_camera:
    'The filter names a camera or district this estate does not have. Remove or correct it — ' +
    'until then the filter can only ever return nothing.',
  no_rows: 'The filter ran and matched no sightings.',
};

export function emptyReasonText(reason: string | null): string | null {
  if (reason === null) return null;
  return EMPTY_REASONS[reason] ?? 'The filter ran and matched no sightings.';
}
