// Every unit test in this package uses a fake `Db`; this is the only one that runs the
// adapter against a real engine. `@statewalker/db-duckdb-browser` is served through a real
// `@statewalker/webrun-modules` server (see `server.ts`), self-hosting `@duckdb/duckdb-wasm`'s
// `mvp`/`eh` bundles rather than reaching jsDelivr, so the run is hermetic — no dependency on
// CDN network access — at the cost of paying for the download+transform of duckdb-wasm's own
// graph on a cold module cache (measured cold/warm timings are in the task report).
//
// The two page scripts below live in `fixture/*.page.js` and are read as plain TEXT, not
// imported — see the comment in `fixture/run-query.page.js` for why: Vitest's own transform
// rewrites a file's `await import(...)` calls for its Node-side module graph, and that rewrite
// would otherwise land inside code this file only ever *ships* into a real browser page via
// `page.evaluate`, breaking the two dynamic imports the moment they actually run there.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DuckDbBundles, type FixtureServer, startFixtureServer } from "./server.js";

const PORT = 8794;
const here = dirname(fileURLToPath(import.meta.url));

let browser: Browser;
let fixture: FixtureServer;
let page: Page;
let runQueryScript: string;
let injectionGuardScript: string;
let bigintScript: string;

beforeAll(async () => {
  [fixture, runQueryScript, injectionGuardScript, bigintScript] = await Promise.all([
    startFixtureServer(PORT),
    readFile(join(here, "fixture", "run-query.page.js"), "utf8"),
    readFile(join(here, "fixture", "injection-guard.page.js"), "utf8"),
    readFile(join(here, "fixture", "bigint.page.js"), "utf8"),
  ]);
  browser = await chromium.launch();
  page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  await page.goto(fixture.origin, { waitUntil: "load" });
  if (errors.length > 0) {
    throw new Error(`fixture page failed to load:\n${errors.join("\n")}`);
  }
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await fixture?.stop();
});

/** Stashes `bundles` where the raw-text page scripts read it (`window.__bundles`). A plain
 *  closure with no `import()` in it — safe for vitest's transform, unlike the scripts. */
async function setBundles(bundles: DuckDbBundles): Promise<void> {
  await page.evaluate((b) => {
    (window as unknown as { __bundles: DuckDbBundles }).__bundles = b;
  }, bundles);
}

describe("live SQL against DuckDB-WASM", () => {
  it("runs a query through the adapter and returns typed rows", async () => {
    await setBundles(fixture.bundles);
    const rows = await page.evaluate<Array<{ n: number; s: string }>>(runQueryScript);
    expect(rows).toEqual([{ n: 2, s: "b" }]);
  }, 120_000);

  // (1) the injection guard, proved against a real engine rather than a spy
  it("binds a SQL metacharacter as a value, not as syntax", async () => {
    await setBundles(fixture.bundles);
    const result = await page.evaluate<{ matched: number; tableRows: Array<{ c: number }> }>(
      injectionGuardScript,
    );
    expect(result.matched).toBe(0);
    expect(result.tableRows[0]?.c).toBe(1); // the table survived
  }, 120_000);

  // (2) BIGINT, the defect a `::INTEGER` cast in the injection fixture used to hide.
  it("turns a real BIGINT column into a JSON-serializable number", async () => {
    await setBundles(fixture.bundles);
    const r = await page.evaluate<{
      rawType: string;
      type: string;
      value: unknown;
      json: string;
      overflow: string;
    }>(bigintScript);

    // The premise: without this, "the adapter returns a number" would be vacuously true.
    expect(r.rawType).toBe("bigint");
    // The fix: the adapter converts, and the result survives JSON.stringify — which is what
    // the precompute stage does to it, and which THROWS on a bigint.
    expect(r.type).toBe("number");
    expect(r.value).toBe(3);
    expect(r.json).toBe('[{"c":3}]');
    // And the range a double cannot hold is an error naming the column, not a rounded value.
    expect(r.overflow).toMatch(/"id".*9007199254740993/s);
  }, 120_000);
});
