import type { Notebook } from "@observablehq/notebook-kit";
import {
  BuildEngine,
  type Logger,
  NULL_LOGGER,
  type RegisteredBuilder,
  SOURCES_REMOVED_SIGNAL,
  SOURCES_SIGNAL,
} from "@statewalker/webrun-builder";
import {
  extname,
  type FilesApi,
  joinPath,
  readText,
  tryReadText,
  writeText,
} from "@statewalker/webrun-files";
import { copyAttachments } from "./assets.js";
import { type ModuleServerLike, materializeDeps } from "./deps.js";
import { parseMarkdown } from "./md-parse.js";
import { parseNotebookHtml } from "./parse.js";
import { renderPage } from "./render.js";
import { type PinMap, resolveNotebook, toModuleRef } from "./resolve.js";
import { type DomEnv, notebookHash, serializeNotebook } from "./serialize.js";
import { transpileNotebook } from "./transpile.js";

/** Where the build's own state lives: engine stores in `notebooks`, sidecars in `cache`. */
const SYSTEM_FOLDER = ".notebook-build";

const NOTEBOOK_CELL = "Notebook";
const PAGE_CELL = "Page";
const PRUNE_CELL = "Prune";

/** Signal carrying "the serialized notebook for this uri changed". */
const NOTEBOOK_SIGNAL = "notebook";

/**
 * The runtime the rendered page imports `define` from. It is not one of the
 * notebook's own imports, so it is resolved separately — but in static mode it is
 * folded into the pin map handed to `[Deps]`, because an exported site whose
 * `define` 404s is a blank page.
 */
const RUNTIME_SPECIFIER = "npm:@observablehq/notebook-kit/runtime";

/** Default URL prefix the module server serves packages under. */
const DEFAULT_BASE_PATH = "/_m/";

const ARTIFACT_SUFFIX = ".nb.html";
const HASH_SUFFIX = ".hash";
const MANIFEST_SUFFIX = ".outputs.json";

/** Source extensions treated as notebooks; everything else scanned is inert (data, assets). */
const NOTEBOOK_EXT = /\.(?:md|html)$/i;

/** One notebook that could not be built, reported after the build converges. */
export interface NotebookFailure {
  /** The notebook's source path, e.g. `/reports/q3.md`. */
  notebookPath: string;
  error: unknown;
}

export interface NotebookBuildOptions {
  /** Notebook sources, scanned by the engine. */
  notebooks: FilesApi;
  /** Where pages, attachments and (in static mode) the dependency closure are written. */
  output: FilesApi;
  /** Where the serialized-notebook artifacts and the incremental sidecars live. */
  cache: FilesApi;
  moduleServer: ModuleServerLike;
  dom: DomEnv;
  /**
   * `"hosted"`: the module server is mounted live, so `[Deps]` does not run.
   * `"static"` (default): the dependency closure is materialized into `output`.
   */
  mode?: "hosted" | "static";
  /** URL prefix the module server serves packages under (default `/_m/`). */
  basePath?: string;
  /** Called once per converged build with the output paths that changed, if any. */
  onRebuilt?: (changed: string[]) => void;
  /** Called once per converged build with the notebooks that failed, if any. */
  onFailed?: (failures: NotebookFailure[]) => void;
  logger?: Logger;
}

export interface NotebookBuild {
  build(): Promise<void>;
}

/** What one notebook wrote into `output` — the record a prune undoes. */
interface Manifest {
  page: string;
  assets: string[];
  deps: string[];
}

interface Host {
  engine: BuildEngine<Host>;
  notebooks: FilesApi;
  output: FilesApi;
  cache: FilesApi;
  moduleServer: ModuleServerLike;
  dom: DomEnv;
  mode: "hosted" | "static";
  basePath: string;
  /** Output paths written during the current `build()`. */
  changed: Set<string>;
  failures: NotebookFailure[];
  /** Memoized per build, so a recovered module server is picked up on the next one. */
  runtime?: Promise<string>;
}

function sourcePath(uri: string): string {
  return joinPath("/", uri);
}

/** `nb/report.md` -> `/nb/report.html`. An extensionless source just gains `.html`. */
function pagePath(uri: string): string {
  const path = sourcePath(uri);
  const ext = extname(path);
  return `${ext ? path.slice(0, -ext.length) : path}.html`;
}

function sidecarPath(uri: string, suffix: string): string {
  return joinPath("/", SYSTEM_FOLDER, `${uri}${suffix}`);
}

function parseSource(text: string, uri: string, dom: DomEnv): Notebook {
  return /\.html$/i.test(uri) ? parseNotebookHtml(text, dom) : parseMarkdown(text);
}

async function readManifestAt(cache: FilesApi, path: string): Promise<Manifest | undefined> {
  const text = await tryReadText(cache, path);
  if (text === undefined) return undefined;
  try {
    const raw = JSON.parse(text) as Partial<Manifest>;
    if (typeof raw.page !== "string") return undefined;
    return { page: raw.page, assets: raw.assets ?? [], deps: raw.deps ?? [] };
  } catch {
    // A truncated sidecar is a cache miss, not a build failure: the notebook is
    // simply rebuilt and the record rewritten.
    return undefined;
  }
}

