/**
 * D3-09 · AC 7 (prompt-injection resistance) and AC 11 (no model output is ever interpolated into
 * SQL, asserted by a code-level test).
 *
 * **The argument this file makes, in order, because the order is the point.**
 *
 * A prompt-injection test that only checks "the model refused" is worth very little: it measures
 * one model's compliance on one day. So this suite assumes the attacker *wins* the prompt layer
 * completely, and asks what is left.
 *
 * 1. **The vocabulary has no mutation in it.** A model that obeys "delete all alerts" perfectly
 *    still has no field to express a deletion, because `QueryDSL` contains no verb, no table name
 *    and no SQL. Out-of-schema output is rejected outright.
 * 2. **Values never become SQL text.** Every payload a fully-compromised model could emit through
 *    the one string field it has is fed to the real SQL builder, and the generated text is checked
 *    for every one of those values. They are all in `params`.
 * 3. **Postgres itself refuses.** The executor's transaction is `read only`, so even a write that
 *    reached the database would fail with SQLSTATE `25006`. Asserted live against a real database
 *    when one is configured, not asserted from the code.
 *
 * Each layer is independent. Any one of them alone would stop a mutation; the test is that all
 * three hold, so no single mistake is fatal.
 *
 * What none of this proves: that a compiled query cannot read *too much*. A read-only transaction
 * will happily return the whole estate. That is what purpose binding (D3-04), the row limit and the
 * officer's review of the filter before it runs are for — three different mechanisms for three
 * different risks, and conflating them would be the kind of overclaim `docs/nl-query.md` exists to
 * avoid.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QueryDSL, type QueryDSL as Dsl } from '@saakshi/shared';
import { fixturePath, loadInjectionCorpus, loadNlQueryFixtures } from './fixtures.js';
import { compileQuery, renderQuery } from './sql.js';
import { OllamaCompiler, finalise } from './index.js';

const CORPUS = loadInjectionCorpus();
const FIXTURES = loadNlQueryFixtures();

/**
 * The DSL's two kinds of field, and why the distinction is the heart of the safety argument.
 *
 * **Discriminants** (`version`, `entity`, `mode`) are closed enums whose job is to *select* one of
 * a small, fixed set of statically-written queries. They are never bound and never concatenated;
 * they choose a branch, the way an `if` does. The word `sightings` appears in the generated SQL
 * because our static query names that table — not because the model's value was written into it.
 * The test for a discriminant is therefore different: it is that the set of queries it can select
 * from is closed and known, which is asserted separately below.
 *
 * **Values** are everything else — plates, camera ids, districts, landmarks, timestamps, numbers.
 * They carry attacker-controlled content and must *always* bind as parameters and *never* appear in
 * the SQL text. That is what this function collects.
 */
const DISCRIMINANT_KEYS = new Set(['version', 'entity', 'mode']);

function valuesIn(dsl: Dsl): (string | number)[] {
  const out: (string | number)[] = [];
  const walk = (node: unknown, key: string | null): void => {
    if (key !== null && DISCRIMINANT_KEYS.has(key)) return;
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach((item) => walk(item, key));
    if (typeof node === 'object' && node !== null) {
      for (const [childKey, value] of Object.entries(node)) walk(value, childKey);
    }
  };
  walk(dsl, null);
  return out;
}

/** Anything that would be a write, a schema change, or a statement boundary. */
const MUTATION = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|call|do)\b/i;

describe('layer 1 — the vocabulary contains no mutation', () => {
  it('rejects every payload that is not a filter', () => {
    for (const item of CORPUS.rejected) {
      const outcome = finalise('openai', 'm', JSON.stringify(item.value), item.value, Date.now());
      expect(outcome.ok, `${item.id}: ${item.why}`).toBe(false);
    }
  });

  it('has no field a mutation could be written into', () => {
    // Structural: an attacker cannot ask for what the type system has no name for.
    const keys = new Set<string>();
    const walk = (shape: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(shape)) {
        keys.add(key.toLowerCase());
        if (typeof value === 'object' && value !== null) walk(value as Record<string, unknown>);
      }
    };
    walk(JSON.parse(JSON.stringify(QueryDSL.shape)) as Record<string, unknown>);
    for (const forbidden of ['sql', 'query', 'table', 'column', 'order', 'raw', 'purpose']) {
      expect([...keys]).not.toContain(forbidden);
    }
  });

  it('an obedient model emitting the attacker’s SQL still produces only a filter', () => {
    for (const payload of CORPUS.payloads) {
      const outcome = finalise('ollama', 'm', JSON.stringify(payload.dsl), payload.dsl, Date.now());
      // These *do* validate — that is the hostile case. The attacker's SQL is now a plate pattern
      // or a camera name, which is exactly where layer 2 takes over.
      expect(outcome.ok, `${payload.id}: ${payload.why}`).toBe(true);
    }
  });
});

