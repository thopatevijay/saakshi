/**
 * D3-09 · AC 1 (the DSL is defined and closed), AC 4 (the provider schema is *derived* from it,
 * never hand-maintained in a second place) and the structural half of AC 7 (a model cannot express
 * a mutation, because the vocabulary contains none).
 *
 * The through-line of this file: every claim the DSL makes about what a model can and cannot say is
 * tested by trying to say it.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_QUERY_DSL,
  MAX_PLATE_DISTANCE,
  MAX_QUERY_LIMIT,
  QUERY_DSL_VERSION,
  QueryDSL,
  StrictSchemaError,
  assertStrictSubset,
  describeQueryDsl,
  isUnconstrained,
  queryDslJsonSchema,
  toPortableSchema,
} from './query-dsl.js';

/** A structurally complete DSL, so each test can vary exactly one thing. */
function valid(): unknown {
  return structuredClone(EMPTY_QUERY_DSL);
}

describe('QueryDSL', () => {
  it('accepts the empty filter', () => {
    expect(QueryDSL.safeParse(valid()).success).toBe(true);
  });

  it('is closed — an unknown key is a rejection, not a passenger', () => {
    const dsl = valid() as Record<string, unknown>;
    dsl['sql'] = 'select 1';
    const result = QueryDSL.safeParse(dsl);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key nested inside filters', () => {
    const dsl = valid() as { filters: Record<string, unknown> };
    dsl.filters['rawWhere'] = "1=1 or ''='";
    expect(QueryDSL.safeParse(dsl).success).toBe(false);
  });

  it('has no `purpose` field — the model may never state why a search is run', () => {
    // D3-04 (#27) binds every search to a purpose recorded against the officer's badge. A model
    // that could emit one could manufacture the justification for its own query.
    const dsl = valid() as Record<string, unknown>;
    dsl['purpose'] = 'investigating a theft';
    expect(QueryDSL.safeParse(dsl).success).toBe(false);

    const schema = queryDslJsonSchema();
    expect(JSON.stringify(schema)).not.toContain('purpose');
  });

  it('caps maxDistance at D2-04’s measured knee', () => {
    // 3.0 is 91.2% precision, 4.0 is 54.8% and unrelated registrations start matching (#18).
    expect(MAX_PLATE_DISTANCE).toBe(2);
    for (const distance of [2.5, 3, 4, 6]) {
      const dsl = valid() as { filters: { plate: unknown } };
      dsl.filters.plate = { pattern: 'GJ01AB1234', mode: 'fuzzy', maxDistance: distance };
      expect(QueryDSL.safeParse(dsl).success).toBe(false);
    }
    const ok = valid() as { filters: { plate: unknown } };
    ok.filters.plate = { pattern: 'GJ01AB1234', mode: 'fuzzy', maxDistance: 2 };
    expect(QueryDSL.safeParse(ok).success).toBe(true);
  });

  it('admits no quote, semicolon, whitespace or comment marker in a plate pattern', () => {
    const hostile = [
      "GJ01'; DROP TABLE alerts; --",
      'GJ01 AB 1234',
      'GJ01/**/AB',
      'gj01ab1234',
      '',
      '"',
    ];
    for (const pattern of hostile) {
      const dsl = valid() as { filters: { plate: unknown } };
      dsl.filters.plate = { pattern, mode: 'exact', maxDistance: 0 };
      expect(QueryDSL.safeParse(dsl).success, pattern).toBe(false);
    }
  });

  it('rejects a class or colour outside the database enum', () => {
    const classes = valid() as { filters: { classes: unknown } };
    classes.filters.classes = ['tempo'];
    expect(QueryDSL.safeParse(classes).success).toBe(false);

    const colours = valid() as { filters: { colours: unknown } };
    colours.filters.colours = ['off-white'];
    expect(QueryDSL.safeParse(colours).success).toBe(false);
  });

  it('bounds the row limit', () => {
    for (const limit of [0, -1, MAX_QUERY_LIMIT + 1, 1e6, 1.5]) {
      const dsl = valid() as { limit: unknown };
      dsl.limit = limit;
      expect(QueryDSL.safeParse(dsl).success, String(limit)).toBe(false);
    }
  });

  it('pins the version so a replayed DSL from another shape is refused', () => {
    const dsl = valid() as { version: unknown };
    dsl.version = QUERY_DSL_VERSION + 1;
    expect(QueryDSL.safeParse(dsl).success).toBe(false);
  });

  it('drops an empty name entry, and only an empty one', () => {
    // Measured: a local 7B writes `districts: [""]` to mean "no district constraint", because the
    // schema demands the property be present. There is one reading of that, and keeping it would
    // filter on `district = ''` — a phantom constraint that returns nothing and says nothing.
    const dsl = valid() as { filters: { place: Record<string, unknown> } };
    dsl.filters.place['districts'] = ['', '  ', 'Ahmedabad'];
    dsl.filters.place['cameraExternalIds'] = [''];
    const result = QueryDSL.safeParse(dsl);
    expect(result.success).toBe(true);
    expect(result.data?.filters.place.districts).toEqual(['Ahmedabad']);
    expect(result.data?.filters.place.cameraExternalIds).toEqual([]);
  });

  it('does not correct a name that is merely wrong', () => {
    // The line: an empty string is a non-value and is dropped; a wrong value is kept verbatim and
    // reported back to the officer as unrecognised. Correcting it would be guessing at intent.
    const dsl = valid() as { filters: { place: Record<string, unknown> } };
    dsl.filters.place['districts'] = ['Sector 18'];
    expect(QueryDSL.safeParse(dsl).data?.filters.place.districts).toEqual(['Sector 18']);
  });

  it('recognises the filter that constrains nothing', () => {
    expect(isUnconstrained(EMPTY_QUERY_DSL)).toBe(true);
    const narrowed = structuredClone(EMPTY_QUERY_DSL);
    narrowed.filters.colours = ['white'];
    expect(isUnconstrained(narrowed)).toBe(false);
  });

  it('describes a filter in clauses an officer can read back', () => {
    const dsl = structuredClone(EMPTY_QUERY_DSL);
    dsl.filters.plate = { pattern: 'GJ01AB1234', mode: 'fuzzy', maxDistance: 2 };
    dsl.filters.colours = ['white'];
    dsl.filters.classes = ['car'];
    dsl.filters.place.cameraExternalIds = ['cam05'];
    dsl.sequence = {
      place: { cameraExternalIds: [], districts: [], nearName: 'Adalaj', radius: null },
      withinMinutes: 120,
    };
    const lines = describeQueryDsl(dsl);
    expect(lines).toContain('registration within a weighted distance of 2 GJ01AB1234');
    expect(lines).toContain('colour is white');
    expect(lines).toContain('at camera cam05');
    expect(lines).toContain('then seen near "Adalaj" within 120 minutes');
  });
});

