// NOT a module — see the header comment in `run-query.page.js` for why this is read as raw
// text rather than imported, and why it is a self-invoking expression reading
// `window.__bundles` rather than a `page.evaluate` argument.
(async () => {
  const { newBrowserDuckDb } = await import("@statewalker/db-duckdb-browser");
  const { newDbClient } = window.__notebookDb;
  const db = await newBrowserDuckDb({ bundles: window.__bundles });
  const client = newDbClient(db);
  await client.query("CREATE TABLE t AS SELECT * FROM (VALUES ('safe')) AS v(s)");
  const out = await client.sql`SELECT * FROM t WHERE s = ${"'; DROP TABLE t; --"}`;
  // DuckDB's count(*) is BIGINT; cast down so the assertion is a plain JS number rather than
  // asserting on a `bigint`/`number` distinction this test has no interest in.
  const still = await client.query("SELECT count(*)::INTEGER AS c FROM t");
  await client.close();
  return { matched: out.length, tableRows: still };
})();
