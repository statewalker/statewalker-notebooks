// The only test in this package that runs what it builds.
//
// Every other test here asserts about strings: a fake module server hands back invented URLs and
// the assertions compare text. That proves the stages agree with each other, not that the page
// they produce works. This one wires the real `newNotebookBuild` to a REAL
// `@statewalker/webrun-modules` server — npm registry, real tarballs, real transform — serves the
// emitted page over HTTP and loads it in a real Chromium, so resolve → transpile → render → link
// → execute is exercised end to end for the first time.
//
// Two builds of the same sources are checked, because they fail differently:
//   * hosted — modules come from the live module server at `/_m/`. Breaks if a pin is wrong.
//   * static — `materializeDeps` wrote the whole closure into the output, and the fixture server
//     is started with NO module server at all, so a single missing file is a 404 and a dead page.
//
// The module server's cache is on disk under `node_modules/.cache/`, so only the first run pays
// for downloading and transforming Plot's dependency graph — measured at ~14s cold against a warm
// npm CDN and ~6.5s warm, though the very first run on a cold machine took three minutes. The
// notebook build's own cache is in memory and therefore ALWAYS cold: a disk sidecar would let an
// incremental skip serve a page built by an earlier, possibly different, revision of this package.
//
// Two SQL notebooks were added here because both modes are otherwise asserted only against
// fakes and strings. `@statewalker/notebook-db` is reached through its `dist/`, not its source —
// its `exports` map has no condition vitest resolves to `src/` — so `test:browser` builds that
// package first. Running vitest directly against a stale `dist/` asserts about code that is not
// the code in the tree.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toNotebook } from "@observablehq/notebook-kit";
import { newDbClient, precomputeQueries } from "@statewalker/notebook-db";
import { type FilesApi, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { newModuleServer } from "@statewalker/webrun-modules";
import * as esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NotebookFailure, newNotebookBuild } from "../src/build.js";
import { serializeNotebook } from "../src/serialize.js";
import { type OutputServer, startOutputServer } from "./server.js";

const BASE_PATH = "/_m/";
const HOSTED_PORT = 8792;
const STATIC_PORT = 8793;

/**
 * notebook-kit's own stylesheet, at the URL the module server serves it from. A hosted site would
 * point `stylesUrl` here; a static export has to have copied it. See the note in `buildInto`.
 */
const STYLES_URL = `${BASE_PATH}@observablehq/notebook-kit@2.6.4/dist/src/styles/index.css`;

/**
 * Cell ids are 1-based, and the build round-trips the notebook through notebook-kit's
 * `serialize`/`deserialize` (the artifact in `cache` is the handoff between `[Notebook]` and
 * `[Page]`) without moving them — `src/serialize.test.ts` holds that fixed point. This test is
 * what originally exposed the divergence: `parseMarkdown` numbered from 0, `deserialize` treats a
 * non-positive id as absent and renumbered the whole document, and the plot turned up in `cell-4`
 * of a document whose cells had been parsed as 0..3. If that ever regresses, the hard-coded ids
 * below stop matching and this file goes red.
 *
 * Here: `# Chart` is prose (cell 1), then the import (2), the data (3) and the display (4).
 * Cell 4 is the only one that renders anything, which is what makes "the plot landed in its own
 * root" a real assertion rather than a count of `svg` elements anywhere on the page.
 */
const CHART_MD = [
  "# Chart",
  "",
  "```js",
  'import * as Plot from "npm:@observablehq/plot";',
  "```",
  "",
  "```js",
  "const data = Array.from({length: 12}, (_, i) => ({x: i, y: i * i}));",
  "```",
  "",
  "```js",
  'display(Plot.dot(data, {x: "x", y: "y"}).plot());',
  "```",
  "",
].join("\n");

/**
 * No prose, so the cells are 1/2/3. The middle one does not parse.
 * Cell 3 reads `ok` from cell 1 and displays `3`: if the broken cell had taken the graph
 * down with it, or if the build had stopped emitting definitions at the first failure, cell 3
 * would stay empty — and a test that only looked for the error message would still pass.
 */
const BROKEN_MD = [
  "```js",
  "const ok = 1;",
  "```",
  "",
  "```js",
  "const broken = ;",
  "```",
  "",
  "```js",
  "display(ok + 2);",
  "```",
  "",
].join("\n");

