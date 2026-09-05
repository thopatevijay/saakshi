/**
 * The one HTTP helper the three live adapters share.
 *
 * `fetch` is injected rather than imported so a test can assert the **exact bytes** an adapter
 * would put on the wire — that `strict: true` is really set, that the schema really is the one
 * derived from the zod DSL, that no API key leaks into a log line — without a network, a
 * credential, or a recorded cassette. AC 4 is a claim about a request body, so the test has to be
 * able to read the request body.
 *
 * Vendor SDKs would have made that harder and would have added three proprietary packages to a
 * repository whose entire argument is that nothing proprietary is load-bearing. Three JSON POSTs
 * are not worth that.
 */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProviderHttpOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch: HttpFetch;
  signal?: AbortSignal;
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: 'auth' | 'rate_limit' | 'timeout' | 'transport' | 'server' | 'malformed',
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

/**
 * POSTs JSON and returns the parsed body, classifying every failure into something the console can
 * say out loud.
 *
 * The classification is not cosmetic. "Your API key is wrong" and "the provider is rate-limiting
 * us" have different remedies and different people to tell, and collapsing both into "compile
 * failed" is how a control room ends up with a permanently quiet box nobody has diagnosed.
 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options: ProviderHttpOptions,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

  let response: Response;
  try {
    response = await options.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    // A timeout arrives as an AbortError, and it is worth separating: it is the failure a busy
    // control room actually hits, and the remedy (a smaller model, a longer budget) is specific.
    const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    throw new ProviderHttpError(
      aborted ? `no response within ${options.timeoutMs} ms` : describe(error),
      null,
      aborted ? 'timeout' : 'transport',
    );
  }

  if (!response.ok) {
    // Deliberately not included in the thrown message: the response body, which some providers echo
    // request content into. The officer's question is audited on purpose; it does not also belong
    // in an exception that may reach a log shipper.
    const kind =
      response.status === 401 || response.status === 403
        ? 'auth'
        : response.status === 429
          ? 'rate_limit'
          : 'server';
    throw new ProviderHttpError(`provider returned HTTP ${response.status}`, response.status, kind);
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ProviderHttpError('provider returned a body that is not JSON', response.status, 'malformed');
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'transport failure';
}

/**
 * Parses a model's text output as JSON.
 *
 * Tolerant of exactly one thing — a fenced code block — because every one of the three providers
 * occasionally wraps constrained JSON in ``` despite the constraint, and refusing over a fence
 * would report a schema rejection for a filter that is in fact perfectly valid. It is tolerant of
 * nothing else: no trailing-comma repair, no brace balancing, no "extract the first {...}". Those
 * are repairs, and a repaired filter is one nobody wrote.
 */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  return JSON.parse(body) as unknown;
}