describe('queryDslJsonSchema — derived, never hand-maintained', () => {
  it('satisfies the strict subset every provider agrees on', () => {
    expect(() => assertStrictSubset(queryDslJsonSchema())).not.toThrow();
  });

  it('names every DSL property, so the derivation cannot drift from the zod schema', () => {
    const schema = queryDslJsonSchema() as {
      properties: Record<string, unknown>;
      required: string[];
    };
    const zodKeys = Object.keys(QueryDSL.shape).sort();
    expect(Object.keys(schema.properties).sort()).toEqual(zodKeys);
    // OpenAI's `strict: true` rejects a schema with any property missing from `required`.
    expect([...schema.required].sort()).toEqual(zodKeys);
  });

  it('demotes non-portable constraints into prose rather than dropping them', () => {
    // The plate pattern's regex is not a decode-time constraint on every provider, so it must still
    // reach the model as a description — a silently ignored keyword reads as protection and is not.
    const plate = (
      (queryDslJsonSchema() as { properties: { filters: { properties: Record<string, unknown> } } })
        .properties.filters.properties['plate'] as {
        anyOf: { properties?: Record<string, { description?: string }> }[];
      }
    ).anyOf[0];
    expect(plate?.properties?.['pattern']?.description).toContain('^[A-Z0-9?*]+$');
    expect(plate?.properties?.['maxDistance']?.description).toContain('at most 2');
  });

  it('contains no keyword outside the portable set', () => {
    const seen = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        seen.add(key);
        if (key === 'properties' || key === '$defs') {
          Object.values(value as Record<string, unknown>).forEach(walk);
        } else {
          walk(value);
        }
      }
    };
    walk(queryDslJsonSchema());
    const banned = ['minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'format'];
    for (const keyword of banned) expect([...seen]).not.toContain(keyword);
  });

  it('refuses an object that a provider would be free to extend', () => {
    expect(() =>
      assertStrictSubset({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      }),
    ).toThrow(StrictSchemaError);
  });

  it('refuses a schema with an optional property', () => {
    expect(() =>
      assertStrictSubset({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      }),
    ).toThrow(/not in `required`/);
  });

  it('errors rather than silently dropping a keyword it does not recognise', () => {
    expect(() => toPortableSchema({ type: 'string', ifMatchesThenDelete: true })).toThrow(
      StrictSchemaError,
    );
  });

  it('does not mutate its input', () => {
    const input = { type: 'string', minLength: 3 };
    const copy = structuredClone(input);
    toPortableSchema(input);
    expect(input).toEqual(copy);
  });
});
