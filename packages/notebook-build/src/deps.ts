import type { FilesApi } from "@statewalker/webrun-files";
import { resolveWithin } from "./paths.js";
import { isNpmSpecifier, type ModuleRef, type PinMap, toModuleRef } from "./resolve.js";

/**
 * Non-JS files a package ships that its own JS graph never imports, and which
 * `listResources` therefore never reports: wasm binaries loaded by URL at runtime,
 * fonts referenced from CSS, and stylesheets. Measured against two real packages before
 * this stage was designed: `@duckdb/duckdb-wasm` reported 192 JS-reachable modules while
 * its three `dist/duckdb-*.wasm` binaries were absent, and `katex` reported a single
 * module while its 24 `.woff2` fonts were absent. Both serve fine on demand from a
 * hosted module server, so a static export built from `listResources` alone looks
 * perfect and then dies at the first wasm instantiation or unstyled-font load.
 */
export const ASSET_EXTENSIONS = [".wasm", ".woff2", ".woff", ".ttf", ".css"] as const;

/**
 * Classic worker scripts a package ships. Same blind spot as {@link ASSET_EXTENSIONS} — nothing
 * `import`s them, they are loaded by URL with `new Worker(url)`, so `listResources` never
 * reports them — but they cannot be folded into that list, for two reasons.
 *
 * First, the match has to be WORKER-specific rather than an extension: `.js` would sweep in
 * every JS file a package ships whether the page uses it or not, and `*.worker.js*` (a blanket
 * glob) would drag `*.worker.js.map` along, which is dead weight in an export.
 *
 * Second — and this is the half that survives shipping the file — a worker script must be
 * fetched with `?raw`. The module server's default transform wraps a file it detects as CJS
 * (duckdb-wasm's worker bundles are UMD) into an ESM interop shim:
 *
 *     import { Buffer, __dirname, ... } from "../~deps/~globals.js";var __m;...
 *
 * A classic `Worker` cannot parse `import`, and `new Worker()` reports the SyntaxError
 * asynchronously through `onerror` — which `@statewalker/db-duckdb-browser`'s
 * `browser-duckdb.ts` does not listen for — so `db.instantiate()` hangs forever with no error
 * anywhere. `?raw` bypasses the transform and serves the untouched UMD bytes:
 *
 *     "use strict";var duckdb=(()=>{var qc=Object.create;...
 *
 * The `?raw` belongs to the FETCH only. The file is written at its plain `.worker.js` path, so
 * a static host derives a JavaScript MIME type from the extension the way it does for any other
 * script — which is what the spec requires for a classic worker, and which `?raw`'s own
 * `application/octet-stream` response header would not give (Chromium tolerates it today).
 *
 * The cleaner fix is upstream: `webrun-modules` should serve `*.worker.js` untransformed by
 * default, since its only consumer is `new Worker(url)`. That is a different repo; this is the
 * consumer-side workaround.
 */
const WORKER_SCRIPT = /\.worker\.js$/;

/**
 * Structural subset of `@statewalker/webrun-modules`'s `ModuleServer` used here, so
 * tests need no real server.
 */
export interface ModuleServerLike {
  resolve(ref: ModuleRef): Promise<{ url: string; target: string }>;
  listResources(ref: ModuleRef): Promise<string[]>;
  listPackageFiles(ref: ModuleRef): Promise<string[]>;
  fetch(request: Request): Promise<Response>;
}

/**
 * Matches one `(@scope/)?name@version` segment. The scope, when present, contains a
 * `/` itself (`@duckdb/duckdb-wasm@1.29.0`) — so the package root is NOT "the first
 * slash after basePath": for a scoped package that first slash is the scope
 * separator, one segment short of the version boundary. This is the same grammar
 * `webrun-modules`'s own `depsRoot` uses for the identical problem (deriving a
 * package's module root from a `{name}@{version}/...` id).
 */
const PACKAGE_ROOT_RE = /^((?:@[^/]+\/)?[^/]+@[^/]+)\//;

