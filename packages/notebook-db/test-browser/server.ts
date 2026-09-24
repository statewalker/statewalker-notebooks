// Fixture HTTP server for the browser test.
//
// Two sibling patterns, combined, because neither one alone fits this package:
//
//  * `notebook-events/test-browser/server.ts` bundles the fixture's own page script with
//    esbuild. That is right for `src/client.ts`: its only import is `import type { Db,
//    DbEntry } from "@statewalker/db-api"`, erased at compile time, so there is nothing for a
//    real module server to prove by serving it.
//
//  * `notebook-build/test-browser/server.ts` wires a REAL `@statewalker/webrun-modules` server
//    (real npm registry, real transform) so a browser loads a real dependency graph the way a
//    hosted notebook page would. That is right for `@statewalker/db-duckdb-browser`: it is the
//    thing this task exists to prove against a real engine, and it must be fetched the way a
//    live SQL cell fetches it — through a module server, not through esbuild's bundler, which
//    would resolve it via Node resolution and prove nothing about the hosted path.
//
// `@statewalker/db-duckdb-browser`'s npm-published `exports` map is `{".": "./src/index.ts"}`
// (no `import`/`types` condition) and does not load — see the package README and the umbrella
// memory note this task was briefed with. Only the WORKSPACE copy is fixed. `npmRegistrySource`
// would therefore fetch the broken published tarball, so a second `Source` — `localPackageSource`
// below — intercepts that one specifier and hands back the workspace package's own `dist/`
// instead, located via `import.meta.resolve` (not a hard-coded relative path into a sibling
// workspace: the package is a `workspace:*` peer of `notebook-db`, so pnpm already symlinks it
// into THIS package's own `node_modules`, and that symlink is all this depends on). Everything
// else — in particular `@duckdb/duckdb-wasm` itself — still resolves from the real npm registry.
//
// `@duckdb/duckdb-wasm`'s `.wasm` binaries and `*.worker.js` files are never `import`ed by its
// JS graph (they are loaded by URL at runtime), so `listResources` (a JS-reachable walk) never
// reports them — the same gap `notebook-build/src/deps.ts` documents and closes with a
// package-files union for a static export. This fixture has a live module server, not a static
// export, so it does not need `materializeDeps`: any raw file under a resolved package is
// already servable via `moduleServer.fetch` once the package has been touched once. But it DOES
// need to know those files' names to build `newBrowserDuckDb`'s `bundles` option (see below), so
// it uses the same `listPackageFiles` call `materializeDeps` uses, filtered to `.wasm`/`.worker.js`,
// instead of hard-coding duckdb-wasm's internal file names.

