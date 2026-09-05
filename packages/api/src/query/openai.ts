/**
 * The OpenAI adapter — the primary provider, for one concrete reason.
 *
 * Structured Outputs with `strict: true` **constrains decoding** against our JSON schema. The
 * distinction from "ask nicely for JSON and validate afterwards" is not a matter of degree: with
 * constrained decoding a schema-invalid filter is *impossible to generate*, rather than merely
 * unlikely and caught downstream. We still validate on the way back in — `finalise` is the only
 * door — but the failure rate that validation has to catch is a different order of magnitude.
 *
 * **Model id.** The ticket says "`gpt-4.1-mini` class — verify the model id against the current
 * model list". It does not survive that check: `gpt-4.1-mini` is not in OpenAI's current model
 * list (2026-09-05). The current small/fast tier that supports Structured Outputs is
 * `gpt-5.6-luna`, which is what `OPENAI_MODEL` now defaults to. Latency beats reasoning depth for
 * text-to-DSL, so the small tier is the right choice; only the id moved.
 *
 * **Endpoint.** `/v1/responses` rather than `/v1/chat/completions`. It is the surface OpenAI's
 * current documentation describes for Structured Outputs (`text.format`), and `gpt-5.6-luna`
 * supports both — so this is the one that will still be there in a year.
 */
import {
  SCHEMA_NAME,
  fail,
  finalise,
  providerSchema,
  systemPrompt,
  userPrompt,
  type CompileInput,
  type CompileOutcome,
  type QueryCompiler,
} from './compiler.js';
import { ProviderHttpError, parseModelJson, postJson, type HttpFetch } from './http.js';

export interface OpenAiCompilerOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: HttpFetch;
}

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com';

export class OpenAiCompiler implements QueryCompiler {
  readonly provider = 'openai' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: HttpFetch;

  constructor(options: OpenAiCompilerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The exact body this adapter puts on the wire. Exported shape so a test can assert AC 4. */
  requestBody(input: CompileInput): Record<string, unknown> {
    return {
      model: this.model,
      input: [
        { role: 'system', content: systemPrompt(input) },
        { role: 'user', content: userPrompt(input.text) },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: SCHEMA_NAME,
          // Derived from the zod DSL on every call — there is no second copy to drift.
          schema: providerSchema(),
          strict: true,
        },
      },
    };
  }

  async compile(input: CompileInput): Promise<CompileOutcome> {
    const startedAt = Date.now();
    if (this.apiKey === '') {
      return fail(
        this.provider,
        this.model,
        'not_configured',
        'OPENAI_API_KEY is not set, so the plain-English box is switched off. The filters below ' +
          'query the same data.',
        startedAt,
      );
    }
    try {
      const body = await postJson(
        `${this.baseUrl}/v1/responses`,
        this.requestBody(input),
        { authorization: `Bearer ${this.apiKey}` },
        {
          baseUrl: this.baseUrl,
          timeoutMs: this.timeoutMs,
          fetch: this.fetchImpl,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
      );
      const text = extractText(body);
      if (text === null) {
        return fail(
          this.provider,
          this.model,
          'provider_error',
          'The model returned no filter. Use the filters below.',
          startedAt,
          JSON.stringify(body).slice(0, 2000),
        );
      }
      return finalise(this.provider, this.model, text, parseModelJson(text), startedAt);
    } catch (error) {
      const [reason, message] = classify(error);
      return fail(this.provider, this.model, reason, message, startedAt);
    }
  }
}

/**
 * Pulls the constrained JSON out of a Responses payload.
 *
 * Handles both the `output_text` convenience field and the long form, because which one is present
 * depends on the shape of the turn and an adapter that only understood one would fail
 * intermittently — the worst kind of failure to diagnose from a control room.
 */
export function extractText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const payload = body as Record<string, unknown>;

  const direct = payload['output_text'];
  if (typeof direct === 'string' && direct.trim() !== '') return direct;

  const output = payload['output'];
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const content = (item as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const text = (block as Record<string, unknown>)['text'];
      if (typeof text === 'string' && text.trim() !== '') return text;
    }
  }
  return null;
}

/** Maps a transport failure onto a reason and a sentence an officer can act on. */
export function classify(error: unknown): ['provider_error', string] | ['schema_rejected', string] {
  if (error instanceof SyntaxError) {
    return [
      'schema_rejected',
      'The model’s answer was not valid JSON, so it was rejected rather than guessed at.',
    ];
  }
  if (error instanceof ProviderHttpError) {
    switch (error.kind) {
      case 'auth':
        return [
          'provider_error',
          'The query model rejected our credentials, so the plain-English box is switched off. ' +
            'The filters below query the same data.',
        ];
      case 'rate_limit':
        return [
          'provider_error',
          'The query model is rate-limiting us. Try again shortly, or use the filters below.',
        ];
      case 'timeout':
        return [
          'provider_error',
          `The query model did not answer in time (${error.message}). Use the filters below.`,
        ];
      default:
        return [
          'provider_error',
          `The query model is unavailable (${error.message}). Use the filters below.`,
        ];
    }
  }
  return [
    'provider_error',
    'The query model could not be reached. Use the filters below, which query the same data.',
  ];
}
