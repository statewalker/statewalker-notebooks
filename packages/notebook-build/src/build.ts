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
  dirname,
  extname,
  type FilesApi,
  joinPath,
  readText,
  tryReadFile,
  tryReadText,
  writeText,
} from "@statewalker/webrun-files";
import { copyAttachments } from "./assets.js";
import { type ModuleServerLike, materializeDeps } from "./deps.js";
import { contentHash, textHash } from "./hash.js";
import { parseMarkdown } from "./md-parse.js";
import { parseNotebookHtml } from "./parse.js";
import { renderPage } from "./render.js";
import {
  type ModuleRef,
  type ModuleResolver,
  type PinMap,
  resolveNotebook,
  toModuleRef,
} from "./resolve.js";
import { type DomEnv, notebookHash, serializeNotebook } from "./serialize.js";
import { type CellDefinition, transpileNotebook } from "./transpile.js";

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
const STATE_SUFFIX = ".state.json";
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
  /**
   * Stylesheet the rendered pages link. Left unset the pages carry no styles at all,
   * which is rarely what a shipped site wants; a hosted setup normally points this at
   * the module server's copy of notebook-kit's CSS.
   */
  stylesUrl?: string;
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

/**
 * Everything the rendered page depended on, recorded when — and only when — the render
 * SUCCEEDED. The build re-derives a notebook whenever any of these disagrees with the world.
 *
 * The gate used to be `hash` alone, and every other input was assumed to follow the notebook's
 * bytes. It does not: a `stylesUrl` bump left every page linking the old stylesheet, switching
 * to static mode never materialized a closure, a republished dependency stayed pinned to its
 * old URL, an edited attachment kept serving its old bytes, and a page deleted out of the
 * output was never restored. All five were reproduced with the source untouched.
 */
interface NotebookState {
  /** Hash of the serialized notebook that was rendered. */
  hash: string;
  /** Hash of the build configuration the page was rendered under. */
  configHash: string;
  /** The pin map the page was linked against, runtime included: specifier -> URL. */
  pins: Record<string, string>;
  /** Source path -> hash of the bytes published for it. */
  attachments: Record<string, string>;
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
  stylesUrl?: string;
  logger: Logger;
  /** Hash of the configuration above — see `NotebookState.configHash`. */
  configHash: string;
  /** Memoized: the three roots are probed once per `NotebookBuild`, not once per build. */
  rootsChecked?: Promise<void>;
  /** Output paths written during the current `build()`. */
  changed: Set<string>;
  failures: NotebookFailure[];
  /**
   * The module server, with one resolution per specifier per build. The freshness check asks
   * it about every recorded pin of every notebook, so without this a hundred notebooks sharing
   * `d3` would ask a hundred times. Cleared on each `build()`, so a recovered module server and
   * a republished dependency are both picked up on the next one.
   */
  resolver: ModuleResolver & { reset(): void };
  /** Memoized per build, like every other resolution. */
  runtime?: Promise<string>;
}

/**
 * The configuration fingerprint. `mode`, `basePath` and `stylesUrl` all end up in the rendered
 * page or decide whether the closure is written at all, so a change to any of them must
 * invalidate every notebook — none of them leaves a trace in a notebook's own bytes.
 */
function configHashOf(options: NotebookBuildOptions): Promise<string> {
  return textHash(
    JSON.stringify({
      mode: options.mode ?? "static",
      basePath: options.basePath ?? DEFAULT_BASE_PATH,
      stylesUrl: options.stylesUrl ?? null,
    }),
  );
}

/**
 * Proves the three roots are three places, by writing a file into one and looking for it in
 * the others.
 *
 * The constructor compares instance identity, which is all a constructor can do — and three
 * `new NodeFilesApi({rootDir: base})` over one directory pass it while being the same tree.
 * The consequences are not subtle: the engine's scanner finds the sidecars it just wrote and
 * feeds generated files back in as sources, and the static site publishes the build's own
 * cache. The probe is hidden (a leading dot, so the scanner skips it) and removed again.
 *
 * It compares the ROOTS. Two instances that overlap only deeper down — an output rooted inside
 * the notebooks tree — are not caught here, and nothing short of resolving real paths would.
 */