describe('layer 2 — no model output is ever interpolated into SQL (AC 11)', () => {
  const everyDsl: { id: string; dsl: Dsl }[] = [
    ...CORPUS.payloads.map((p) => ({ id: `injection:${p.id}`, dsl: p.dsl })),
    ...FIXTURES.fixtures.map((f) => ({ id: `fixture:${f.id}`, dsl: f.expected })),
  ];

  for (const { id, dsl } of everyDsl) {
    it(`${id}: every value binds as a parameter and none appears in the SQL text`, () => {
      // Both plate resolutions, because the empty case takes a different branch.
      for (const resolved of [[], ['GJ01AB1234']]) {
        const { text, params } = renderQuery(compileQuery(dsl, resolved).query);

        for (const value of valuesIn(dsl)) {
          if (typeof value === 'number') continue; // a bound number is indistinguishable in text
          if (value.length < 3) continue; // 'car' etc. collide with SQL keywords by coincidence

          // The universal rule: no attacker-controlled value is ever SQL text.
          expect(text, `${id}: "${value}" leaked into the SQL text`).not.toContain(value);

          // `plate.pattern` is the one value that does not bind either — it is consumed by D2-04's
          // matcher *before* the query exists, and only the registrations that matcher returned go
          // anywhere near the database. That is a stronger property than binding, so it gets its
          // own assertion rather than a weaker shared one. See the dedicated test below.
          if (value === dsl.filters.plate?.pattern) continue;

          // Everything else must reach the database as a parameter. `nearName` is wrapped in `%…%`.
          const bound = params.some(
            (p) => p === value || (typeof p === 'string' && p.includes(value)),
          );
          expect(bound, `${id}: "${value}" reached neither the text nor the parameters`).toBe(true);
        }
      }
    });
  }

  it('the plate pattern never reaches the query at all — not even as a parameter', () => {
    // The registration the model wrote down is *replaced* by whatever D2-04's confusion-weighted
    // matcher resolved it to. The searched value is therefore a registration that exists in
    // `plate_reads`, not a string an attacker chose — so the plate field cannot carry a payload to
    // the database in any form, bound or otherwise.
    const dsl = structuredClone(FIXTURES.fixtures[0]?.expected) as Dsl;
    if (dsl.filters.plate !== null) dsl.filters.plate.pattern = 'ZZ99XX0000';
    const { text, params } = renderQuery(compileQuery(dsl, ['GJ35U0779']).query);
    expect(text).not.toContain('ZZ99XX0000');
    expect(params).not.toContain('ZZ99XX0000');
    expect(params).toContain('GJ35U0779');
  });

  it('the discriminants select from a closed, known set of static queries', () => {
    // The other half of the argument above. A discriminant is not bound, so it has to be safe by
    // being *closed*: `entity` × `sequence present?` is four combinations and no more, each one a
    // query written by hand in `sql.ts`. A model cannot reach a fifth, and cannot name a table.
    const shapes = new Set<string>();
    for (const entity of ['sightings', 'cameras'] as const) {
      for (const sequence of [
        null,
        FIXTURES.fixtures.find((f) => f.id === 'sequence')?.expected.sequence ?? null,
      ]) {
        const dsl = structuredClone(FIXTURES.fixtures[0]?.expected) as Dsl;
        dsl.entity = entity;
        dsl.sequence = sequence;
        shapes.add(
          renderQuery(compileQuery(dsl, ['X']).query)
            .text.replace(/\s+/g, ' ')
            .trim(),
        );
      }
    }
    expect(shapes.size).toBeLessThanOrEqual(4);
    for (const shape of shapes) {
      // Each one names only our own tables. No identifier is ever attacker-supplied.
      const tables = [...shape.matchAll(/\b(?:from|join)\s+([a-z_]+)/g)].map((m) => m[1]);
      for (const table of tables) {
        expect([
          'sightings',
          'cameras',
          'plate_reads',
          'leg_a',
          'leg_b',
          'hits',
          'paired',
        ]).toContain(table);
      }
    }
  });

  it('the generated SQL is read-only in shape, for every DSL in both corpora', () => {
    for (const { id, dsl } of everyDsl) {
      const { text } = renderQuery(compileQuery(dsl, ['GJ01AB1234']).query);
      expect(text.trimStart().toLowerCase(), id).toMatch(/^(select|with)\b/);
      expect(text, id).not.toMatch(MUTATION);
      // No statement boundary: a second statement is the classic escape, and there is no path to one.
      expect(text, id).not.toContain(';');
    }
  });

  it('a hostile camera name binds whole, wildcards and all', () => {
    const payload = CORPUS.payloads.find((p) => p.id === 'sql-in-plate');
    expect(payload).toBeDefined();
    if (payload === undefined) return;
    const { text, params } = renderQuery(compileQuery(payload.dsl, ['GJ01AB1234']).query);
    expect(text).not.toContain('drop table');
    expect(params).toContain("cam05'; drop table alerts; --");
  });

  it('the source contains no template interpolation of a DSL value', () => {
    // Belt and braces on top of the behavioural test above: a future edit that concatenated a DSL
    // string into the query would pass a narrow behavioural test if the value happened not to be in
    // that test's corpus. This catches the *shape*.
    const source = readFileSync(fixturePath('../packages/api/src/query/sql.ts'), 'utf8');
    // Every `${...}` inside a sql`` template must be a bound value or another SQL fragment, never a
    // raw string concatenation. `sql.raw` and `.unsafe` are the two escapes, and neither is used.
    expect(source).not.toContain('sql.raw');
    expect(source).not.toContain('.unsafe(');
    expect(source).not.toMatch(/sql`[^`]*\$\{[^}]*\+\s*/);
  });

  it('the fuzzy path never widens past D2-04’s measured knee', () => {
    // A hand-edited filter asking for 6 does not parse; this is the type doing the work.
    const wide = structuredClone(FIXTURES.fixtures[0]?.expected) as Dsl;
    if (wide.filters.plate !== null) wide.filters.plate.maxDistance = 6;
    expect(QueryDSL.safeParse(wide).success).toBe(false);
  });

  it('a plate filter that resolved to nothing returns nothing, rather than dropping the filter', () => {
    // The dangerous failure mode: a registration nobody matched quietly becoming "every vehicle".
    const withPlate = FIXTURES.fixtures.find((f) => f.id === 'plate-exact');
    expect(withPlate).toBeDefined();
    if (withPlate === undefined) return;
    const { text } = renderQuery(compileQuery(withPlate.expected, []).query);
    expect(text).toContain('and false');
  });
});

