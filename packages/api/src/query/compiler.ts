/**
 * The `QueryCompiler` seam (D3-09) — one interface, four providers, and exactly one place where a
 * model's output is allowed to become a `QueryDSL`.
 *
 * **Why the interface exists at all.** The challenge asks for an "open, modular, standards-based,
 * vendor-neutral" architecture that avoids lock-in. That is easy to claim and hard to evidence, so
 * the shape of the claim here is deliberately falsifiable: one config value moves the whole system
 * between a proprietary API, a different proprietary API, a local open-weights model, and no model
 * at all — and `npm run demo:provider-swap` runs the same question through them on stage. With
 * `ollama` or `none` **nothing proprietary is load-bearing**; the system is fully functional and
 * fully open.
 *
 * **Why `finalise` is not a convenience.** Every adapter returns through it, and it is the only
 * function in the package that calls `QueryDSL.safeParse`. That is what makes AC 1 — "*any*
 * compiler output failing validation is rejected" — a property of the architecture rather than a
 * discipline each adapter has to remember. A new provider added next year cannot forget to
 * validate, because there is no other way to produce a successful outcome.
 *
 * **Why nothing throws.** `compile` returns a discriminated union and never rejects. A control room
 * at 03:00 does not want a stack trace when someone's API key expires; it wants the manual filter
 * it was already using, and a sentence explaining why the clever box is quiet. Every failure
 * carries `degradeTo: 'manual_filter'` and a message written for that reader.
 */
import { QueryDSL, queryDslJsonSchema, type QueryEntity } from '@saakshi/shared';

export const QUERY_PROVIDERS = ['openai', 'anthropic', 'ollama', 'none'] as const;
export type QueryProvider = (typeof QUERY_PROVIDERS)[number];

/**
 * Why a compile did not produce a filter. Each maps to a different sentence and a different
 * remedy, which is why this is an enum and not a boolean — "no result" for four unrelated reasons
 * is the failure D2-08 called out on the trace screen, and it would be the same failure here.
 */
export type CompileFailureReason =
  /** `QUERY_COMPILER=none`, or a provider with no credential. The manual filter is the product. */
  | 'not_configured'
  /** The provider was reachable but unhappy: bad key, rate limit, timeout, 5xx, malformed body. */
  | 'provider_error'
  /** The provider answered, and the answer is not a `QueryDSL`. Rejected, never repaired. */
  | 'schema_rejected'
  /** The provider answered validly that it could not express the question in this vocabulary. */
  | 'not_understood';

export interface CompileInput {
  /** The officer's question, verbatim. Recorded in the audit chain; never interpolated into SQL. */
  text: string;
  /**
   * Catalogue vocabulary handed to the model so it names cameras and districts that exist.
   *
   * Grounding in the literal sense: the model is not asked to *know* the estate, it is *shown* it.
   * A question naming a camera that is not in this list compiles to a filter that finds nothing,
   * and the console says which name it did not recognise — rather than the model inventing a
   * plausible neighbour.
   */
  vocabulary?: QueryVocabulary;
  /** Anchors relative expressions ("last night", "between 02:00 and 04:00"). Defaults to now. */
  now?: Date;
  /** Default entity when the question does not imply one. */
  entity?: QueryEntity;
  signal?: AbortSignal;
}

export interface QueryVocabulary {
  cameraExternalIds: string[];
  districts: string[];
}

export interface CompileSuccess {
  ok: true;
  provider: QueryProvider;
  model: string | null;
  dsl: QueryDSL;
  /** The provider's raw payload, for the audit entry and for the transcript recorder. */
  raw: string;
  tookMs: number;
}

export interface CompileFailure {
  ok: false;
  provider: QueryProvider;
  model: string | null;
  reason: CompileFailureReason;
  /** Written for a control-room operator, not for a log aggregator. */
  message: string;
  /** Validation issues, when `reason` is `schema_rejected`. Shown so the rejection is reviewable. */
  issues: string[];
  raw: string | null;
  tookMs: number;
  /** There is always somewhere to go. This is the contract that makes AC 5 structural. */
  degradeTo: 'manual_filter';
}

export type CompileOutcome = CompileSuccess | CompileFailure;

export interface QueryCompiler {
  readonly provider: QueryProvider;
  readonly model: string | null;
  /** Never throws. Never rejects. Always returns an outcome a screen can render. */
  compile(input: CompileInput): Promise<CompileOutcome>;
}

/**
 * The sentence a provider failure shows an officer.
 *
 * It says what happened, that the data is unaffected, and what to do instead — because the one
 * thing a degraded NL box must never imply is that the *search* came back empty.
 */
export const DEGRADED_MESSAGE =
  'The plain-English box is unavailable, so it has been switched off. Nothing else has changed: ' +
  'use the filters below, which query the same data directly.';

export const NOT_CONFIGURED_MESSAGE =
  'No query model is configured, so questions are entered with the filters below. They query the ' +
  'same data and are the system’s primary path — the plain-English box is a convenience on top.';

/**
 * The **only** path from a provider response to a `QueryDSL`.
 *
 * Note what it does not do: it does not coerce, does not fill in a missing field, does not strip an
 * unexpected key and retry, and does not fall back to a "best effort" filter. Out-of-schema output
 * is rejected, never guessed at — a repaired filter is a filter nobody wrote, run against a
 * citizen's movements, and the officer approving it would be approving our repair rather than the
 * model's proposal.
 */
