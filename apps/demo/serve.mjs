/**
 * Build every notebook in ./notebooks and serve the result.
 *
 * This is the whole pipeline end to end: Markdown -> the standard notebook-kit
 * .html artifact -> resolved imports -> transpiled cells -> a page -> served.
 * Nothing is mocked. The npm imports are resolved and transformed on demand by
 * webrun-modules and served from this origin, so the page makes no third-party
 * requests at run time.
 *
 *   node serve.mjs            build once and serve
 *   node serve.mjs --watch    also rebuild when a notebook changes
 */
import { createServer } from "node:http";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { JSDOM } from "jsdom";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { newModuleServer } from "@statewalker/webrun-modules";
import { newNotebookBuild } from "@statewalker/notebook-build";
import { newNotebookSite } from "@statewalker/notebook-site";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8099);
const WATCH = process.argv.includes("--watch");

// Every store is a FilesApi. Swap NodeFilesApi for the OPFS or in-memory backend
// and the same build runs in a browser — that is the point of the design.
const notebooks = new NodeFilesApi({ rootDir: join(here, "notebooks") });
const output = new NodeFilesApi({ rootDir: join(here, ".out") });
const cache = new NodeFilesApi({ rootDir: join(here, ".cache/build") });
const modules = new NodeFilesApi({ rootDir: join(here, ".cache/modules") });

const moduleServer = newModuleServer({ cache: modules, basePath: "/_m/" });

// Under Node the DOM is injected; in a browser these are the natives.
const { window } = new JSDOM("<!doctype html>");
const dom = { document: window.document, parser: new window.DOMParser() };

const build = newNotebookBuild({
  notebooks,
  output,
  cache,
  moduleServer,
  dom,
  mode: "hosted", // modules served live from /_m/; "static" materializes them instead
  basePath: "/_m/",
  stylesUrl: "/_m/@observablehq/notebook-kit@2.6.4/dist/src/styles/index.css",
  onFailed: ({ notebookPath, error }) =>
    console.error(`  ✗ ${notebookPath}: ${error?.message ?? error}`),
  onRebuilt: (changed) =>
    console.log(`  ✓ ${changed.length} file(s) written: ${changed.slice(0, 4).join(", ")}${changed.length > 4 ? " …" : ""}`),
});

const handler = newNotebookSite({ output, moduleServer, basePath: "/_m/" });

console.log("building (first run downloads and transforms the npm imports)…");
const started = Date.now();
await build.build();
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (WATCH) {
  let pending = null;
  watch(join(here, "notebooks"), { recursive: true }, () => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      console.log("change detected, rebuilding…");
      await build.build().catch((e) => console.error(e));
    }, 50);
  });
  console.log("watching ./notebooks");
}

createServer(async (req, res) => {
  try {
    const response = await handler(
      new Request(new URL(req.url, `http://localhost:${PORT}`), { method: req.method }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e?.stack ?? e));
  }
}).listen(PORT, () => {
  console.log(`\n  http://localhost:${PORT}/index.html\n`);
});