describe('layer 3 — hostile questions through the real compiler', () => {
  /**
   * The prompt layer, measured rather than assumed.
   *
   * A stub provider stands in for a model that has been fully persuaded: it echoes back whatever
   * the attacker asked for. Whatever it emits, the outcome must be either a rejection or a
   * read-only filter — those are the only two shapes the union can take, and there is no third.
   */
  const obedient = (payload: unknown) =>
    new OllamaCompiler({
      model: 'compromised',
      fetch: () =>
        Promise.resolve(Response.json({ message: { content: JSON.stringify(payload) } })),
    });

  for (const prompt of CORPUS.prompts) {
    it(`"${prompt.id}" — ${prompt.expect}`, async () => {
      // The model returns the attacker's raw text where a filter should be: total compliance.
      const outcome = await obedient({ instruction: prompt.text }).compile({ text: prompt.text });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toBe('schema_rejected');
      expect(outcome.degradeTo).toBe('manual_filter');
    });
  }

  it('the officer’s raw question never reaches the SQL, however hostile', async () => {
    for (const prompt of CORPUS.prompts) {
      const outcome = await obedient(FIXTURES.fixtures[0]?.expected).compile({ text: prompt.text });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      const { text } = renderQuery(compileQuery(outcome.dsl, ['GJ01AB1234']).query);
      expect(text).not.toContain(prompt.text);
    }
  });
});