/**
 * SQL-cell fixtures. Both notebooks are notebook-kit HTML sources rather than Markdown,
 * because `parseMarkdown` has no syntax for a cell's `database` or `output` attributes and
 * those two attributes are the entire difference between the modes under test.
 *
 * PRECOMPUTED (`/reports/q3.html`) — `database="warehouse"` (no `var:` prefix) makes
 * notebook-kit's client `fetch` `.observable/cache/<nameHash>-<hash>.json` INSTEAD of running
 * any SQL. The notebook is NESTED on purpose: that fetch path is page-relative, so a notebook
 * at `/reports/q3.html` must find its cache at `/reports/.observable/cache/…`. Every other
 * fixture in this repo sits at the root, where a cache written to `/.observable/…` works by
 * accident — which is exactly how the wrong-path defect survived.
 *
 * LIVE (`/live.html`) — `database` defaults to `var:db`, so the cell compiles to
 * `DatabaseClient.of(db, "db").sql\`…\`` and runs against whatever the notebook's own `db`
 * variable is. Here that is a real DuckDB-WASM database, reached through
 * `@statewalker/notebook-db`'s live registry (see `fixture/live-db.ts`).
 */
const Q3_QUERY = "SELECT region, amount FROM sales ORDER BY amount DESC";

/** Rows the BUILD-time database returns; `bigint`, as a DuckDB integer column really is. */
const SALES = [
  { region: "south", amount: 340n },
  { region: "north", amount: 120n },
];

function nbHtml(cells: Parameters<typeof toNotebook>[0]["cells"], title: string): string {
  const { window } = new JSDOM("<!doctype html>");
  return serializeNotebook(toNotebook({ title, cells }), {
    document: window.document,
    parser: new window.DOMParser(),
  });
}

const Q3_HTML = nbHtml(
  [
    { id: 1, mode: "sql", value: Q3_QUERY, database: "warehouse", output: "revenue" },
    // Reads the sql cell BY NAME. This is the assertion that the singular `output` survived
    // transpile and render: without it the sql cell's variable is anonymous, this cell never
    // resolves, and it stays empty with no error anywhere on the page.
    {
      id: 2,
      mode: "js",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: notebook CELL SOURCE, not a JS template — the `${…}` must survive verbatim into the page.
      value: 'display(`precomputed:${revenue.map((r) => `${r.region}=${r.amount}`).join(",")}`);',
    },
  ],
  "Q3",
);

const LIVE_HTML = nbHtml(
  [
    {
      id: 1,
      mode: "js",
      value: [
        'import {openDatabase} from "/_fixture/live-db.js";',
        'const db = await openDatabase("warehouse");',
      ].join("\n"),
    },
    // `${200}` is an INTERPOLATION, so it becomes a bound parameter rather than SQL text. Only
    // `south` (340) clears it: a dropped or mis-bound parameter yields both rows or an error,
    // either of which fails the assertion below.
    {
      id: 2,
      mode: "sql",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: notebook CELL SOURCE, not a JS template — the `${…}` must survive verbatim into the page.
      value: "SELECT region, amount FROM sales WHERE amount > ${200} ORDER BY amount DESC",
      output: "live",
    },
    {
      id: 3,
      mode: "js",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: notebook CELL SOURCE, not a JS template — the `${…}` must survive verbatim into the page.
      value: 'display(`live:${live.map((r) => `${r.region}=${r.amount}`).join(",")}`);',
    },
  ],
  "Live",
);

/**
 * `display(aString)` is not displayable markup, so notebook-kit inspects it — and the
 * inspector renders a string as a JS string LITERAL, quotes included. Those quotes are the
 * inspector's, not the cell's; strip exactly one leading and trailing `"` so the assertion can
 * stay an equality on the value the notebook actually produced.
 */
function inspected(text: string | null): string {
  return (text ?? "").replace(/^"(.*)"$/s, "$1");
}

const here = dirname(fileURLToPath(import.meta.url));

/** `@duckdb/duckdb-wasm`'s own `dist/`, located through Node's resolver rather than guessed. */
const DUCKDB_DIST = dirname(fileURLToPath(import.meta.resolve("@duckdb/duckdb-wasm")));