/**
 * `/_m/duck@1/dist/duckdb-browser.mjs` + `/_m/` -> `/_m/duck@1/`.
 * `/_m/@duckdb/duckdb-wasm@1.29.0/dist/x.mjs` + `/_m/` -> `/_m/@duckdb/duckdb-wasm@1.29.0/`.
 *
 * Throws rather than silently skipping a URL it cannot parse: a silent skip here
 * drops the whole side-car-asset union for that pin with no signal, which is the
 * wrong failure mode for a parsing gap that was already proven too naive once.
 */
function packageRoot(url: string, basePath: string): string {
  if (!url.startsWith(basePath)) {
    throw new Error(
      `cannot determine the package root of "${url}": not under basePath "${basePath}"`,
    );
  }
  const rest = url.slice(basePath.length);
  const match = PACKAGE_ROOT_RE.exec(rest);
  if (!match) {
    throw new Error(
      `cannot determine the package root of "${url}": expected "(@scope/)?name@version/..." after basePath "${basePath}"`,
    );
  }
  return `${basePath}${match[1]}/`;
}

/**
 * Every URL this stage materializes is used verbatim as an OUTPUT PATH, and `..` in one walks
 * out of the output root on any backend that maps paths onto a real filesystem. `listResources`
 * is answered by the module server; `listPackageFiles` is answered by whatever the package's
 * tarball happens to contain, which no one in this pipeline controls. Both are confined to the
 * root they are supposed to live under, and a URL that does not stay there is a hard error
 * rather than a skipped file — a silently dropped module is a 404 much later.
 */
function containedUrl(root: string, relative: string, what: string): string {
  const url = resolveWithin(root, relative);
  if (url === undefined) {
    throw new Error(`cannot materialize ${what} "${relative}": it resolves outside "${root}"`);
  }
  return url;
}

/**
 * Materializes the full dependency closure a static export needs into `output`: every
 * JS-reachable module (`listResources`) unioned with the filtered non-JS assets a
 * package ships (`listPackageFiles`, kept to `ASSET_EXTENSIONS`). `listResources` alone
 * is not enough — see `ASSET_EXTENSIONS` above for the measured reason. Returns the
 * output paths written.
 *
 * A pin map is built only from npm specifiers (the resolve stage skips anything else),
 * but this does not assume that: a non-npm key is skipped rather than sent through
 * `toModuleRef`, which throws for anything that is not an npm specifier.
 */
export async function materializeDeps(
  pins: PinMap,
  server: ModuleServerLike,
  output: FilesApi,
  basePath: string,
): Promise<string[]> {
  // url -> fetch it with `?raw`. A Map rather than a Set because the same output path can be
  // reached twice and the two reachings disagree about the representation; see WORKER_SCRIPT.
  const urls = new Map<string, boolean>();

  for (const [specifier, url] of pins) {
    if (!isNpmSpecifier(specifier)) continue;
    const ref = toModuleRef(specifier);

    for (const u of await server.listResources(ref)) {
      if (!u.startsWith(basePath)) {
        throw new Error(`cannot materialize ${u}: not under basePath "${basePath}"`);
      }
      urls.set(containedUrl(basePath, u.slice(basePath.length), "module"), false);
    }

    // The union that makes the export actually work.
    const pkgRoot = packageRoot(url, basePath);
    for (const file of await server.listPackageFiles(ref)) {
      if (ASSET_EXTENSIONS.some((ext) => file.endsWith(ext))) {
        urls.set(containedUrl(pkgRoot, file, "package file"), false);
      } else if (WORKER_SCRIPT.test(file)) {
        // Set AFTER the module pass and unconditionally: if a worker script somehow also shows
        // up as a JS-reachable resource, the raw representation still wins — how the file is
        // LOADED (`new Worker`, a classic script) decides what it may contain, and a transformed
        // body is unusable there whatever else points at it.
        urls.set(containedUrl(pkgRoot, file, "worker script"), true);
      }
    }
  }

  const written: string[] = [];
  for (const [url, raw] of urls) {
    // `?raw` on the REQUEST only; `url` stays the output path, extension intact.
    const res = await server.fetch(new Request(`http://local${url}${raw ? "?raw" : ""}`));
    if (!res.ok) throw new Error(`cannot materialize ${url}: ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    await output.write(url, [data]);
    written.push(url);
  }
  return written;
}
