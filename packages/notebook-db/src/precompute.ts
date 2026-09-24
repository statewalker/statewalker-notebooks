import type { FilesApi } from "@statewalker/webrun-files";
import { dirname, joinPath, normalizePath, writeText } from "@statewalker/webrun-files";
import type { NotebookDbClient } from "./client.js";

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
      json = JSON.stringify(rows);
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
