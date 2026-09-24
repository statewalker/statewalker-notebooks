/**
 * BIGINT -> `number`, and nothing else.
 *
 * Why this module exists: DuckDB answers `count(*)`, an integer `sum()` and any BIGINT column
 * with a JavaScript `bigint` (measured against a real engine in
 * `test-browser/duckdb.browser.test.ts`). A `bigint` is hostile in both directions this package
 * feeds:
 *
 *  * build time — `JSON.stringify` THROWS `TypeError: Do not know how to serialize a BigInt`,
 *    naming neither the cell nor the query, so the most ordinary SQL cell there is takes the
 *    whole build down;
 *  * run time — notebook-kit's renderer receives a type its display paths do not expect, and
 *    arithmetic in a downstream cell throws `Cannot mix BigInt and other types`.
 *
 * Why NUMBER and not string: notebook-kit itself does exactly this. Its
 * `DatabaseClient.revive` walks the result schema and runs `row[name] = Number(value)` for
 * every `"bigint"` column. A string would make `count(*)` render as `"3"` and make
 * `rows[0].c + 1` produce `"31"`. Number keeps the PRECOMPUTED and LIVE results identical —
 * the same thing a notebook author sees either way — which is the property this package exists
 * to preserve.
 *
 * Why the lossy range THROWS: a double holds every integer up to 2^53-1 exactly and no integer
 * above it. `Number(9007199254740993n)` is `9007199254740992` — off by one, with nothing in the
 * output to say so. Silently writing that into a cache file is the worst available option, so
 * the conversion refuses and names the column, the exact value, and the value it would have
 * become. A notebook that genuinely carries such values says so in SQL (`CAST(x AS VARCHAR)`),
 * which is a visible decision by its author rather than an invisible one here.
 *
 * Idempotent: a second pass over already-converted rows finds no `bigint` and changes nothing,
 * which is what lets `newDbClient` and `precomputeQueries` both apply it without coordinating.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

function numberFromBigInt(value: bigint, column: string): number {
  if (value > MAX_SAFE || value < MIN_SAFE) {
    throw new Error(
      `cannot represent BIGINT column "${column}" as a JSON number: ${value} is outside ` +
        `Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}) and would become ` +
        `${Number(value)}. Cast it in SQL (for example \`CAST("${column}" AS VARCHAR)\`) ` +
        "to keep the exact value.",
    );
  }
  return Number(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recurses into arrays and plain objects, because DuckDB LIST and STRUCT columns nest and a
 * `bigint` one level down breaks `JSON.stringify` exactly as a top-level one does. Anything
 * carrying a prototype of its own (`Date`, `Uint8Array`, a `Map`) is returned untouched:
 * rewriting those would be a different and much larger promise than "BIGINT becomes a number".
 *
 * Returns the value IDENTICALLY (`===`) when nothing below it changed, which is what lets the
 * callers below skip rebuilding rows in the overwhelmingly common bigint-free case.
 */
function convert(value: unknown, column: string): unknown {
  if (typeof value === "bigint") return numberFromBigInt(value, column);
  if (Array.isArray(value)) {
    const items = value.map((item) => convert(item, column));
    return items.some((item, i) => item !== value[i]) ? items : value;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    // `column` is "" for the row object itself, so a top-level column is named by its own key
    // ("id") and a nested one by its path ("meta.total") — never ".id".
    const converted = entries.map(([key, item]) => [
      key,
      convert(item, column ? `${column}.${key}` : key),
    ]);
    return converted.some(([, item], i) => item !== entries[i]?.[1])
      ? Object.fromEntries(converted)
      : value;
  }
  return value;
}

/** Applies the conversion to every column of every row. */
export function normalizeRows<T>(rows: T[]): T[] {
  const out = rows.map((row) => (isPlainObject(row) ? (convert(row, "") as T) : row));
  return out.some((row, i) => row !== rows[i]) ? out : rows;
}
