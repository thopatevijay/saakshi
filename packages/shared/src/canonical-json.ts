/**
 * Canonical JSON — one byte sequence per value, whoever serialises it and whenever.
 *
 * This is the whole integrity guarantee of the audit chain (D3-04). A hash is only evidence if two
 * people who disagree about what happened can compute it independently and get the same answer, so
 * the serialisation has to be pinned down rather than left to `JSON.stringify`, which preserves
 * **insertion order**.
 *
 * That is not a theoretical concern here. `audit_log.params` is `jsonb`, and Postgres stores jsonb
 * with its own key order (length, then bytewise) — so an entry hashed at write time from the
 * object the route built, and re-hashed at verification time from the row Postgres handed back,
 * are hashing two different strings for the same data. Under `JSON.stringify` every entry with a
 * multi-key `params` would fail verification, and it would fail looking exactly like tampering.
 *
 * The rules, in full, because a verifier written by someone else has to be able to reproduce them:
 *
 * 1. **Object keys are sorted** by UTF-16 code unit (JavaScript's default string comparison), and
 *    properties whose value is `undefined` are omitted — matching `JSON.stringify`, so a canonical
 *    document is always parseable by a plain `JSON.parse`.
 * 2. **Numbers** use JavaScript's shortest round-tripping representation (`String(n)`), with `-0`
 *    normalised to `0`. `NaN` and `±Infinity` throw rather than silently becoming `null`: an audit
 *    entry containing one is a bug at the call site, and turning it into `null` would hide it.
 * 3. **Dates** serialise as `toISOString()` — UTC, always three fractional digits.
 * 4. **`undefined`, functions and symbols inside an array** become `null`, again matching
 *    `JSON.stringify`, so array length is preserved.
 * 5. **`bigint` throws.** There is no agreed JSON encoding for it, so picking one silently would
 *    make this file the only place that knows.
 * 6. **Cycles throw** rather than recursing forever.
 *
 * `toJSON()` is deliberately **not** honoured except on `Date`. An object that can rewrite itself
 * on the way into the hash is an object that can be made to hash differently without its visible
 * fields changing.
 */

/** Thrown for input that has no defined canonical form. The message names the path. */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function canonicalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(`${path}: ${String(value)} has no canonical JSON form`);
  }
  // `Object.is(-0, 0)` is false, and `String(-0)` is "0" already — but `-0` reaching a hash at all
  // is worth normalising explicitly so the intent is on the page rather than in a coincidence.
  return Object.is(value, -0) ? '0' : String(value);
}

function write(
  value: unknown,
  indent: number,
  depth: number,
  path: string,
  seen: Set<object>,
): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return canonicalNumber(value, path);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new CanonicalJsonError(`${path}: bigint has no canonical JSON form — convert it first`);
    case 'undefined':
    case 'function':
    case 'symbol':
      // Only reachable from an array element or the top level; object properties are filtered out
      // before they get here.
      return 'null';
    default:
      break;
  }

  const object: object = value;
  if (seen.has(object)) throw new CanonicalJsonError(`${path}: circular reference`);

  if (object instanceof Date) {
    const time = object.getTime();
    if (Number.isNaN(time)) throw new CanonicalJsonError(`${path}: Invalid Date`);
    return JSON.stringify(object.toISOString());
  }

  seen.add(object);
  try {
    const pad = indent === 0 ? '' : '\n' + ' '.repeat(indent * (depth + 1));
    const closePad = indent === 0 ? '' : '\n' + ' '.repeat(indent * depth);
    const colon = indent === 0 ? ':' : ': ';

    if (Array.isArray(object)) {
      if (object.length === 0) return '[]';
      const parts = object.map((item, index) =>
        write(item, indent, depth + 1, `${path}[${index}]`, seen),
      );
      return `[${pad}${parts.join(`,${pad}`)}${closePad}]`;
    }

    const entries = Object.keys(object as Record<string, unknown>)
      .sort()
      .flatMap((key) => {
        const item = (object as Record<string, unknown>)[key];
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') return [];
        return [
          `${JSON.stringify(key)}${colon}${write(item, indent, depth + 1, `${path}.${key}`, seen)}`,
        ];
      });

    if (entries.length === 0) return '{}';
    return `{${pad}${entries.join(`,${pad}`)}${closePad}}`;
  } finally {
    seen.delete(object);
  }
}

/**
 * The canonical, compact serialisation. This is what gets hashed.
 *
 * Byte-for-byte reproducible from the parsed value alone, which is what lets a verifier that has
 * only the database row recompute the same digest the writer computed from the in-memory object.
 */
export function canonicalJson(value: unknown): string {
  return write(value, 0, 0, '$', new Set());
}

/**
 * The same document, indented two spaces — same key order, same number and date formats, so it is
 * just as reproducible.
 *
 * An export bundle's `manifest.json` is written in this form: a human has to be able to read the
 * manifest they are being asked to trust, and hashing the file's own bytes means the bundle's
 * verifier needs no JSON canonicaliser of its own.
 */
export function canonicalJsonPretty(value: unknown): string {
  return write(value, 2, 0, '$', new Set());
}