import { mkdir, readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import {
  type LoadedPackage,
  type ModuleServer,
  newModuleServer,
  npmRegistrySource,
  type Source,
} from "@statewalker/webrun-modules";
import * as esbuild from "esbuild";

const LOCAL_PACKAGE = "@statewalker/db-duckdb-browser";
const DUCKDB_WASM = "@duckdb/duckdb-wasm";

/** One `duckdb.DuckDBBundles`-shaped entry, without depending on the package's own types here
 *  (this file runs in Node; the type only exists in the browser-side `@duckdb/duckdb-wasm`). */
export interface DuckDbBundleUrls {
  mainModule: string;
  mainWorker: string;
}
export interface DuckDbBundles {
  mvp: DuckDbBundleUrls;
  eh: DuckDbBundleUrls;
}

/**
 * Locates the workspace copy of `@statewalker/db-duckdb-browser` via Node's own resolver
 * (`import.meta.resolve`, which — unlike `require.resolve` — follows the ESM-only `import`
 * condition in its `exports` map) and reads its `package.json` + `dist/*` straight off disk.
 * Plain `node:fs` reads are not gated by `exports` the way `import`/`require` are, so this can
 * reach `package.json` even though the package does not export that subpath.
 */
async function loadLocalDuckDbBrowser(): Promise<LoadedPackage> {
  const entryUrl = import.meta.resolve(LOCAL_PACKAGE);
  const distDir = dirname(fileURLToPath(entryUrl));
  const root = dirname(distDir);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  const files = new MemFilesApi();
  await files.write("/package.json", [new TextEncoder().encode(JSON.stringify(manifest))]);
  for (const name of await readdir(distDir)) {
    const bytes = await readFile(join(distDir, name));
    await files.write(`/dist/${name}`, [new Uint8Array(bytes)]);
  }
  return { name: manifest.name, version: manifest.version, files, manifest };
}

/** Intercepts only `@statewalker/db-duckdb-browser`; every other reference (in particular
 *  `@duckdb/duckdb-wasm`) falls through to whatever source is listed after this one. */
function localPackageSource(): Source {
  let cached: Promise<LoadedPackage> | undefined;
  return {
    matches: (ref) => "pkg" in ref && ref.pkg === LOCAL_PACKAGE,
    load: () => {
      cached ??= loadLocalDuckDbBrowser();
      return cached;
    },
  };
}

async function bundleMain(here: string): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [join(here, "fixture", "main.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild produced no JS output for fixture/main.ts");
  return file.text;
}

/** Builds same-origin `mvp`/`eh` bundle URLs for `newBrowserDuckDb({ bundles })` from whatever
 *  `@duckdb/duckdb-wasm` version the module server actually resolved, instead of hard-coding a
 *  version-specific file name (see the header comment). */
async function resolveDuckDbBundles(moduleServer: ModuleServer): Promise<DuckDbBundles> {
  const files = await moduleServer.listPackageFiles({ pkg: DUCKDB_WASM });
  const { url: entryUrl } = await moduleServer.resolve({ pkg: DUCKDB_WASM });
  // entryUrl looks like "/@duckdb/duckdb-wasm@<version>/dist/duckdb-browser.mjs"; the package
  // root is everything up to (and including) the trailing "/" before "dist/...".
  const pkgRoot = entryUrl.slice(0, entryUrl.indexOf("dist/"));

  const find = (re: RegExp): string => {
    const file = files.find((f) => re.test(f));
    if (!file) throw new Error(`${DUCKDB_WASM}: no package file matches ${re}`);
    return `${pkgRoot}${file}`;
  };

  // `.worker.js` files are loaded with `new Worker(url)` — a CLASSIC (non-module) script, which
  // cannot contain `import`/`export`. The module server's default transform wraps a file it
  // detects as CJS (duckdb-wasm's worker bundles are UMD) into an ESM CJS-interop shim, which
  // DOES contain `import`/`export` — a classic worker loading that throws a SyntaxError, and
  // `new Worker()` reports that asynchronously via `onerror`, not a rejection, so
  // `db.instantiate()` just hangs forever waiting on a worker that already died. `?raw` bypasses
  // the transform entirely and serves the untouched UMD bytes, which run fine as a classic
  // script. (Found empirically: both browser tests hung at the 120s timeout with no page error
  // captured, until the served worker body was inspected directly and turned out to start with
  // `import { Buffer, ... } from "../~deps/~globals.js"`.)
  const findWorker = (re: RegExp): string => `${find(re)}?raw`;

  return {
    mvp: {
      mainModule: find(/^dist\/duckdb-mvp\.wasm$/),
      mainWorker: findWorker(/^dist\/duckdb-browser-mvp\.worker\.js$/),
    },
    eh: {
      mainModule: find(/^dist\/duckdb-eh\.wasm$/),
      mainWorker: findWorker(/^dist\/duckdb-browser-eh\.worker\.js$/),
    },
  };
}

export interface FixtureServer {
  origin: string;
  /** Same-origin `mvp`/`eh` bundle URLs, ready for `newBrowserDuckDb({ bundles })`. */
  bundles: DuckDbBundles;
  stop(): Promise<void>;
}

export async function startFixtureServer(port: number): Promise<FixtureServer> {
  const here = dirname(fileURLToPath(import.meta.url));

  // Persisted across runs on purpose — see notebook-build's test-browser/server.ts: downloading
  // and transforming duckdb-wasm's graph is the slow part, and only the first run pays for it.
  const cacheDir = join(here, "..", "node_modules", ".cache", "browser-test-modules");
  await mkdir(cacheDir, { recursive: true });
  const cache = new NodeFilesApi({ rootDir: cacheDir });

  const moduleServer = newModuleServer({
    cache,
    sources: [localPackageSource(), npmRegistrySource()],
    target: "browser",
  });

  const [{ url: dbEntryUrl }, bundles, mainJs] = await Promise.all([
    moduleServer.resolve({ pkg: LOCAL_PACKAGE }),
    resolveDuckDbBundles(moduleServer),
    bundleMain(here),
  ]);

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>notebook-db browser fixture</title>
    <script type="importmap">${JSON.stringify({ imports: { [LOCAL_PACKAGE]: dbEntryUrl } })}</script>
  </head>
  <body>
    <script type="module" src="/main.js"></script>
  </body>
</html>
`;

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/" || url.pathname === "/index.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }
        if (url.pathname === "/main.js") {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          res.end(mainJs);
          return;
        }
        const response = await moduleServer.fetch(
          new Request(`http://localhost${url.pathname}${url.search}`),
        );
        const body = new Uint8Array(await response.arrayBuffer());
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        res.writeHead(response.status, headers);
        res.end(body);
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(String((error as Error)?.stack ?? error));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    origin: `http://127.0.0.1:${port}`,
    bundles,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
