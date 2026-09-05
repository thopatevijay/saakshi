/**
 * D3-09 · the compiler seam.
 *
 * AC 1 (out-of-schema output is rejected with a clear message), AC 2 (all four providers are
 * swappable by config and `none` degrades cleanly), AC 4 (OpenAI sends Structured Outputs with
 * `strict: true` and a schema derived from the zod DSL), AC 5 (every provider failure degrades to
 * the manual filter, never a broken screen and never a silent empty result) and the offline half of
 * AC 6 (the fixture corpus, replayed through the real adapter parsers).
 *
 * Everything here runs with no network and no credential, because `fetch` is injected. What it
 * cannot prove is that a *live* model produces the expected filter — that is measured by
 * `npm run demo:provider-swap`, and the honest numbers are in `docs/nl-query.md`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QueryDSL, queryDslJsonSchema } from '@saakshi/shared';
import { fixturePath, loadInjectionCorpus, loadNlQueryFixtures } from './fixtures.js';
import {
  AnthropicCompiler,
  NoneCompiler,
  OllamaCompiler,
  OpenAiCompiler,
  QUERY_PROVIDERS,
  createQueryCompiler,
  finalise,
  type CompileOutcome,
  type HttpFetch,
} from './index.js';

const FIXTURES = loadNlQueryFixtures();

const SECRETS = {
  openaiApiKey: 'test-key',
  openaiModel: 'gpt-5.6-luna',
  openaiBaseUrl: 'https://openai.test',
  anthropicApiKey: 'test-key',
  anthropicModel: 'claude-sonnet-5',
  anthropicBaseUrl: 'https://anthropic.test',
  ollamaUrl: 'http://ollama.test',
  ollamaModel: 'qwen2.5:7b-instruct',
};

/** Records the outbound request so a test can assert the exact bytes an adapter would send. */
function capturingFetch(respond: (body: unknown) => unknown): {
  fetch: HttpFetch;
  sent: () => { url: string; body: Record<string, unknown>; headers: Record<string, string> };
} {
  let seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null =
    null;
  const fetchImpl: HttpFetch = (url, init) => {
    seen = {
      url,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    };
    return Promise.resolve(
      new Response(JSON.stringify(respond(seen.body)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return {
    fetch: fetchImpl,
    sent: () => {
      if (seen === null) throw new Error('no request was made');
      return seen;
    },
  };
}

function status(code: number): HttpFetch {
  return () => Promise.resolve(new Response('{"error":"nope"}', { status: code }));
}

/** Wraps a DSL in each provider's own response envelope. */
const envelope = {
  openai: (dsl: unknown) => ({ output_text: JSON.stringify(dsl) }),
  anthropic: (dsl: unknown) => ({
    content: [{ type: 'tool_use', name: 'saakshi_query_filter', input: dsl }],
  }),
  ollama: (dsl: unknown) => ({ message: { role: 'assistant', content: JSON.stringify(dsl) } }),
};

describe('the compiler is swappable by config across all four implementations', () => {
  it('builds every provider named in QUERY_COMPILER', () => {
    for (const provider of QUERY_PROVIDERS) {
      const compiler = createQueryCompiler(provider, { secrets: SECRETS });
      expect(compiler.provider).toBe(provider);
    }
  });

  it('names the current, verified model ids', () => {
    // The ticket said "gpt-4.1-mini class — verify the model id against the current model list".
    // It does not survive that check; gpt-5.6-luna is the current small/fast tier with Structured
    // Outputs. claude-sonnet-5 does survive it.
    expect(createQueryCompiler('openai', { secrets: SECRETS }).model).toBe('gpt-5.6-luna');
    expect(createQueryCompiler('anthropic', { secrets: SECRETS }).model).toBe('claude-sonnet-5');
  });

  it('never silently substitutes a provider that has no credential', () => {
    // A deployment that asked for openai and has no key must fail *as openai*, or the audit record
    // would be wrong about which model wrote a filter.
    const compiler = createQueryCompiler('openai', {
      secrets: { ...SECRETS, openaiApiKey: '' },
    });
    expect(compiler.provider).toBe('openai');
  });

  it('`none` degrades to the manual filter rather than erroring', async () => {
    const outcome = await new NoneCompiler().compile({ text: 'white cars at cam05' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not_configured');
    expect(outcome.degradeTo).toBe('manual_filter');
    expect(outcome.message).toMatch(/filters below/);
  });
});

describe('OpenAI adapter — Structured Outputs, strict, schema derived from the zod DSL (AC 4)', () => {
  it('sends strict: true and the derived schema, byte-identical', async () => {
    const capture = capturingFetch(() => envelope.openai(FIXTURES.fixtures[0]?.expected));
    const compiler = new OpenAiCompiler({
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      baseUrl: 'https://openai.test',
      fetch: capture.fetch,
    });
    await compiler.compile({ text: 'show me GJ01AB1234' });

    const sent = capture.sent();
    expect(sent.url).toBe('https://openai.test/v1/responses');
    const format = (sent.body['text'] as { format: Record<string, unknown> }).format;
    expect(format['type']).toBe('json_schema');
    expect(format['strict']).toBe(true);
    // The single-source-of-truth assertion: not "a schema", *the* schema the zod DSL derives.
    expect(format['schema']).toEqual(queryDslJsonSchema());
  });

  it('sends the credential as a bearer token and nowhere else', async () => {
    const capture = capturingFetch(() => envelope.openai(FIXTURES.fixtures[0]?.expected));
    await new OpenAiCompiler({
      apiKey: 'sk-secret-value',
      model: 'gpt-5.6-luna',
      baseUrl: 'https://openai.test',
      fetch: capture.fetch,
    }).compile({ text: 'anything' });
    const sent = capture.sent();
    expect(sent.headers['authorization']).toBe('Bearer sk-secret-value');
    expect(JSON.stringify(sent.body)).not.toContain('sk-secret-value');
  });

  it('reads the long-form Responses payload as well as output_text', async () => {
    const dsl = FIXTURES.fixtures[0]?.expected;
    const compiler = new OpenAiCompiler({
      apiKey: 'k',
      model: 'm',
      fetch: () =>
        Promise.resolve(
          Response.json({
            output: [{ content: [{ type: 'output_text', text: JSON.stringify(dsl) }] }],
          }),
        ),
    });
    const outcome = await compiler.compile({ text: 'x' });
    expect(outcome.ok).toBe(true);
  });
});

describe('Anthropic adapter — tool use with strict, the swap demonstration', () => {
  it('forces the one tool and sends the same derived schema', async () => {
    const capture = capturingFetch(() => envelope.anthropic(FIXTURES.fixtures[0]?.expected));
    await new AnthropicCompiler({
      apiKey: 'k',
      model: 'claude-sonnet-5',
      baseUrl: 'https://anthropic.test',
      fetch: capture.fetch,
    }).compile({ text: 'show me GJ01AB1234' });

    const sent = capture.sent();
    expect(sent.url).toBe('https://anthropic.test/v1/messages');
    expect(sent.headers['x-api-key']).toBe('k');
    const tools = sent.body['tools'] as { name: string; input_schema: unknown; strict: boolean }[];
    expect(tools[0]?.strict).toBe(true);
    // Byte-identical to what the OpenAI leg sends — which is what makes "equivalent DSL from three
    // providers" a comparison of the models rather than of three different schemas.
    expect(tools[0]?.input_schema).toEqual(queryDslJsonSchema());
    expect(sent.body['tool_choice']).toEqual({ type: 'tool', name: 'saakshi_query_filter' });
  });

  it('finds the tool call past a leading text block', async () => {
    const dsl = FIXTURES.fixtures[0]?.expected;
    const outcome = await new AnthropicCompiler({
      apiKey: 'k',
      model: 'm',
      fetch: () =>
        Promise.resolve(
          Response.json({
            content: [
              { type: 'text', text: 'Let me build that filter.' },
              { type: 'tool_use', name: 'saakshi_query_filter', input: dsl },
            ],
          }),
        ),
    }).compile({ text: 'x' });
    expect(outcome.ok).toBe(true);
  });
});

describe('ollama adapter — the leg that makes nothing proprietary load-bearing', () => {
  it('constrains decoding with the same derived schema and runs at temperature 0', async () => {
    const capture = capturingFetch(() => envelope.ollama(FIXTURES.fixtures[0]?.expected));
    await new OllamaCompiler({
      model: 'qwen2.5:7b-instruct',
      baseUrl: 'http://ollama.test',
      fetch: capture.fetch,
    }).compile({ text: 'show me GJ01AB1234' });

    const sent = capture.sent();
    expect(sent.url).toBe('http://ollama.test/api/chat');
    expect(sent.body['format']).toEqual(queryDslJsonSchema());
    expect(sent.body['options']).toEqual({ temperature: 0 });
    expect(sent.body['stream']).toBe(false);
    // No credential exists to send. That is the point of this provider.
    expect(sent.headers['authorization']).toBeUndefined();
  });

  it('names the setup remedy when ollama is not running', async () => {
    const outcome = await new OllamaCompiler({
      model: 'qwen2.5:7b-instruct',
      baseUrl: 'http://ollama.test',
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    }).compile({ text: 'x' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/ollama pull qwen2\.5:7b-instruct/);
  });
});

describe('AC 5 — every provider failure degrades, none throws', () => {
  const cases: { name: string; fetch: HttpFetch; expect: RegExp }[] = [
    { name: 'bad key', fetch: status(401), expect: /credentials/ },
    { name: 'forbidden', fetch: status(403), expect: /credentials/ },
    { name: 'rate limit', fetch: status(429), expect: /rate-limiting/ },
    { name: 'server error', fetch: status(503), expect: /unavailable/ },
    {
      name: 'transport failure',
      fetch: () => Promise.reject(new Error('ENETUNREACH')),
      expect: /could not be reached|unavailable/,
    },
    {
      name: 'body that is not JSON',
      fetch: () => Promise.resolve(new Response('<html>502</html>', { status: 200 })),
      expect: /unavailable|not valid JSON/,
    },
    {
      name: 'valid JSON that is not a filter',
      fetch: () => Promise.resolve(Response.json(envelope.openai('sorry, I cannot help'))),
      expect: /not a valid filter/,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} → manual filter, with a message`, async () => {
      const compiler = new OpenAiCompiler({ apiKey: 'k', model: 'm', fetch: testCase.fetch });
      const outcome = await compiler.compile({ text: 'white cars at cam05' });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.degradeTo).toBe('manual_filter');
      expect(outcome.message).toMatch(testCase.expect);
      // Never a silent empty result: there is always something to say.
      expect(outcome.message.length).toBeGreaterThan(20);
    });
  }

  it('a timeout is reported as a timeout, not as an outage', async () => {
    const compiler = new OpenAiCompiler({
      apiKey: 'k',
      model: 'm',
      timeoutMs: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
          });
        }),
    });
    const outcome = await compiler.compile({ text: 'x' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/did not answer in time/);
  });

  it('an unconfigured credential says which key is missing', async () => {
    for (const [provider, compiler] of [
      ['openai', createQueryCompiler('openai', { secrets: { ...SECRETS, openaiApiKey: '' } })],
      [
        'anthropic',
        createQueryCompiler('anthropic', { secrets: { ...SECRETS, anthropicApiKey: '' } }),
      ],
    ] as const) {
      const outcome = await compiler.compile({ text: 'x' });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.reason).toBe('not_configured');
      expect(outcome.message).toMatch(
        provider === 'openai' ? /OPENAI_API_KEY/ : /ANTHROPIC_API_KEY/,
      );
    }
  });
});

describe('AC 1 — out-of-schema output is rejected, never guessed at', () => {
  const rejected = loadInjectionCorpus();

  for (const item of rejected.rejected) {
    it(`rejects ${item.id} — ${item.why}`, () => {
      const outcome = finalise('openai', 'm', JSON.stringify(item.value), item.value, Date.now());
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toBe('schema_rejected');
      // "Clear message" means an officer can see *what* was wrong, not just that something was.
      expect(outcome.issues.length).toBeGreaterThan(0);
      expect(outcome.degradeTo).toBe('manual_filter');
    });
  }

  it('rejects rather than repairing a filter that is one field short', () => {
    const nearly = structuredClone(FIXTURES.fixtures[0]?.expected) as Record<string, unknown>;
    delete (nearly['filters'] as Record<string, unknown>)['minConfidence'];
    const outcome = finalise('ollama', 'm', '{}', nearly, Date.now());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.join(' ')).toMatch(/minConfidence/);
  });

  it('is the only door: every adapter reaches a DSL through finalise', async () => {
    // Structural, not stylistic. If a future adapter parsed and returned a DSL itself, AC 1 would
    // hold for three providers and quietly not for the fourth.
    const sources = ['openai.ts', 'anthropic.ts', 'ollama.ts'].map((file) =>
      readFileSync(fixturePath(`../packages/api/src/query/${file}`), 'utf8'),
    );
    for (const source of sources) {
      expect(source).toContain('finalise(');
      expect(source).not.toMatch(/QueryDSL\.(safe)?[Pp]arse/);
    }
    // And the successful path really does come back typed.
    const capture = capturingFetch(() => envelope.ollama(FIXTURES.fixtures[0]?.expected));
    const outcome = await new OllamaCompiler({ model: 'm', fetch: capture.fetch }).compile({
      text: 'x',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(QueryDSL.safeParse(outcome.dsl).success).toBe(true);
  });
});

describe('AC 6 — the fixture corpus', () => {
  it('carries at least 15 questions', () => {
    expect(FIXTURES.fixtures.length).toBeGreaterThanOrEqual(15);
  });

  it('every expected filter is itself a valid DSL', () => {
    for (const fixture of FIXTURES.fixtures) {
      const result = QueryDSL.safeParse(fixture.expected);
      expect(result.success, `${fixture.id}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('replays each fixture through every adapter’s real parser and reaches the expected DSL', async () => {
    // Provider-shaped envelopes around the expected filter: this exercises the extraction and
    // validation path each adapter really uses, for all 18 questions, on all three providers.
    for (const fixture of FIXTURES.fixtures) {
      const outcomes: CompileOutcome[] = [
        await new OpenAiCompiler({
          apiKey: 'k',
          model: 'm',
          fetch: () => Promise.resolve(Response.json(envelope.openai(fixture.expected))),
        }).compile({ text: fixture.question }),
        await new AnthropicCompiler({
          apiKey: 'k',
          model: 'm',
          fetch: () => Promise.resolve(Response.json(envelope.anthropic(fixture.expected))),
        }).compile({ text: fixture.question }),
        await new OllamaCompiler({
          model: 'm',
          fetch: () => Promise.resolve(Response.json(envelope.ollama(fixture.expected))),
        }).compile({ text: fixture.question }),
      ];
      for (const outcome of outcomes) {
        expect(outcome.ok, `${fixture.id} (${outcome.provider})`).toBe(true);
        if (!outcome.ok) continue;
        expect(outcome.dsl, fixture.id).toEqual(fixture.expected);
      }
    }
  });

  it('tolerates a fenced code block but repairs nothing else', async () => {
    const dsl = FIXTURES.fixtures[0]?.expected;
    const fenced = await new OllamaCompiler({
      model: 'm',
      fetch: () =>
        Promise.resolve(
          Response.json({ message: { content: `\`\`\`json\n${JSON.stringify(dsl)}\n\`\`\`` } }),
        ),
    }).compile({ text: 'x' });
    expect(fenced.ok).toBe(true);

    const trailingComma = await new OllamaCompiler({
      model: 'm',
      fetch: () => Promise.resolve(Response.json({ message: { content: '{"version":1,}' } })),
    }).compile({ text: 'x' });
    expect(trailingComma.ok).toBe(false);
  });
});