export function finalise(
  provider: QueryProvider,
  model: string | null,
  raw: string,
  parsed: unknown,
  startedAt: number,
): CompileOutcome {
  const result = QueryDSL.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      provider,
      model,
      reason: 'schema_rejected',
      message:
        'The model’s answer was not a valid filter, so it was rejected rather than guessed at. ' +
        'Rephrase the question, or use the filters below.',
      issues: result.error.issues.map(
        (issue: { path: PropertyKey[]; message: string }) =>
          `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      ),
      raw,
      tookMs: Date.now() - startedAt,
      degradeTo: 'manual_filter',
    };
  }
  return { ok: true, provider, model, dsl: result.data, raw, tookMs: Date.now() - startedAt };
}

export function fail(
  provider: QueryProvider,
  model: string | null,
  reason: CompileFailureReason,
  message: string,
  startedAt: number,
  raw: string | null = null,
): CompileFailure {
  return {
    ok: false,
    provider,
    model,
    reason,
    message,
    issues: [],
    raw,
    tookMs: Date.now() - startedAt,
    degradeTo: 'manual_filter',
  };
}

/**
 * `QUERY_COMPILER=none` — and the reason this is a *provider* rather than a null check scattered
 * through the callers.
 *
 * The deterministic filter UI is not a fallback bolted on for when the model fails; it is the
 * primary interface, and the compiler is a convenience above it. Modelling "no model" as a first
 * class provider is what keeps that true: every screen and every route already handles a compiler
 * that declines, so the open-source-only deployment is the *same* code path the degraded one takes,
 * exercised on every run rather than only in the incident.
 */
export class NoneCompiler implements QueryCompiler {
  readonly provider = 'none' as const;
  readonly model = null;

  compile(): Promise<CompileOutcome> {
    return Promise.resolve(
      fail('none', null, 'not_configured', NOT_CONFIGURED_MESSAGE, Date.now()),
    );
  }
}

// ── The prompt ──────────────────────────────────────────────────────────────────────────────────

/**
 * The system prompt.
 *
 * It is short on purpose. A long prompt full of prohibitions ("do not write SQL", "do not answer
 * the question") reads as though those prohibitions are what stops the model — and they are not.
 * The schema stops it: it cannot emit SQL because there is no field to emit SQL into, and it cannot
 * answer because nothing it returns is ever shown to the officer as an answer. The prompt's job is
 * only to raise the *quality* of the filter, so that is all it addresses.
 *
 * The one behavioural instruction that matters is the last: return the unconstrained filter rather
 * than inventing constraints. A model guessing at a district it was not given is the single failure
 * mode that produces a confident, wrong, un-noticeable answer.
 */
export function systemPrompt(input: CompileInput): string {
  const now = (input.now ?? new Date()).toISOString();
  const vocabulary = input.vocabulary;
  const lines = [
    'You translate an Indian police control-room officer’s question about CCTV vehicle sightings',
    'into a filter object. You never answer the question, and you never see any data.',
    '',
    `The current time is ${now}. Resolve relative times ("last night", "between 02:00 and 04:00")`,
    'against it and emit absolute ISO-8601 UTC instants.',
    '',
    'Rules:',
    '- Emit only the filter object. Every property must be present; use null or [] for "no constraint".',
    '',
    '- **Never invent a constraint the officer did not state.** This is the most important rule. If',
    '  they did not name a registration, plate MUST be null. If they did not state a confidence,',
    '  minConfidence MUST be 0. An invented constraint silently hides the sightings the officer was',
    '  looking for, and they cannot tell that it did.',
    '',
    '- plate.pattern is a literal registration or the start of one — letters and digits only, e.g.',
    '  GJ01AB1234 or GJ01AB. It is NOT a regular expression and NOT a description. If you cannot',
    '  write down actual characters the officer gave you, plate is null.',
    '- Use mode "exact" for a complete registration, "prefix" when the officer gives only the start of',
    '  one, and "fuzzy" when they say the read was unclear or partial. maxDistance may never exceed 2.',
    '',
    '- Vehicle body descriptions ("hatchback", "sedan", "SUV") are cars: use classes ["car"]. Colours',
    '  must come from the colour list; a colour that is not in it is no colour constraint at all.',
    '- Use only camera ids and districts from the vocabulary below. If the officer names a place that',
    '  is not in it, put it in place.nearName instead of guessing a camera or a district.',
    '- "then later near X", "and afterwards seen at Y" is the sequence field, not a second filter.',
    '- entity is "sightings" for "which vehicles / show me vehicles", and "cameras" only for "which',
    '  cameras / where was it seen".',
    '- If the question cannot be expressed with these fields, return the filter with every constraint',
    '  empty rather than inventing constraints that were not asked for.',
  ];
  if (vocabulary !== undefined) {
    lines.push(
      '',
      `Camera ids: ${vocabulary.cameraExternalIds.slice(0, 200).join(', ') || '(none known)'}`,
      `Districts: ${vocabulary.districts.slice(0, 100).join(', ') || '(none known)'}`,
    );
  }
  return lines.join('\n');
}

/**
 * The user turn.
 *
 * The officer's text is placed in its own message and labelled as a question to translate, never
 * concatenated into the instructions. That is the standard mitigation for instruction injection and
 * it is worth being honest about its strength: it *reduces* the chance a model obeys "ignore
 * previous instructions", it does not eliminate it. The reason injection cannot cause harm here is
 * not this boundary — it is that the most a fully-obedient model can emit is a filter, and a filter
 * runs read-only against a parameterised query. See `docs/nl-query.md` § threat model.
 */
export function userPrompt(text: string): string {
  return `Translate this question into the filter object:\n\n${text}`;
}

/** Exposed so every adapter and the demo hand the providers a byte-identical schema. */
export function providerSchema(): Record<string, unknown> {
  return queryDslJsonSchema();
}

export const SCHEMA_NAME = 'saakshi_query_filter';