/**
 * The same-origin DuckDB assets `fixture/live-db.ts` hard-codes URLs for. Served off disk
 * (see `extraFiles` in server.ts) because the two `.wasm` files are 75 MB together.
 */
const DUCKDB_FILES = new Map(
  [
    "duckdb-mvp.wasm",
    "duckdb-eh.wasm",
    "duckdb-browser-mvp.worker.js",
    "duckdb-browser-eh.worker.js",
  ].map((name) => [`/_fixture/duckdb/${name}`, join(DUCKDB_DIST, name)] as const),
);

/**
 * Bundles `fixture/live-db.ts` — and with it the REAL `@statewalker/notebook-db` registry and
 * the REAL `@statewalker/db-duckdb-browser` driver — into one same-origin ES module the
 * notebook imports by absolute URL.
 */
async function bundleLiveDb(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [join(here, "fixture", "live-db.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild produced no JS output for fixture/live-db.ts");
  return file.text;
}

/**
 * Writes the precomputed SQL result where the page at `/reports/q3.html` will fetch it, using
 * `@statewalker/notebook-db`'s real `precomputeQueries` — the same call a production build
 * makes, so the cache path, the `{rows, schema}` envelope and the bigint normalization are all
 * this repo's own output rather than a hand-written file shaped to match the assertion.
 */
async function writePrecomputedCache(output: FilesApi): Promise<string> {
  const warehouse = newDbClient({
    query: async () => SALES,
    exec: async () => {},
    close: async () => {},
  } as never);
  const written = await precomputeQueries(
    [{ notebook: "/reports/q3.html", database: "warehouse", strings: [Q3_QUERY], params: [] }],
    new Map([["warehouse", warehouse]]),
    output,
  );
  const path = written[0];
  if (path === undefined) throw new Error("precomputeQueries wrote nothing");
  return path;
}

/** Where the precomputed cache landed; asserted against what the browser actually requested. */
let cachePath: string;

let browser: Browser;
const servers: OutputServer[] = [];
const failures: NotebookFailure[] = [];

/**
 * A fresh source tree per build. `BuildEngine` keeps its scanner state INSIDE the notebooks
 * `FilesApi` (`/.notebook-build/`), so a second build over the same instance sees no changed
 * source and emits nothing at all — into a brand-new, empty `output`. That is the incremental
 * engine working as designed, and it is silent: no failure, no page, a 404 much later.
 */
async function newSources(): Promise<FilesApi> {
  const notebooks = new MemFilesApi();
  await writeText(notebooks, "/chart.md", CHART_MD);
  await writeText(notebooks, "/broken.md", BROKEN_MD);
  await writeText(notebooks, "/reports/q3.html", Q3_HTML);
  await writeText(notebooks, "/live.html", LIVE_HTML);
  return notebooks;
}

async function buildInto(moduleCache: FilesApi, mode: "hosted" | "static"): Promise<void> {
  const output = new MemFilesApi();
  const { window } = new JSDOM("<!doctype html>");
  const moduleServer = newModuleServer({ cache: moduleCache, basePath: BASE_PATH });
  await newNotebookBuild({
    notebooks: await newSources(),
    output,
    // Always cold: see the header. Sharing the module server's disk cache here would let a
    // previous run's hash sidecar skip the rebuild.
    cache: new MemFilesApi(),
    moduleServer,
    dom: { document: window.document, parser: new window.DOMParser() },
    mode,
    basePath: BASE_PATH,
    // Not cosmetic — it is what makes `materializeDeps`'s asset union falsifiable. The union
    // exists because `listResources` reports only JS-reachable modules, so a package's .css,
    // .wasm and fonts are absent from it (measured: @duckdb/duckdb-wasm 192 modules / 3 .wasm
    // missing, katex 1 module / 24 .woff2 missing). Without a stylesheet the page requests no
    // non-JS file at all, and deleting the entire union left all four of these tests GREEN —
    // the closure still contained 23 orphaned .css files that Chromium never asked for. Linking
    // notebook-kit's own stylesheet makes one of them load-bearing.
    stylesUrl: STYLES_URL,
    onFailed: (f) => failures.push(...f),
  }).build();

  // After the build, never before: these are not notebook sources and the build must not see
  // them. `/_fixture/live-db.js` is what `/live.html`'s first cell imports; the cache file is
  // what `/reports/q3.html`'s sql cell fetches.
  await writeText(output, "/_fixture/live-db.js", await bundleLiveDb());
  cachePath = await writePrecomputedCache(output);

  if (mode === "hosted") {
    servers.push(
      await startOutputServer({
        port: HOSTED_PORT,
        output,
        moduleServer,
        basePath: BASE_PATH,
        extraFiles: DUCKDB_FILES,
      }),
    );
  } else {
    // No module server: the static export must stand on its own files alone.
    servers.push(await startOutputServer({ port: STATIC_PORT, output, extraFiles: DUCKDB_FILES }));
  }
}

beforeAll(async () => {
  // Persisted across runs on purpose — downloading and transforming Plot's graph takes minutes.
  const cacheDir = join(here, "..", "node_modules", ".cache", "browser-test-modules");
  await mkdir(cacheDir, { recursive: true });
  const moduleCache = new NodeFilesApi({ rootDir: cacheDir });

  await buildInto(moduleCache, "hosted");
  await buildInto(moduleCache, "static");

  if (failures.length > 0) {
    throw new Error(
      `the build reported failures:\n${failures
        .map((f) => `${f.notebookPath}: ${String((f.error as Error)?.stack ?? f.error)}`)
        .join("\n")}`,
    );
  }

  browser = await chromium.launch();
}, 900_000);

afterAll(async () => {
  await browser?.close();
  for (const server of servers) await server.stop();
});

/**
 * Opens a page, recording everything that would otherwise vanish into the browser console.
 *
 * `pageerror` alone is NOT enough, and that was measured, not guessed: with a deliberately
 * mangled import pin the page was completely dead — Plot never loaded, nothing rendered — and
 * `pageerror` stayed EMPTY the whole time. notebook-kit's runtime catches a failed import and
 * reports it through `console.error` as a `RuntimeError`, so nothing ever reaches the window's
 * error handler. The 404 and the failed request are the only unambiguous signals, so all four
 * channels are collected and asserted together.
 *
 * `offOrigin` is separate because it is not an error: a request that SUCCEEDS against some other
 * host is the failure. A static export that quietly imports from a CDN renders perfectly in a
 * networked Chromium and goes green while not being self-contained — which is the one property
 * static mode exists to prove.
 */
async function open(
  url: string,
  origin: string,
): Promise<{ page: Page; errors: string[]; offOrigin: string[]; paths: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  const offOrigin: string[] = [];
  /** Same-origin pathnames requested, so a test can assert WHICH file a cell went after. */
  const paths: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("requestfailed", (r) =>
    errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  page.on("request", (r) => {
    if (r.url().startsWith(`${origin}/`)) paths.push(new URL(r.url()).pathname);
    else offOrigin.push(r.url());
  });
  await page.goto(url, { waitUntil: "load" });
  return { page, errors, offOrigin, paths };
}

/** The id of the cell root the first `svg` on the page actually landed in. */
function svgCellRoot(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const svg = document.querySelector("svg");
    return svg?.closest("[id^='cell-']")?.id ?? null;
  });
}

