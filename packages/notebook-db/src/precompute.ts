import type { ColumnSchema } from "@observablehq/notebook-kit/runtime";
import type { FilesApi } from "@statewalker/webrun-files";
import { dirname, joinPath, normalizePath, writeText } from "@statewalker/webrun-files";
import type { NotebookDbClient } from "./client.js";
import { normalizeRows } from "./rows.js";

/**
 * One SQL cell to run at build time: the page it lives on, the database it targets, the
 * tagged-template strings around each interpolation, and the interpolated values in order.
 */
export interface PrecomputeRequest {
  /**
   * Output path of the notebook PAGE this cell belongs to (`/reports/q3.html`), or the
   * directory it is served from (`/reports/`). REQUIRED, and deliberately not optional: the
   * cache file's location depends on it (see {@link cachePathFor}), and a defaulted value
   * would silently restore the root-only behaviour this field exists to remove.
   */
  notebook: string;
  database: string;
  strings: string[];
  params: unknown[];
}

// --- notebook-kit's own hashing, reimplemented ---------------------------------
//
// notebook-kit's `DatabaseClient.sql()` does not run SQL: it `fetch`es
// `.observable/cache/<nameHash>-<hash>.json` and expects a precomputed result there
// (verified by reading `runtime/stdlib/databaseClient.js` in the installed package). That
// string has NO leading slash, so the browser resolves it against the DOCUMENT'S DIRECTORY,
// not the site root — which is why `cachePathFor` needs the notebook's own page path.
// That path is computed by `hash`/`nameHash` in notebook-kit's `lib/hash.js`, which
// are NOT reachable through any exported entry point of `@observablehq/notebook-kit`
// (its package.json `exports` map lists only ".", "./databases", "./runtime", "./vite"
// and "./*.css" — none of them re-export `hash` or `nameHash`). So this module
// reimplements them, byte-for-byte, from the installed dist source. Equivalence is not
// asserted by inspection: `precompute.test.ts` resolves notebook-kit's own package entry
// at test time, imports its (un-exported) `databaseClient.js` module directly by URL, and
// pins this implementation's output against the REAL `DatabaseClientImpl.cachePath` for
// both the common case and the case that forces `nameHash`'s sluggify branch.

async function sha256ToBigInt(input: string): Promise<bigint> {
  const encoded = new TextEncoder().encode(input);
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(buffer).reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
}

function base36(value: bigint, length: number): string {
  return value.toString(36).padStart(length, "0").slice(0, length);
}

/**
 * The hash notebook-kit's client computes from a tagged-template query. Hashes
 * `JSON.stringify([strings, ...params])` — never a concatenation of the two, which would
 * let `["SELECT ", ""]` + `["x"]` (a bound parameter) collide with `["SELECT 'x'"]` (the
 * same text as a literal): the array form keeps the strings/params split intact inside
 * the hashed value instead of erasing it.
 */
async function hash(strings: readonly string[], params: readonly unknown[]): Promise<string> {
  return base36(await sha256ToBigInt(JSON.stringify([strings, ...params])), 16);
}

