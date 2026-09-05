/**
 * The ollama adapter — the leg that makes "nothing proprietary is load-bearing" true rather than
 * aspirational.
 *
 * With `QUERY_COMPILER=ollama` the entire system is open source and runs with no external network
 * call and no vendor account: open-weights model, local inference, our own schema. The challenge's
 * About page says solutions *should* use open-source technologies; this is the file that lets us
 * say the NL query feature does, without an asterisk. The two proprietary providers are then a
 * convenience and a portability demonstration — not a dependency.
 *
 * **Constrained decoding here too.** ollama's `format` takes a JSON Schema and compiles it to a
 * decoding grammar, so the same portable schema constrains a local 7B model the same way it
 * constrains a frontier one. That is precisely why `queryDslJsonSchema()` stays inside the subset
 * all three honour — a schema that only two of them enforce would make the third leg of the swap a
 * different, weaker thing wearing the same name.
 *
 * `temperature: 0` because this is a translation, not a composition: the same question should
 * produce the same filter, and an officer re-running a query should not get a different answer.
 */
import {
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
import { ProviderHttpError, parseModelJson, postJson, type HttpFetch } from './http.js';

export interface OllamaCompilerOptions {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: HttpFetch;
}

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

export class OllamaCompiler implements QueryCompiler {
  readonly provider = 'ollama' as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: HttpFetch;

  constructor(options: OllamaCompilerOptions) {
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Generous next to the hosted providers' 20 s: a 7B model on a laptop CPU is slower than an
    // API call to a datacentre, and timing it out would misreport "the local option does not work"
    // when the honest finding is "the local option is slower". The demo prints the real number.
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  requestBody(input: CompileInput): Record<string, unknown> {
    return {
      model: this.model,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt(input) },
        { role: 'user', content: userPrompt(input.text) },
      ],
      format: providerSchema(),
      options: { temperature: 0 },
    };
  }

  async compile(input: CompileInput): Promise<CompileOutcome> {
    const startedAt = Date.now();
    try {
      const body = await postJson(
        `${this.baseUrl}/api/chat`,
        this.requestBody(input),
        {},
        {
          baseUrl: this.baseUrl,
          timeoutMs: this.timeoutMs,
          fetch: this.fetchImpl,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
      );
      const text = extractContent(body);
      if (text === null) {
        return fail(
          this.provider,
          this.model,
          'provider_error',
          'The local model returned no filter. Use the filters below.',
          startedAt,
          JSON.stringify(body).slice(0, 2000),
        );
      }
      return finalise(this.provider, this.model, text, parseModelJson(text), startedAt);
    } catch (error) {
      const [reason, message] = classify(error);
      // The local provider's characteristic failure is "ollama is not running", which is a setup
      // problem with a one-line remedy — worth saying rather than reporting as a generic outage.
      // Unreachable and 404-on-model both mean the same thing to the person who has to fix it.
      const unreachable =
        error instanceof ProviderHttpError
          ? error.kind === 'transport' || error.status === 404
          : true;
      const local = unreachable
        ? `The local query model at ${this.baseUrl} could not be reached — check that ollama is ` +
          `running and that \`ollama pull ${this.model}\` has completed. Use the filters below.`
        : message;
      return fail(this.provider, this.model, reason, local, startedAt);
    }
  }
}

export function extractContent(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const message = (body as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  return typeof content === 'string' && content.trim() !== '' ? content : null;
}
