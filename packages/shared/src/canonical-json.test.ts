/**
 * The canonical serialisation is the integrity guarantee of the audit chain (D3-04), so the two
 * properties that matter are tested as properties rather than as examples:
 *
 * 1. **Key insertion order cannot change the output.** This is the one that bites in production —
 *    `params` goes into `jsonb`, and Postgres hands it back in its own key order.
 * 2. **A different process gets the same bytes.** A hash nobody else can reproduce is not evidence.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson, canonicalJsonPretty } from './canonical-json.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A deterministic shuffle, so a failure is reproducible from the seed in the message. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** Rebuilds an object with its keys inserted in a different order, recursively. */
function reinsert(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map((item, i) => reinsert(item, seed + i + 1));
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of shuffle(Object.keys(source), seed)) out[key] = reinsert(source[key], seed + 7);
  return out;
}

const ENTRY = {
  prevHash: 'genesis',
  ts: '2026-09-05T09:00:00.000Z',
  actorId: 'a3f1c0de-0000-4000-8000-000000000001',
  action: 'trace.run',
  targetType: 'vehicle',
  targetId: 'GJ01AB1234',
  purpose: 'FIR follow-up: vehicle movement reconstruction',
  caseRef: 'FIR/2026/00123',
  resultCount: 6,
  params: {
    plate: 'GJ01AB1234',
    minConfidence: 0.25,
    maxDistance: 2,
    cameraIds: ['cam01', 'cam04', 'cam07'],
    window: { from: '2026-09-05T08:00:00.000Z', to: '2026-09-05T12:00:00.000Z' },
    flags: { includeInferred: true, redacted: false },
  },
} as const;

describe('canonicalJson', () => {
  it('is identical across 200 key insertion orders of the same entry', () => {
    const expected = canonicalJson(ENTRY);
    for (let seed = 1; seed <= 200; seed++) {
      expect(canonicalJson(reinsert(ENTRY, seed)), `seed ${seed}`).toBe(expected);
    }
  });

  it('is identical when a separate node process serialises the same parsed value', () => {
    const expected = canonicalJson(ENTRY);
    const module = path.join(HERE, 'canonical-json.ts');
    // The child re-parses the JSON text, so it never sees this process's key order — it sees only
    // whatever order `JSON.parse` happens to produce, which is exactly the situation a verifier
    // reading a database row is in.
    const script = [
      `const { canonicalJson } = await import(${JSON.stringify(module)});`,
      `const value = JSON.parse(process.argv[1]);`,
      `process.stdout.write(canonicalJson(value));`,
    ].join('\n');
    const shuffled = JSON.stringify(reinsert(ENTRY, 4242));
    const out = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--input-type=module',
        '-e',
        script,
        shuffled,
      ],
      { encoding: 'utf8' },
    );
    expect(out).toBe(expected);
    expect(createHash('sha256').update(out).digest('hex')).toBe(
      createHash('sha256').update(expected).digest('hex'),
    );
  });

  it('survives a round trip through JSON.parse unchanged', () => {
    const once = canonicalJson(ENTRY);
    expect(canonicalJson(JSON.parse(once))).toBe(once);
    expect(canonicalJson(JSON.parse(canonicalJsonPretty(ENTRY)))).toBe(once);
  });

  it('sorts keys by UTF-16 code unit and omits undefined properties', () => {
    expect(canonicalJson({ b: 1, A: 2, a: 3, '': 4 })).toBe('{"":4,"A":2,"a":3,"b":1}');
    expect(canonicalJson({ kept: 1, dropped: undefined })).toBe('{"kept":1}');
  });

  it('keeps array positions, including holes', () => {
    expect(canonicalJson([1, undefined, null, 'x'])).toBe('[1,null,null,"x"]');
  });

  it('normalises -0 and formats dates as UTC ISO 8601', () => {
    expect(canonicalJson({ z: -0 })).toBe('{"z":0}');
    expect(canonicalJson(new Date(Date.UTC(2026, 8, 5, 9, 0, 0)))).toBe(
      '"2026-09-05T09:00:00.000Z"',
    );
  });

  it('refuses input with no defined canonical form rather than guessing one', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/no canonical JSON form/);
    expect(() => canonicalJson({ n: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson({ d: new Date('nope') })).toThrow(/Invalid Date/);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/circular/);
  });

  it('names the path of the offending value', () => {
    expect(() => canonicalJson({ params: { list: [1, Number.NaN] } })).toThrow(
      '$.params.list[1]: NaN has no canonical JSON form',
    );
  });

  it('pretty form has the same key order and parses to the same value', () => {
    const pretty = canonicalJsonPretty(ENTRY);
    expect(pretty).toContain('\n  "action": "trace.run",');
    expect(JSON.parse(pretty)).toEqual(JSON.parse(canonicalJson(ENTRY)));
  });
});
