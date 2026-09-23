import type { FilesApi } from "@statewalker/webrun-files";
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
 * Structural subset of `@statewalker/webrun-modules`'s `ModuleServer` used here, so
 * tests need no real server.
 */
export interface ModuleServerLike {
  resolve(ref: ModuleRef): Promise<{ url: string; target: string }>;
  listResources(ref: ModuleRef): Promise<string[]>;
  listPackageFiles(ref: ModuleRef): Promise<string[]>;
  fetch(request: Request): Promise<Response>;
}

/** `/_m/duck@1/dist/duckdb-browser.mjs` + `/_m/` -> `/_m/duck@1/`, or undefined if malformed. */
function packageRoot(url: string, basePath: string): string | undefined {
  const idx = url.indexOf("/", basePath.length + 1);
  if (idx === -1) return undefined;
  return url.slice(0, idx + 1);
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
  const urls = new Set<string>();

  for (const [specifier, url] of pins) {
    if (!isNpmSpecifier(specifier)) continue;
    const ref = toModuleRef(specifier);

    for (const u of await server.listResources(ref)) urls.add(u);

    // The union that makes the export actually work.
    const pkgRoot = packageRoot(url, basePath);
    if (pkgRoot !== undefined) {
      for (const file of await server.listPackageFiles(ref)) {
        if (ASSET_EXTENSIONS.some((ext) => file.endsWith(ext))) urls.add(pkgRoot + file);
      }
    }
  }

  const written: string[] = [];
  for (const url of urls) {
    const res = await server.fetch(new Request(`http://local${url}`));
    if (!res.ok) throw new Error(`cannot materialize ${url}: ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    await output.write(url, [data]);
    written.push(url);
  }
  return written;
}
