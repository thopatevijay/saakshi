/**
 * The swap itself: `QUERY_COMPILER` in, a `QueryCompiler` out.
 *
 * This function is the vendor-neutrality claim in executable form. Everything downstream — the
 * routes, the console, the audit entries, the SQL — is written against `QueryCompiler` and cannot
 * tell which provider it got. There is no `if (provider === 'openai')` anywhere past this file, and
 * that absence is what `npm run demo:provider-swap` demonstrates on stage.
 */
import { NoneCompiler, type QueryCompiler, type QueryProvider } from './compiler.js';
import { AnthropicCompiler } from './anthropic.js';
import { OllamaCompiler } from './ollama.js';
import { OpenAiCompiler } from './openai.js';
import type { HttpFetch } from './http.js';

export * from './compiler.js';
export * from './http.js';
export { AnthropicCompiler } from './anthropic.js';
export { OllamaCompiler } from './ollama.js';
export { OpenAiCompiler } from './openai.js';

/**
 * Provider settings read straight from the process environment rather than through the zod `Env`
 * schema.
 *
 * The same reasoning `evidenceStoreFromEnv` uses for MinIO's credentials: a key is optional in
 * effect, must never be logged, and must not be able to fail the boot of an API that has plenty of
 * work to do without a query model. The non-secret half (model ids, base URLs) does have defaults
 * here so that `.env.example` and the code agree.
 */
export interface QueryProviderSecrets {
  openaiApiKey: string;
  openaiModel: string;
  openaiBaseUrl: string | undefined;
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicBaseUrl: string | undefined;
  ollamaUrl: string;
  ollamaModel: string;
}

/**
 * Chosen on a measurement of our own task, not on the model list alone.
 *
 * The ticket named `gpt-4.1-mini` and asked for the id to be verified. It is superseded — the
 * current small/fast family is `gpt-5.6-{luna,sol,terra}` — but "current" was never the whole
 * question. All five candidates were scored against the 18-case fixture suite, and all five were
 * first checked to support Structured Outputs with `strict: true`, since a member that does not is
 * disqualified regardless of accuracy: that guarantee is the grounding argument.
 *
 * | model | exact match | vacuous | mean latency |
 * |---|---|---|---|
 * | **`gpt-5.6-sol`** | **17/18 (94.4%)** | 0 | 3684 ms |
 * | `gpt-5.6-terra`   | 15/18 (83.3%)     | 0 | 2014 ms |
 * | `gpt-5.6-luna`    | 15/18 (83.3%)     | 0 | 2675 ms |
 * | `gpt-4.1-mini`    | 14/18 (77.8%)     | 0 | 2490 ms |
 *
 * `sol` wins on the number that matters and keeps us on the current model list. It costs ~1.7 s
 * against `terra`, and that is the right trade here: an officer waits once per query and reviews the
 * filter either way, whereas a dropped constraint hides the sightings they were looking for and
 * gives them no way to tell. `terra` is the choice if latency ever becomes the binding constraint.
 *
 * Full method and the failure analysis: `docs/nl-query.md` § 5.
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';
/** Current, verified against the model list on 2026-09-05. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b-instruct';

export function providerSecretsFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): QueryProviderSecrets {
  return {
    openaiApiKey: source['OPENAI_API_KEY'] ?? '',
    openaiModel: source['OPENAI_MODEL'] ?? DEFAULT_OPENAI_MODEL,
    openaiBaseUrl: source['OPENAI_BASE_URL'],
    anthropicApiKey: source['ANTHROPIC_API_KEY'] ?? '',
    anthropicModel: source['ANTHROPIC_MODEL'] ?? DEFAULT_ANTHROPIC_MODEL,
    anthropicBaseUrl: source['ANTHROPIC_BASE_URL'],
    ollamaUrl: source['OLLAMA_URL'] ?? 'http://localhost:11434',
    ollamaModel: source['OLLAMA_MODEL'] ?? DEFAULT_OLLAMA_MODEL,
  };
}

export interface CompilerFactoryOptions {
  secrets?: QueryProviderSecrets;
  /** Injected in tests so a whole provider can be exercised without a network or a credential. */
  fetch?: HttpFetch;
  timeoutMs?: number;
}

/**
 * Builds the configured compiler.
 *
 * Note the deliberate absence of a fallback chain. A deployment that asked for `openai` and has no
 * key gets an OpenAI compiler that fails honestly with "OPENAI_API_KEY is not set" — it does not
 * quietly become an ollama deployment. Silent provider substitution would make the audit record
 * wrong about which model wrote a filter, and "which model produced this" is exactly the question
 * a vendor-neutrality argument has to be able to answer.
 */
export function createQueryCompiler(
  provider: QueryProvider,
  options: CompilerFactoryOptions = {},
): QueryCompiler {
  const secrets = options.secrets ?? providerSecretsFromEnv();
  const shared = {
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };

  switch (provider) {
    case 'openai':
      return new OpenAiCompiler({
        apiKey: secrets.openaiApiKey,
        model: secrets.openaiModel,
        ...(secrets.openaiBaseUrl !== undefined ? { baseUrl: secrets.openaiBaseUrl } : {}),
        ...shared,
      });
    case 'anthropic':
      return new AnthropicCompiler({
        apiKey: secrets.anthropicApiKey,
        model: secrets.anthropicModel,
        ...(secrets.anthropicBaseUrl !== undefined ? { baseUrl: secrets.anthropicBaseUrl } : {}),
        ...shared,
      });
    case 'ollama':
      return new OllamaCompiler({
        model: secrets.ollamaModel,
        baseUrl: secrets.ollamaUrl,
        ...shared,
      });
    case 'none':
      return new NoneCompiler();
  }
}
