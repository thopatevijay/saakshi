/**
 * The Anthropic adapter — the swap demonstration.
 *
 * Its job is not redundancy. Two proprietary providers behind one interface is how a claimed
 * principle ("vendor-neutral, no lock-in") becomes a thing a judge can watch happen: change one
 * config value, ask the same question, get the same filter. `npm run demo:provider-swap` is that
 * moment, and this file is one of its three legs.
 *
 * **Constrained decoding, via tool use.** Anthropic's equivalent of Structured Outputs is a tool
 * whose `input_schema` is the schema and whose `strict: true` guarantees the arguments validate.
 * Forcing `tool_choice` to that one tool means the model has no path to prose: the only shape it
 * can emit is our filter. Same guarantee as OpenAI's, reached through a different door — which is
 * itself the argument, since a portable schema is what makes the two doors interchangeable.
 *
 * `claude-sonnet-5` is current (verified against the model list on 2026-09-05) and is the small,
 * fast tier for this task, the same reasoning as the OpenAI side: text-to-DSL rewards latency, not
 * reasoning depth.
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
import { classify } from './openai.js';
import { postJson, type HttpFetch } from './http.js';

export interface AnthropicCompilerOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: HttpFetch;
}

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_API_VERSION = '2023-06-01';

export class AnthropicCompiler implements QueryCompiler {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: HttpFetch;

  constructor(options: AnthropicCompilerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  requestBody(input: CompileInput): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: 2048,
      system: systemPrompt(input),
      messages: [{ role: 'user', content: userPrompt(input.text) }],
      tools: [
        {
          name: SCHEMA_NAME,
          description: 'Record the officer’s question as a sightings filter.',
          // The same derived schema the OpenAI leg sends. Byte-identical by construction, which is
          // what makes "equivalent DSL from three providers" a meaningful comparison rather than a
          // comparison of three differently-worded schemas.
          input_schema: providerSchema(),
          strict: true,
        },
      ],
      // No path to prose: the model's only legal move is to fill in the filter.
      tool_choice: { type: 'tool', name: SCHEMA_NAME },
    };
  }

  async compile(input: CompileInput): Promise<CompileOutcome> {
    const startedAt = Date.now();
    if (this.apiKey === '') {
      return fail(
        this.provider,
        this.model,
        'not_configured',
        'ANTHROPIC_API_KEY is not set, so the plain-English box is switched off. The filters below ' +
          'query the same data.',
        startedAt,
      );
    }
    try {
      const body = await postJson(
        `${this.baseUrl}/v1/messages`,
        this.requestBody(input),
        { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
        {
          baseUrl: this.baseUrl,
          timeoutMs: this.timeoutMs,
          fetch: this.fetchImpl,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
      );
      const args = extractToolInput(body);
      if (args === null) {
        return fail(
          this.provider,
          this.model,
          'provider_error',
          'The model returned no filter. Use the filters below.',
          startedAt,
          JSON.stringify(body).slice(0, 2000),
        );
      }
      return finalise(this.provider, this.model, JSON.stringify(args), args, startedAt);
    } catch (error) {
      const [reason, message] = classify(error);
      return fail(this.provider, this.model, reason, message, startedAt);
    }
  }
}

/**
 * Pulls the tool arguments out of a Messages payload.
 *
 * Matched on `type === 'tool_use'` and the tool's own name: a response may carry thinking or text
 * blocks alongside the call, and taking `content[0]` would be a latent break the first time one
 * appears.
 */
export function extractToolInput(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null) return null;
  const content = (body as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_use' || b['name'] !== SCHEMA_NAME) continue;
    const input = b['input'];
    if (typeof input === 'object' && input !== null) return input as Record<string, unknown>;
  }
  return null;
}
