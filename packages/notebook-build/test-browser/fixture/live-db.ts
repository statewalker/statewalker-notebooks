// The module a LIVE sql cell's notebook imports to get its `db` variable.
//
// It is bundled with esbuild (see `bundleLiveDb` in `build.browser.test.ts`) and written into
// the build's OUTPUT, so the page loads it from its own origin like any other file the static
// export ships. The notebook cell that imports it does so by absolute URL, which
// `resolveNotebook` deliberately leaves unpinned (`isNpmSpecifier` is false for a path) — that
// is the mechanism a hosted site would use for its own helper modules too.
//
// Everything below the fixture line is PRODUCTION code: `newLiveDatabases` is
// `@statewalker/notebook-db`'s registry and `newBrowserDuckDb` is the real DuckDB-WASM driver.
// The only fixture part is the table the database is seeded with.

import { newBrowserDuckDb } from "@statewalker/db-duckdb-browser";
import { newLiveDatabases } from "@statewalker/notebook-db";

/**
 * Same-origin DuckDB-WASM bundle URLs. These paths are a CONTRACT with the test, which copies
 * `@duckdb/duckdb-wasm`'s own `dist/` files to exactly them — nothing here may come from
 * jsDelivr, which is what `newBrowserDuckDb` falls back to when `bundles` is omitted and what
 * the page's off-origin assertion exists to catch.
 */
const BUNDLES = {
  mvp: {
    mainModule: "/_fixture/duckdb/duckdb-mvp.wasm",
    mainWorker: "/_fixture/duckdb/duckdb-browser-mvp.worker.js",
  },
  eh: {
    mainModule: "/_fixture/duckdb/duckdb-eh.wasm",
    mainWorker: "/_fixture/duckdb/duckdb-browser-eh.worker.js",
  },
};

const databases = newLiveDatabases({
  open: async () => {
    const db = await newBrowserDuckDb({ bundles: BUNDLES as never });
    // A BIGINT column on purpose: DuckDB's INTEGER-family literals come back as `bigint`, and
    // the adapter's `normalizeRows` is what keeps the live page showing the same value the
    // precomputed cache file does.
    await db.exec(
      "CREATE TABLE sales AS SELECT * FROM (VALUES ('north', 120), ('south', 340)) AS v(region, amount)",
    );
    return db;
  },
});

/** Resolves to a `NotebookDbClient`, which is exactly what `DatabaseClient.of` duck-types on. */
export function openDatabase(name: string) {
  return databases.get(name);
}
