// NOT a module: read as raw TEXT by duckdb.browser.test.ts and handed to `page.evaluate` as a
// source string. If this were `import()`ed (or even just parsed as part of a `.ts` test file),
// Vitest's SSR transform rewrites every `await import(...)` in the file into a
// `__vite_ssr_dynamic_import__(...)` call meant for Node's module graph — which does not exist
// in the browser page this code actually runs in, and the two dynamic imports below need to run
// as literal browser-side imports against the fixture server's import map. Keeping this file
// outside Vitest's transform pipeline (read as text, never imported) is what keeps them literal.
//
// Self-invoking, reading `window.__bundles` rather than a `page.evaluate` argument: passing a
// STRING to `page.evaluate` evaluates it as a bare expression — an arg would bind to nothing,
// and the arrow function's own value (not its result) is what comes back. `duckdb.browser.test.ts`
// stashes `bundles` on `window` first, with a plain (import-free) closure vitest's transform
// cannot touch.
(async () => {
  const { newBrowserDuckDb } = await import("@statewalker/db-duckdb-browser");
  const { newDbClient } = window.__notebookDb;
  const db = await newBrowserDuckDb({ bundles: window.__bundles });
  const client = newDbClient(db);
  await client.query("CREATE TABLE t AS SELECT * FROM (VALUES (1,'a'),(2,'b')) AS v(n, s)");
  const out = await client.sql`SELECT n, s FROM t WHERE n > ${1} ORDER BY n`;
  await client.close();
  return out;
})();
