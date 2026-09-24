// Fixture page script, bundled by esbuild (see `../server.ts`) exactly the way
// `notebook-events/test-browser/fixture/main.ts` bundles its own page script: this package's
// source has one runtime import (`@statewalker/db-api`, and only for types, which the TS
// compiler erases), so bundling it pulls in nothing external — `newDbClient` is the ONLY
// production code under test here, wired to whatever `Db` the page hands it.
//
// `@statewalker/db-duckdb-browser` is deliberately NOT imported here. Bundling it would
// resolve it (and `@duckdb/duckdb-wasm`) through esbuild's own Node resolution, which proves
// nothing about the module server a real hosted notebook page loads it through. The browser
// test imports it itself, as a live `import()` against the URL `server.ts` put in the page's
// import map.
import { newDbClient } from "../../src/client.js";

(window as unknown as { __notebookDb: { newDbClient: typeof newDbClient } }).__notebookDb = {
  newDbClient,
};