function basename(name: string): string {
  return name.replace(/^.*\//, "");
}

interface SluggifyOptions {
  length?: number;
  fallback?: string;
  separator?: string;
}

function nonempty(part: string): boolean {
  return part.length > 0;
}

/** Verbatim port of notebook-kit's `lib/sluggify.js`. */
function sluggify(
  input: string,
  { length = 50, fallback = "untitled", separator = "-" }: SluggifyOptions = {},
): string {
  const parts = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f'‘’]/g, "")
    .toLowerCase()
    .split(/\W+/g)
    .filter(nonempty);
  let i = -1;
  for (let l = 0, n = parts.length; ++i < n; ) {
    const part = parts[i] ?? "";
    l += part.length;
    if (l + i > length) {
      parts[i] = part.substring(0, length - l + part.length - i);
      break;
    }
  }
  return (
    parts
      .slice(0, i + 1)
      .filter(Boolean)
      .join(separator) || fallback.slice(0, length)
  );
}

/** The database-name half of the cache path. */
async function nameHash(name: string): Promise<string> {
  return /^[\w-]+$/.test(name)
    ? name
    : `${sluggify(basename(name))}.${base36(await sha256ToBigInt(name), 8)}`;
}

/**
 * What notebook-kit's `DatabaseClientImpl.cachePath` returns, byte for byte: a PAGE-RELATIVE
 * path with NO leading slash. That missing slash is the whole point — the browser resolves it
 * against the document's own directory, so the same string means `/.observable/...` on a page at
 * `/index.html` and `/reports/.observable/...` on a page at `/reports/q3.html`. Verified against
 * the installed package by `precompute.test.ts`, which imports the real (un-exported)
 * `databaseClient.js` and compares.
 */
async function relativeCachePath(
  database: string,
  strings: string[],
  params: unknown[],
): Promise<string> {
  return `.observable/cache/${await nameHash(database)}-${await hash(strings, params)}.json`;
}

/**
 * The directory a page's relative URLs resolve against. `/reports/q3.html` -> `/reports`;
 * `/reports/` (a directory request that `notebook-site` answers with `directoryIndex`) ->
 * `/reports`, NOT its parent.
 *
 * A `..` segment is refused rather than resolved: the result is used verbatim as an output
 * path, and on any backend that maps paths onto a real filesystem a surviving `..` writes
 * outside the output root.
 */
function pageDirectory(notebook: string): string {
  if (normalizePath(notebook).split("/").includes("..")) {
    throw new Error(
      `cachePathFor: notebook path "${notebook}" contains a ".." segment; ` +
        "the cache path is used as an output path and must stay inside the site root",
    );
  }
  return notebook.endsWith("/") ? normalizePath(notebook) : dirname(notebook);
}

/**
 * The absolute site path at which a notebook's precomputed result must be written so that the
 * page at `notebook` finds it.
 *
 * `notebook` is load-bearing and cannot be dropped: `DatabaseClient.sql()` fetches a relative
 * URL, so the location is a property of the PAGE, not of the query alone. Two notebooks at
 * different depths running the same query therefore need two files (`precomputeQueries` writes
 * copies), because a static export has no way to redirect one page's fetch at another's file.
 */
export async function cachePathFor(
  notebook: string,
  database: string,
  strings: string[],
  params: unknown[],
): Promise<string> {
  return joinPath(pageDirectory(notebook), await relativeCachePath(database, strings, params));
}

// --- the revival directive ------------------------------------------------------------------
//
// notebook-kit's `DatabaseClient.sql()` is `fetch(path).then(r => r.json()).then(revive)`, and
// `revive` (in the installed `runtime/stdlib/databaseClient.js`) starts with
//
//     function revive({rows, schema, date, ...meta}) { for (const column of schema) ... }
//
// so a bare `[...]` array throws `TypeError: schema is not iterable` on EVERY precomputed SQL
// cell. The cache file must be the `{rows, schema}` envelope, which makes `schema` a field this
// module has to produce.
//
// READ THIS BEFORE TRUSTING THE FIELD: what we emit is NOT SQL column-type metadata. This
// package sits on `@statewalker/db-api`, which reports no SQL types, so we have none to report.
// What we emit is a REVIVAL DIRECTIVE: a statement about which values need reconstructing after
// a JSON round trip. That is legitimate to derive here because it is fully determined by the
// JavaScript values we are about to serialize — it is an observation about our own output, not
// a guess about the database. Anyone who later wants real SQL types must plumb them out of the
// driver (`@statewalker/db-duckdb-browser`) and must not read them out of this field.
//
// What makes the directive reading sound: `revive`'s `switch (column.type)` has exactly two
// cases, `"bigint"` and `"date"`. Every other type falls straight through and no value is
// touched. So a type we emit either triggers a documented reconstruction or is inert; it can
// never make `revive` do something we did not intend.
//
// "bigint" is one we never emit, and the reason is worth stating so nobody "fixes" it back in:
// `normalizeRows` has already run over these rows (the adapter does it, and the call below does
// it again defensively), so by serialization time every `bigint` is a `number` — or the pass
// threw, for a value a JSON number could not hold exactly. Marking such a column `"bigint"`
// would be false; the values are numbers. It is also pointless: `revive`'s `bigint` branch does
// `row[name] = Number(value)`, which is precisely what `normalizeRows` already did, so for this
// package's output that branch is unreachable AND a no-op. The conversion happens once, before
// serialization, where an out-of-range value can still be refused loudly.

/**
 * The type tag for ONE value, or `undefined` for "no evidence" (null/undefined), which
 * contributes nothing to the column's verdict.
 *
 * A `bigint` cannot reach here — `normalizeRows` runs first — and if one ever did,
 * `JSON.stringify` would throw before any schema we wrote could be read, so it falls to
 * `"other"` with the rest rather than earning a case that would be a lie.
 */
function columnTypeOf(value: unknown): ColumnSchema["type"] | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "other";
  }
}

/**
 * Derives the revival directive from the rows themselves, scanning EVERY row per column rather
 * than sampling the first.
 *
 * Three cases the first row cannot answer, and the ruling on each:
 *
 *  * **first row null** — a `Date` column whose first row is NULL is still a `Date` column.
 *    Sampling row 0 would mark it `"other"` and the precomputed page would show a string where
 *    the live page shows a `Date`. Every row is scanned, so the first non-null value decides.
 *  * **every row null** — there is no value to reconstruct, so there is nothing for `revive` to
 *    do and any type would be equally correct at runtime. We emit `"other"`, which is the
 *    union's own name for "unclassified" and is inert in `revive`'s switch. Emitting a guess
 *    like `"string"` would be the one thing this comment says we do not do: a claim about a
 *    column we observed nothing about.
 *  * **heterogeneous** — `revive` marks a COLUMN, not a value, so a column holding both a
 *    `Date` and a `"hello"` has no marking that is right for both: `"date"` turns `"hello"`
 *    into `Invalid Date`. The rule is therefore unanimity — a column is `"date"` only if EVERY
 *    non-null value is a `Date` — and a mixed column is `"other"`, leaving each value exactly as
 *    JSON delivered it. That is a real limitation of the cache format, not of this function: a
 *    mixed column's `Date` values do arrive as strings, and the only cure is a per-value
 *    encoding notebook-kit does not read. db-api rows come from typed SQL columns, so this is a
 *    hand-rolled-client corner rather than something a notebook author meets.
 *
 * Column ORDER is first-seen across all rows, and the key set is the union rather than row 0's
 * keys — a column absent from the first row still needs its directive.
 */