describe("a built notebook page in a real browser", () => {
  for (const [label, origin] of [
    ["hosted", `http://127.0.0.1:${HOSTED_PORT}`],
    ["static", `http://127.0.0.1:${STATIC_PORT}`],
  ] as const) {
    it(`executes its cell graph and renders a plot into its own cell root (${label})`, async () => {
      const { page, errors, offOrigin } = await open(`${origin}/chart.html`, origin);
      // Imports, downloads and a d3 render: give it room. The wait is not the assertion — it
      // only avoids asserting on a page that has not finished; every check below still runs.
      await page.waitForSelector("#cell-4 svg", { timeout: 60_000 }).catch(() => undefined);

      expect(errors).toEqual([]);
      // A static export must be self-contained: nothing may come from anywhere but this server.
      if (label === "static") expect(offOrigin).toEqual([]);
      expect(await svgCellRoot(page)).toBe("cell-4");
      expect(await page.locator("#cell-4 svg").count()).toBeGreaterThan(0);
      // The other roots must stay empty: a wrong `state.root` puts real output in the wrong box,
      // and counting `svg` page-wide would call that a pass.
      expect(await page.locator("#cell-1 svg, #cell-2 svg, #cell-3 svg").count()).toBe(0);
      // Plot's own marker, so this is Plot's output and not some incidental icon.
      const className = await page.locator("#cell-4 svg").first().getAttribute("class");
      expect(className ?? "").toMatch(/^plot-/);
      await page.close();
    }, 120_000);

    it(`renders a syntax error in place without breaking the other cells (${label})`, async () => {
      const { page, errors, offOrigin } = await open(`${origin}/broken.html`, origin);
      await page
        .waitForFunction(
          () => (document.getElementById("cell-3")?.textContent ?? "").includes("3"),
          { timeout: 30_000 },
        )
        .catch(() => undefined);

      // A cell that does not parse is an authoring state, not a page crash: nothing is thrown at
      // the browser, because the broken cell never becomes a `define()` call in the first place.
      expect(errors).toEqual([]);
      if (label === "static") expect(offOrigin).toEqual([]);
      expect(await page.locator(".cell-error").count()).toBe(1);
      expect(await page.locator("#cell-2 .cell-error").count()).toBe(1);
      // The cell AFTER the broken one still ran, and it still sees `ok` from the cell before it.
      expect(await page.locator("#cell-3").textContent()).toContain("3");
      await page.close();
    }, 120_000);

    // The one test that runs a SQL cell. Everything else about SQL in these two packages is
    // asserted against a fake `Db` or a string, and three separate defects on the precomputed
    // path (a root-anchored cache path, a BigInt that crashed JSON.stringify, and a bare array
    // where notebook-kit's `revive` needs `{rows, schema}`) were all invisible to those.
    it(`renders a PRECOMPUTED sql cell's rows on a nested page (${label})`, async () => {
      const { page, errors, offOrigin, paths } = await open(`${origin}/reports/q3.html`, origin);
      await page
        .waitForFunction(
          () => (document.getElementById("cell-2")?.textContent ?? "").includes("precomputed:"),
          { timeout: 30_000 },
        )
        .catch(() => undefined);

      expect(errors).toEqual([]);
      if (label === "static") expect(offOrigin).toEqual([]);

      // The page went after the file the build wrote, at the NESTED path. A cache anchored at
      // the site root would 404 here and be a pass on any root-level fixture.
      expect(cachePath).toMatch(/^\/reports\/\.observable\/cache\//);
      expect(paths).toContain(cachePath);

      // The rows themselves, read out of the sql cell BY ITS OUTPUT NAME by a downstream cell:
      // order preserved, and `340`/`120` as numbers rather than the `"340n"` a bigint would
      // have had to become. This is the end-to-end proof — a `define()` that merely existed
      // would leave this cell empty.
      expect(inspected(await page.locator("#cell-2").textContent())).toBe(
        "precomputed:south=340,north=120",
      );
      // ...and the sql cell displayed its own result too, rather than being laid out as prose.
      expect((await page.locator("#cell-1").textContent()) ?? "").not.toBe("");
      expect(await page.locator("#cell-1 .observablehq").count()).toBeGreaterThan(0);
      await page.close();
    }, 120_000);

    it(`renders a LIVE sql cell's rows against DuckDB-WASM (${label})`, async () => {
      const { page, errors, offOrigin } = await open(`${origin}/live.html`, origin);
      // Instantiating duckdb-wasm and running the query takes real time on a cold page.
      await page
        .waitForFunction(
          () => (document.getElementById("cell-3")?.textContent ?? "").includes("live:"),
          { timeout: 60_000 },
        )
        .catch(() => undefined);

      expect(errors).toEqual([]);
      // The live path must not reach jsDelivr for duckdb's bundles: `newBrowserDuckDb` falls
      // back to the CDN when `bundles` is omitted, and that fallback would render perfectly.
      if (label === "static") expect(offOrigin).toEqual([]);

      // One row, because `${200}` was bound as a parameter and the engine applied it.
      expect(inspected(await page.locator("#cell-3").textContent())).toBe("live:south=340");
      expect((await page.locator("#cell-2").textContent()) ?? "").not.toBe("");
      await page.close();
    }, 180_000);
  }
});
