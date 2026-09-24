import type { FilesApi } from "@statewalker/webrun-files";
import { writeText } from "@statewalker/webrun-files";
import type { NotebookDbClient } from "./client.js";

/**
 * One SQL cell to run at build time: the database it targets, the tagged-template
 * strings around each interpolation, and the interpolated values in order.
 */
export interface PrecomputeRequest {
  database: string;
  strings: string[];
  params: unknown[];
}

// --- notebook-kit's own hashing, reimplemented ---------------------------------
//
// notebook-kit's `DatabaseClient.sql()` does not run SQL: it `fetch`es
// `.observable/cache/<nameHash>-<hash>.json` and expects a precomputed result there
// (verified by reading `runtime/stdlib/databaseClient.js` in the installed package).
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
 * The path notebook-kit's `DatabaseClient.sql()` will `fetch` for this database, query
 * text and parameters. Must stay byte-identical to what the installed notebook-kit's own
 * `DatabaseClientImpl.cachePath` computes — see the module doc comment above.
 */
export async function cachePathFor(
  database: string,
  strings: string[],
  params: unknown[],
): Promise<string> {
  return `/.observable/cache/${await nameHash(database)}-${await hash(strings, params)}.json`;
}

/**
 * Runs every request against its named database and writes the rows as JSON at the path
 * notebook-kit's client will fetch at page load. Requests that share a database, query
 * text and parameters share a cache path and are written once (`written` may therefore be
 * shorter than `requests`, and always shorter than or equal to it, with duplicates
 * collapsed to the same entry rather than re-run).
 */
export async function precomputeQueries(
  requests: PrecomputeRequest[],
  databases: Map<string, NotebookDbClient>,
  output: FilesApi,
): Promise<string[]> {
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
    const path = await cachePathFor(request.database, request.strings, request.params);
    if (!alreadyWritten.has(path)) {
      const rows = await client.sql(
        request.strings as unknown as TemplateStringsArray,
        ...request.params,
      );
      await writeText(output, path, JSON.stringify(rows));
      alreadyWritten.add(path);
    }
    written.push(path);
  }
  return written;
}