async function assertDistinctRoots(host: Host): Promise<void> {
  const probe = joinPath("/", `${SYSTEM_FOLDER}.probe`);
  const pairs: [string, FilesApi, [string, FilesApi][]][] = [
    [
      "cache",
      host.cache,
      [
        ["notebooks", host.notebooks],
        ["output", host.output],
      ],
    ],
    ["output", host.output, [["notebooks", host.notebooks]]],
  ];
  for (const [name, files, others] of pairs) {
    await writeText(files, probe, name);
    try {
      for (const [otherName, other] of others) {
        if (!(await other.exists(probe))) continue;
        throw new Error(
          `newNotebookBuild: \`${name}\` and \`${otherName}\` are the same directory — ` +
            "they must be distinct FilesApi instances over distinct roots",
        );
      }
    } finally {
      if (await files.exists(probe)) await files.remove(probe);
    }
  }
}

/** A `ModuleResolver` that resolves each specifier at most once per build. */
function memoizingResolver(server: ModuleServerLike): ModuleResolver & { reset(): void } {
  let pending = new Map<string, Promise<{ url: string; target: string }>>();
  return {
    resolve(ref: ModuleRef) {
      const key = JSON.stringify([ref.pkg, ref.version ?? null, ref.subpath ?? null]);
      let found = pending.get(key);
      if (!found) {
        found = server.resolve(ref);
        pending.set(key, found);
      }
      return found;
    },
    reset() {
      pending = new Map();
    },
  };
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

/**
 * The other notebook sources that would publish to the same page path as `uri`.
 *
 * `pagePath` strips the extension and appends `.html`, and `NOTEBOOK_EXT` accepts `.md` and
 * `.html`, so `/report.md` and `/report.html` are two notebooks with one destination. Left
 * undetected that was silent: two manifests claimed the same output, whichever ran last won,
 * and deleting the loser left the winner's page serving for ever — its hash was unchanged so
 * it never re-rendered, and the prune correctly refused to remove a path another manifest
 * still claimed. The directory is listed rather than the two extensions probed, so a
 * `.MD`/`.md` pair is caught as well.
 */
async function collidingSources(host: Host, uri: string): Promise<string[]> {
  const path = sourcePath(uri);
  const target = pagePath(uri);
  const found: string[] = [];
  for await (const info of host.notebooks.list(dirname(path))) {
    if (info.kind !== "file") continue;
    const other = joinPath("/", info.path);
    if (other === path || !NOTEBOOK_EXT.test(other)) continue;
    if (pagePath(other.slice(1)) === target) found.push(other);
  }
  return found.sort();
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

async function readStateAt(cache: FilesApi, path: string): Promise<NotebookState | undefined> {
  const text = await tryReadText(cache, path);
  if (text === undefined) return undefined;
  try {
    const raw = JSON.parse(text) as Partial<NotebookState>;
    if (typeof raw.hash !== "string" || typeof raw.configHash !== "string") return undefined;
    return {
      hash: raw.hash,
      configHash: raw.configHash,
      pins: raw.pins ?? {},
      attachments: raw.attachments ?? {},
    };
  } catch {
    // A truncated sidecar is a cache miss, not a build failure.
    return undefined;
  }
}

function manifestPaths(manifest: Manifest): string[] {
  return [manifest.page, ...manifest.assets, ...manifest.deps];
}

/**
 * The gate, stated as a question with an answer: why must this notebook be re-derived?
 * `undefined` means it must not.
 *
 * A notebook is skipped only when the render that produced the published page SUCCEEDED (the
 * state sidecar is written by `[Page]`, never by `[Notebook]`), under this configuration, from
 * this serialization, against these pins and these attachment bytes — and every output that
 * render produced is still present. Hashing the serialization rather than the source is
 * deliberate: two different Markdown inputs that serialize identically must not re-render, and
 * an mtime bump carrying identical bytes must reuse the artifact.
 *
 * `hash` is omitted by the revalidation pass, which has not parsed the notebook and only asks
 * about the inputs that can move on their own.
 */
async function staleReason(host: Host, uri: string, hash?: string): Promise<string | undefined> {
  const state = await readStateAt(host.cache, sidecarPath(uri, STATE_SUFFIX));
  // No record means the last attempt never finished: a first build, or a render that threw.
  // Either way the retry must not wait for someone to touch the source.
  if (!state) return "it has no recorded successful build";
  if (hash !== undefined && state.hash !== hash) return "the notebook changed";
  if (state.configHash !== host.configHash) return "the build configuration changed";
  const manifest = await readManifestAt(host.cache, sidecarPath(uri, MANIFEST_SUFFIX));
  if (!manifest) return "its outputs were never recorded";
  // `deps` is deliberately not probed: the closure is shared across notebooks and can run to
  // thousands of files, and it is re-materialized whenever any notebook renders.
  for (const path of [manifest.page, ...manifest.assets]) {
    if (!(await host.output.exists(path))) return `a recorded output is missing (${path})`;
  }
  for (const [path, recorded] of Object.entries(state.attachments)) {
    const data = await tryReadFile(host.notebooks, path);
    if (data === undefined) return `an attachment is gone (${path})`;
    if ((await contentHash(data)) !== recorded) return `an attachment changed (${path})`;
  }
  for (const [specifier, url] of Object.entries(state.pins)) {
    let resolved: string;
    try {
      resolved = (await host.resolver.resolve(toModuleRef(specifier))).url;
    } catch {
      // Unverifiable, which is not the same as changed: a module server that is momentarily
      // unreachable must not tear down a page that works. The next reachable build re-checks.
      continue;
    }
    if (resolved !== url) return `a dependency moved (${specifier} -> ${resolved})`;
  }
  return undefined;
}

/**
 * Drops the recorded state of every notebook that must be re-derived, and re-drives the
 * pipeline over the whole source set when there is at least one.
 *
 * This exists because the engine's scanner is the build's only trigger and it watches exactly
 * one thing: the mtime of a source file. Everything else a page depends on — the configuration,
 * the module server's answers, an attachment's bytes, the output tree itself — can move with no
 * source touch at all, and `[Notebook]` would simply never run. `restartFrom` replays the known
 * sources through a gate that now asks all of those questions, so the unaffected notebooks fall
 * straight back out of it.
 */
async function revalidate(host: Host): Promise<void> {
  let stale = false;
  for await (const info of host.notebooks.list("/", { recursive: true })) {
    if (info.kind !== "file") continue;
    const path = joinPath("/", info.path);
    // The engine's own state lives under a dot-folder in this same tree; so does `.git`.
    if (path.split("/").some((segment) => segment.startsWith("."))) continue;
    if (!NOTEBOOK_EXT.test(path)) continue;
    const uri = path.slice(1);
    // The serialized artifact, not the source: it is `[Notebook]`'s record of what it decided
    // to render, and a `[Page]` that threw consumed its update and left the two disagreeing.
    // Without this the source's own edit is invisible here — the scanner already spent it.
    const artifact = await tryReadText(host.cache, sidecarPath(uri, ARTIFACT_SUFFIX));
    const reason = await staleReason(
      host,
      uri,
      artifact === undefined ? undefined : await notebookHash(artifact),
    );
    if (reason === undefined) continue;
    host.logger.info("notebook must be re-derived", { notebook: path, reason });
    const statePath = sidecarPath(uri, STATE_SUFFIX);
    if (await host.cache.exists(statePath)) await host.cache.remove(statePath);
    stale = true;
  }
  if (stale) await host.engine.restartFrom(NOTEBOOK_CELL);
}

function runtimeUrlOf(host: Host): Promise<string> {
  host.runtime ??= host.resolver
    .resolve(toModuleRef(RUNTIME_SPECIFIER))
    .then((resolved) => resolved.url);
  return host.runtime;
}

/**
 * Render one notebook out of its serialized artifact.
 *
 * Ordering is load-bearing in two separate ways, and the two pull in opposite
 * directions:
 *
 * 1. The MANIFEST is written as early as it can be complete — immediately after the
 *    page write, with `deps: []` — and rewritten once the closure is materialized.
 *    Recording it only at the end means a `[Deps]` failure (a transient
 *    `listResources`, say) leaves the page and its attachments in `output` with
 *    nothing recording them: a later deletion cannot prune what no manifest mentions,
 *    and the output grows for ever.
 * 2. The STATE sidecar is written last, and never by `[Notebook]`. It is the record
 *    "this exact serialization was successfully rendered, under this configuration,
 *    against these pins and these attachment bytes". Recording it at serialization time
 *    makes an edit that failed to render look already-built, so a retry with the same bytes
 *    is skipped and the previous version serves for ever.
 *
 * Everything that throws for a notebook-specific reason (`resolveNotebook`,
 * `copyAttachments`) still runs before anything is written at all.
 *
 * The freshness gate is asked again here, not only in `[Notebook]`: `restartFrom` replays
 * every past `notebook` update through this stage, and re-rendering a page that nothing has
 * invalidated would undo the incrementality the whole pipeline exists for.
 */
async function emitPage(host: Host, uri: string): Promise<void> {
  const notebookPath = sourcePath(uri);
  const serialized = await readText(host.cache, sidecarPath(uri, ARTIFACT_SUFFIX));
  if ((await staleReason(host, uri, await notebookHash(serialized))) === undefined) return;
  const nb = parseNotebookHtml(serialized, host.dom);

  const pins = await resolveNotebook(nb, { moduleServer: host.resolver }, notebookPath);
  const cells = transpileNotebook(nb, pins);
  assertDistinctOutputs(cells, notebookPath);
  const runtimeUrl = await runtimeUrlOf(host);
  const page = renderPage(nb, cells, {
    runtimeUrl,
    ...(host.stylesUrl === undefined ? {} : { stylesUrl: host.stylesUrl }),
  });
  const assets = await copyAttachments(nb, host.notebooks, host.output, notebookPath);

  const pagePathOf = pagePath(uri);
  await writeText(host.output, pagePathOf, page);
  await writeManifest(host, uri, {
    page: pagePathOf,
    assets: assets.map((a) => a.path),
    deps: [],
  });

  let deps: string[] = [];
  if (host.mode === "static") {
    deps = await materializeDeps(
      new Map([...pins, [RUNTIME_SPECIFIER, runtimeUrl]]) as PinMap,
      host.moduleServer,
      host.output,
      host.basePath,
    );
    await writeManifest(host, uri, {
      page: pagePathOf,
      assets: assets.map((a) => a.path),
      deps,
    });
  }

  await writeState(host, uri, {
    hash: await notebookHash(serialized),
    configHash: host.configHash,
    pins: Object.fromEntries([...pins, [RUNTIME_SPECIFIER, runtimeUrl]]),
    attachments: Object.fromEntries(assets.map((a) => [a.path, a.hash])),
  });
  // The closure is part of what changed: a deploy driven off `changed` that uploads the page
  // and none of its dependencies publishes a site whose every module 404s.
  for (const path of [pagePathOf, ...assets.map((a) => a.path), ...deps]) host.changed.add(path);
}

/**
 * Two cells declaring the same name is not a style question: notebook-kit's runtime refuses the
 * second definition of a variable, so the page half-runs — the offending cell and everything
 * downstream of it stay empty while the rest looks fine. It is the author's mistake, and it was
 * being published silently.
 */
function assertDistinctOutputs(cells: CellDefinition[], notebookPath: string): void {
  const owner = new Map<string, number>();
  for (const cell of cells) {
    if (cell.error) continue;
    for (const name of cell.outputs) {
      const first = owner.get(name);
      if (first !== undefined) {
        throw new Error(
          `${notebookPath}: "${name}" is declared by two cells (cell ${first} and cell ${cell.id})`,
        );
      }
      owner.set(name, cell.id);
    }
  }
}

function writeManifest(host: Host, uri: string, manifest: Manifest): Promise<void> {
  return writeText(host.cache, sidecarPath(uri, MANIFEST_SUFFIX), JSON.stringify(manifest));
}

function writeState(host: Host, uri: string, state: NotebookState): Promise<void> {
  return writeText(host.cache, sidecarPath(uri, STATE_SUFFIX), JSON.stringify(state));
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
  for (const suffix of [ARTIFACT_SUFFIX, STATE_SUFFIX, MANIFEST_SUFFIX]) {
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
          // A `sources` entry outlives the file: the scanner emits `sources-removed` on a
          // deletion but leaves the old `sources` entry in the store, and `restartFrom` replays
          // it. Reading it back would report a deleted notebook as a build failure, for ever.
          if (
            NOTEBOOK_EXT.test(update.uri) &&
            (await host.notebooks.exists(sourcePath(update.uri)))
          ) {
            try {
              const collisions = await collidingSources(host, update.uri);
              if (collisions.length > 0) {
                throw new Error(
                  `${sourcePath(update.uri)}: ${[sourcePath(update.uri), ...collisions].join(
                    " and ",
                  )} all publish to ${pagePath(update.uri)} — rename all but one`,
                );
              }
              const text = await readText(host.notebooks, sourcePath(update.uri));
              const serialized = serializeNotebook(
                parseSource(text, update.uri, host.dom),
                host.dom,
              );
              if (
                (await staleReason(host, update.uri, await notebookHash(serialized))) !== undefined
              ) {
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
  if (notebooks === cache || notebooks === output || output === cache) {
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
    ...(options.stylesUrl === undefined ? {} : { stylesUrl: options.stylesUrl }),
    logger,
    configHash: "",
    resolver: memoizingResolver(options.moduleServer),
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
      host.resolver.reset();
      host.configHash = await configHashOf(options);
      host.rootsChecked ??= assertDistinctRoots(host);
      await host.rootsChecked;
      // Before the engine's mtime scanner gets a say: everything else the pages depend on.
      await revalidate(host);
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