function manifestPaths(manifest: Manifest): string[] {
  return [manifest.page, ...manifest.assets, ...manifest.deps];
}

/**
 * The gate. A notebook is skipped only when the serialized `.html` it produces is
 * byte-identical to the one last *successfully rendered* (the hash sidecar is written
 * by `[Page]`, never by `[Notebook]`) AND every output that render produced is still
 * present. Hashing the serialization rather than the source is deliberate: two
 * different Markdown inputs that serialize identically must not re-render, and an
 * mtime bump carrying identical bytes must reuse the artifact.
 */
async function isUpToDate(host: Host, uri: string, hash: string): Promise<boolean> {
  if ((await tryReadText(host.cache, sidecarPath(uri, HASH_SUFFIX))) !== hash) return false;
  const manifest = await readManifestAt(host.cache, sidecarPath(uri, MANIFEST_SUFFIX));
  if (!manifest) return false;
  // `deps` is deliberately not probed: the closure is shared across notebooks and can
  // run to thousands of files, and it is re-materialized whenever any notebook renders.
  for (const path of [manifest.page, ...manifest.assets]) {
    if (!(await host.output.exists(path))) return false;
  }
  return true;
}

function runtimeUrlOf(host: Host): Promise<string> {
  host.runtime ??= host.moduleServer
    .resolve(toModuleRef(RUNTIME_SPECIFIER))
    .then((resolved) => resolved.url);
  return host.runtime;
}

/**
 * Render one notebook out of its serialized artifact.
 *
 * Ordering is load-bearing: everything that can throw for a notebook-specific reason
 * (`resolveNotebook`, `copyAttachments`) runs before the page is written, and the hash
 * sidecar is written last — so a notebook that failed carries no "already built" record
 * and is retried the next time its source is scanned.
 */
async function emitPage(host: Host, uri: string): Promise<void> {
  const notebookPath = sourcePath(uri);
  const serialized = await readText(host.cache, sidecarPath(uri, ARTIFACT_SUFFIX));
  const nb = parseNotebookHtml(serialized, host.dom);

  const pins = await resolveNotebook(nb, { moduleServer: host.moduleServer }, notebookPath);
  const runtimeUrl = await runtimeUrlOf(host);
  const page = renderPage(nb, transpileNotebook(nb, pins), { runtimeUrl });
  const assets = await copyAttachments(nb, host.notebooks, host.output, notebookPath);

  const pagePathOf = pagePath(uri);
  await writeText(host.output, pagePathOf, page);

  const deps =
    host.mode === "static"
      ? await materializeDeps(
          new Map([...pins, [RUNTIME_SPECIFIER, runtimeUrl]]) as PinMap,
          host.moduleServer,
          host.output,
          host.basePath,
        )
      : [];

  const manifest: Manifest = { page: pagePathOf, assets, deps };
  await writeText(host.cache, sidecarPath(uri, MANIFEST_SUFFIX), JSON.stringify(manifest));
  await writeText(host.cache, sidecarPath(uri, HASH_SUFFIX), await notebookHash(serialized));
  for (const path of [pagePathOf, ...assets]) host.changed.add(path);
}

/**
 * Every output path still claimed by a notebook other than `uri`. Two notebooks can
 * reference the same attachment (and always share most of the dependency closure); the
 * survivor's own build is gated off by its unchanged hash, so nothing would ever
 * re-copy a file this prune took away.
 */
async function pathsClaimedByOthers(host: Host, uri: string): Promise<Set<string>> {
  const self = sidecarPath(uri, MANIFEST_SUFFIX);
  const kept = new Set<string>();
  const root = joinPath("/", SYSTEM_FOLDER);
  if (!(await host.cache.exists(root))) return kept;
  for await (const info of host.cache.list(root, { recursive: true })) {
    if (info.kind !== "file") continue;
    const path = joinPath("/", info.path);
    if (!path.endsWith(MANIFEST_SUFFIX) || path === self) continue;
    const manifest = await readManifestAt(host.cache, path);
    if (manifest) for (const claimed of manifestPaths(manifest)) kept.add(claimed);
  }
  return kept;
}

async function pruneNotebook(host: Host, uri: string): Promise<void> {
  const manifest = await readManifestAt(host.cache, sidecarPath(uri, MANIFEST_SUFFIX));
  if (manifest) {
    const kept = await pathsClaimedByOthers(host, uri);
    for (const path of manifestPaths(manifest)) {
      if (kept.has(path)) continue;
      if (await host.output.exists(path)) await host.output.remove(path);
    }
  }
  for (const suffix of [ARTIFACT_SUFFIX, HASH_SUFFIX, MANIFEST_SUFFIX]) {
    const path = sidecarPath(uri, suffix);
    if (await host.cache.exists(path)) await host.cache.remove(path);
  }
}