function deriveSchema(rows: unknown[]): ColumnSchema[] {
  const verdicts = new Map<string, ColumnSchema["type"] | undefined>();
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    for (const [name, value] of Object.entries(row as Record<string, unknown>)) {
      const observed = columnTypeOf(value);
      if (!verdicts.has(name)) {
        verdicts.set(name, observed);
        continue;
      }
      if (observed === undefined) continue; // no evidence: never overrides a verdict
      const current = verdicts.get(name);
      // `undefined` here means "only nulls so far", so the first real value simply fills it in.
      if (current === undefined) verdicts.set(name, observed);
      else if (current !== observed) verdicts.set(name, "other"); // disagreement -> unanimity lost
    }
  }
  return [...verdicts].map(([name, type]) => ({ name, type: type ?? "other" }));
}

/**
 * Runs every request against its named database and writes the rows as JSON at the path
 * notebook-kit's client will fetch at that request's page load.
 *
 * Two levels of collapsing, and they are not the same level:
 *
 *  * by QUERY (database + strings + params): the database is hit once, however many pages ask
 *    for it. That is the expensive half.
 *  * by PATH (query + the page's directory): the file is written once. Two pages in DIFFERENT
 *    directories sharing a query get two files holding identical bytes — copies, not one shared
 *    file — because `DatabaseClient.sql()` fetches a page-relative URL and a static export has
 *    no redirect to fold them together. The cost is duplicated bytes, bounded by the number of
 *    distinct directories that run the query.
 *
 * `written` has one entry per request, in order, with duplicates repeating the same path.
 */
export async function precomputeQueries(
  requests: PrecomputeRequest[],
  databases: Map<string, NotebookDbClient>,
  output: FilesApi,
): Promise<string[]> {
  const serializedByQuery = new Map<string, string>();
  const alreadyWritten = new Set<string>();
  const written: string[] = [];
  for (const request of requests) {
    const client = databases.get(request.database);
    if (!client) {
      throw new Error(
        `precomputeQueries: no database configured for "${request.database}" ` +
          `(query: ${request.strings.join("?")})`,
      );
    }
    // Already carries `nameHash(database)` and the hash of strings+params, so it identifies the
    // query across pages without a second composite key.
    const relative = await relativeCachePath(request.database, request.strings, request.params);
    let json = serializedByQuery.get(relative);
    if (json === undefined) {
      const rows = await client.sql(
        request.strings as unknown as TemplateStringsArray,
        ...request.params,
      );
      // `newDbClient` already did this, and the pass is idempotent — but `databases` is typed
      // as the `NotebookDbClient` INTERFACE, so a caller's own implementation can hand back a
      // raw `bigint` and `JSON.stringify` would throw "Do not know how to serialize a BigInt",
      // naming neither the cell nor the query.
      //
      // The defence covers OBJECT rows only, and deliberately. `normalizeRows` converts a row
      // only when `isPlainObject(row)`, so a client returning TUPLE rows (`[[1n, 2n]]`) passes
      // through untouched and `JSON.stringify` below still throws that bare BigInt message.
      // Verified by running the real predicate against `[[1n, 2n]]`: the row comes back
      // identical and the stringify throws. Closing that hole would not help, it would hurt:
      // `deriveSchema` skips array rows by the same test, so a tuple result serializes with an
      // EMPTY schema, and notebook-kit's `revive` iterates that schema — the page would render
      // unrevived tuples instead of failing. A loud throw at build time is the better outcome
      // until tuple rows are a shape this package actually supports end to end.
      const normalized = normalizeRows(rows);
      // `{rows, schema}`, never a bare array: notebook-kit's `revive` destructures this object
      // and iterates `schema`, so an array throws `TypeError: schema is not iterable` in the
      // page. The schema is derived from `normalized` — AFTER the bigint pass — so it describes
      // the values actually being serialized. See "the revival directive" above for what the
      // field does and does not claim.
      json = JSON.stringify({ rows: normalized, schema: deriveSchema(normalized) });
      serializedByQuery.set(relative, json);
    }
    const path = joinPath(pageDirectory(request.notebook), relative);
    if (!alreadyWritten.has(path)) {
      await writeText(output, path, json);
      alreadyWritten.add(path);
    }
    written.push(path);
  }
  return written;
}
