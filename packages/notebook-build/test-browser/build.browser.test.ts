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

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FilesApi, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { newModuleServer } from "@statewalker/webrun-modules";
import { JSDOM } from "jsdom";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NotebookFailure, newNotebookBuild } from "../src/build.js";
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

const here = dirname(fileURLToPath(import.meta.url));

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
  if (mode === "hosted") {
    servers.push(
      await startOutputServer({ port: HOSTED_PORT, output, moduleServer, basePath: BASE_PATH }),
    );
  } else {
    // No module server: the static export must stand on its own files alone.
    servers.push(await startOutputServer({ port: STATIC_PORT, output }));
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
): Promise<{ page: Page; errors: string[]; offOrigin: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  const offOrigin: string[] = [];
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
    if (!r.url().startsWith(`${origin}/`)) offOrigin.push(r.url());
  });
  await page.goto(url, { waitUntil: "load" });
  return { page, errors, offOrigin };
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
  }
});