/**
 * scanner → `sources` → [Notebook] → `notebook` → [Page], with [Prune] on the
 * `sources-removed` tombstone.
 *
 * [Notebook] owns parsing, serialization and the content-hash gate; [Page] owns
 * resolution, transpilation, rendering, attachments and the static dependency closure.
 * The serialized artifact in `cache` is the handoff between them, so a build resumed in
 * a fresh process renders exactly the bytes that were hashed.
 *
 * A notebook that throws is recorded in `host.failures` and its update is marked
 * handled: the cascade continues to the other notebooks instead of dying on the first
 * bad one, and the failures are reported once the build converges.
 */
function notebookBuilders(): RegisteredBuilder<Host>[] {
  return [
    {
      id: NOTEBOOK_CELL,
      inputs: [SOURCES_SIGNAL],
      outputs: [NOTEBOOK_SIGNAL],
      async *handler(host) {
        for await (const update of host.engine.readUpdates({
          signal: SOURCES_SIGNAL,
          cell: NOTEBOOK_CELL,
        })) {
          if (NOTEBOOK_EXT.test(update.uri)) {
            try {
              const text = await readText(host.notebooks, sourcePath(update.uri));
              const serialized = serializeNotebook(
                parseSource(text, update.uri, host.dom),
                host.dom,
              );
              if (!(await isUpToDate(host, update.uri, await notebookHash(serialized)))) {
                await writeText(host.cache, sidecarPath(update.uri, ARTIFACT_SUFFIX), serialized);
                yield { signal: NOTEBOOK_SIGNAL, uri: update.uri, stamp: update.stamp };
              }
            } catch (error) {
              host.failures.push({ notebookPath: sourcePath(update.uri), error });
            }
          }
          await update.handled();
          if (!(await host.engine.yieldControl())) return false;
        }
        return true;
      },
    },
    {
      id: PAGE_CELL,
      inputs: [NOTEBOOK_SIGNAL],
      outputs: [],
      // biome-ignore lint/correctness/useYield: a sink cell emits no updates.
      async *handler(host) {
        for await (const update of host.engine.readUpdates({
          signal: NOTEBOOK_SIGNAL,
          cell: PAGE_CELL,
        })) {
          try {
            await emitPage(host, update.uri);
          } catch (error) {
            host.failures.push({ notebookPath: sourcePath(update.uri), error });
          }
          await update.handled();
          if (!(await host.engine.yieldControl())) return false;
        }
        return true;
      },
    },
    {
      id: PRUNE_CELL,
      inputs: [SOURCES_REMOVED_SIGNAL],
      outputs: [],
      // biome-ignore lint/correctness/useYield: a sink cell emits no updates.
      async *handler(host) {
        for await (const update of host.engine.readUpdates({
          signal: SOURCES_REMOVED_SIGNAL,
          cell: PRUNE_CELL,
        })) {
          try {
            await pruneNotebook(host, update.uri);
          } catch (error) {
            host.failures.push({ notebookPath: sourcePath(update.uri), error });
          }
          await update.handled();
          if (!(await host.engine.yieldControl())) return false;
        }
        return true;
      },
    },
  ];
}

export function newNotebookBuild(options: NotebookBuildOptions): NotebookBuild {
  const { notebooks, output, cache } = options;
  // The engine scans `notebooks` and keeps its own state there; the sidecars live in
  // `cache` and the pages in `output`. Sharing an instance would feed generated files
  // back in as sources.
  if (notebooks === cache || notebooks === output) {
    throw new Error(
      "newNotebookBuild: `notebooks`, `output` and `cache` must be distinct FilesApi instances",
    );
  }
  const logger = options.logger ?? NULL_LOGGER;
  const host = {
    notebooks,
    output,
    cache,
    moduleServer: options.moduleServer,
    dom: options.dom,
    mode: options.mode ?? "static",
    basePath: options.basePath ?? DEFAULT_BASE_PATH,
    changed: new Set<string>(),
    failures: [] as NotebookFailure[],
  } as Host;
  const engine = new BuildEngine<Host>({
    files: notebooks,
    rootPath: "/",
    systemFolder: SYSTEM_FOLDER,
    logger,
    host,
  });
  host.engine = engine;
  for (const builder of notebookBuilders()) engine.registerBuilder(builder);

  return {
    async build() {
      host.changed.clear();
      host.failures.length = 0;
      host.runtime = undefined;
      for await (const _ of engine.run()) {
        // Drain progress events to convergence.
      }
      if (host.failures.length > 0) {
        for (const failure of host.failures) {
          logger.error("notebook build failed", {
            notebook: failure.notebookPath,
            error: failure.error,
          });
        }
        options.onFailed?.([...host.failures]);
      }
      if (host.changed.size > 0) options.onRebuilt?.([...host.changed]);
    },
  };
}
