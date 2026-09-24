// NOT a module — see the header comment in `run-query.page.js` for why this is read as raw
// text rather than imported, and why it is a self-invoking expression reading
// `window.__bundles` rather than a `page.evaluate` argument.
//
// D2, against a real engine: DuckDB's `count(*)` and any BIGINT column come back from
// `arrowToObjects` as JavaScript `bigint`. `JSON.stringify` throws on one, and notebook-kit's
// renderer never sees one from its own client, so the adapter is what has to convert. This
// page reports the raw driver type alongside the adapter's, so a green result cannot come from
// DuckDB having quietly stopped producing bigints.
(async () => {
  const { newBrowserDuckDb } = await import("@statewalker/db-duckdb-browser");
  const { newDbClient } = window.__notebookDb;
  const db = await newBrowserDuckDb({ bundles: window.__bundles });
  const client = newDbClient(db);
  await client.query("CREATE TABLE t AS SELECT * FROM (VALUES (1),(2),(3)) AS v(n)");

  // What the DRIVER produces, straight from db-api, with no adapter in the way.
  const rawRows = await db.query("SELECT count(*) AS c FROM t");
  const rawType = typeof rawRows[0].c;

  // What the ADAPTER produces for the same query.
  const rows = await client.sql`SELECT count(*) AS c FROM t`;
  const type = typeof rows[0].c;
  const value = rows[0].c;
  const json = JSON.stringify(rows);

  // A BIGINT a double cannot hold exactly must be refused, not rounded.
  let overflow = null;
  try {
    await client.query("SELECT 9007199254740993::BIGINT AS id");
    overflow = "<<no error>>";
  } catch (error) {
    overflow = String(error?.message ?? error);
  }

  await client.close();
  return { rawType, type, value, json, overflow };
})();
