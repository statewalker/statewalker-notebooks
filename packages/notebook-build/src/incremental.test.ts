import {
  type FileStats,
  type FilesApi,
  type ListOptions,
  type ReadOptions,
  readText,
  writeText,
} from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { type NotebookFailure, newNotebookBuild } from "./build.js";
import type { ModuleServerLike } from "./deps.js";
import type { ModuleRef } from "./resolve.js";

/** Under Node there is no DOM; the browser injects its own natives instead. */
function nodeDom() {
  const { window } = new JSDOM("<!doctype html>");
  return { document: window.document, parser: new window.DOMParser() };
}

const fakeServer = (): ModuleServerLike => ({
  resolve: async (ref: ModuleRef) => ({ url: `/_m/${ref.pkg}@1/index.js`, target: "browser" }),
  listResources: async () => [],
  listPackageFiles: async () => [],
  fetch: async () => new Response("", { status: 200 }),
});

/**
 * A `FilesApi` that records the path of every `write`. mtime comparison alone cannot
 * distinguish "not rewritten" from "rewritten within the same millisecond"; this
 * observes the write itself, so the incrementality claim does not rest on a clock.
 */
function recordingFiles(inner: FilesApi): { api: FilesApi; writes: string[] } {
  const writes: string[] = [];
  const api: FilesApi = {
    read: (path: string, options?: ReadOptions) => inner.read(path, options),
    write: async (path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) => {
      writes.push(path);
      await inner.write(path, content);
    },
    mkdir: (path: string) => inner.mkdir(path),
    list: (path: string, options?: ListOptions) => inner.list(path, options),
    stats: (path: string) => inner.stats(path),
    exists: (path: string) => inner.exists(path),
    remove: (path: string) => inner.remove(path),
    move: (source: string, target: string) => inner.move(source, target),
    copy: (source: string, target: string) => inner.copy(source, target),
  };
  return { api, writes };
}

/**
 * A `FilesApi` whose `write` fails for the paths `shouldFail` selects. The point is to fail
 * the build at one exact stage — the page write — which no module-server stub can reach.
 */
function failingFiles(inner: FilesApi, shouldFail: (path: string) => boolean): FilesApi {
  return {
    ...inner,
    read: (path: string, options?: ReadOptions) => inner.read(path, options),
    write: async (path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) => {
      if (shouldFail(path)) throw new Error(`write refused: ${path}`);
      await inner.write(path, content);
    },
    list: (path: string, options?: ListOptions) => inner.list(path, options),
    stats: (path: string) => inner.stats(path),
    exists: (path: string) => inner.exists(path),
    remove: (path: string) => inner.remove(path),
  };
}

async function mtime(files: FilesApi, path: string): Promise<number> {
  const stats: FileStats | undefined = await files.stats(path);
  if (stats?.kind !== "file") throw new Error(`no such file: ${path}`);
  return stats.lastModified;
}

/** MemFilesApi stamps lastModified with Date.now(); a few ms guarantees a distinct mtime. */
const tick = () => new Promise((r) => setTimeout(r, 5));

async function seed() {
  const notebooks = new MemFilesApi();
  await writeText(notebooks, "/a.md", "# A\n\n```js\nconst x = 1;\n```\n");
  await writeText(notebooks, "/b.md", "# B\n\n```js\nconst y = 2;\n```\n");
  return notebooks;
}

const build = (
  notebooks: FilesApi,
  output: FilesApi,
  extra: {
    cache?: FilesApi;
    moduleServer?: ModuleServerLike;
    onFailed?: (f: NotebookFailure[]) => void;
    onRebuilt?: (changed: string[]) => void;
    mode?: "hosted" | "static";
    stylesUrl?: string;
  } = {},
) =>
  newNotebookBuild({
    notebooks,
    output,
    cache: extra.cache ?? new MemFilesApi(),
    moduleServer: extra.moduleServer ?? fakeServer(),
    dom: nodeDom(),
    mode: extra.mode ?? "hosted",
    ...(extra.onFailed ? { onFailed: extra.onFailed } : {}),
    ...(extra.onRebuilt ? { onRebuilt: extra.onRebuilt } : {}),
    ...(extra.stylesUrl ? { stylesUrl: extra.stylesUrl } : {}),
  });

describe("newNotebookBuild — incremental", () => {
  it("re-renders only the edited notebook", async () => {
    const notebooks = await seed();
    const store = new MemFilesApi();
    const { api: output, writes } = recordingFiles(store);
    const b = build(notebooks, output);
    await b.build();
    const bBefore = await mtime(store, "/b.html");

    writes.length = 0;
    await tick();
    await writeText(notebooks, "/a.md", "# A edited\n\n```js\nconst x = 2;\n```\n");
    await b.build();

    expect(await readText(store, "/a.html")).toContain("A edited");
    expect(writes).toContain("/a.html");
    expect(writes).not.toContain("/b.html");
    expect(await mtime(store, "/b.html")).toBe(bBefore);
  });

  it("reuses the artifact when an mtime bump carries identical content", async () => {
    const notebooks = await seed();
    const store = new MemFilesApi();
    const { api: output, writes } = recordingFiles(store);
    const b = build(notebooks, output);
    await b.build();
    const before = await mtime(store, "/a.html");

    writes.length = 0;
    await tick();
    await writeText(notebooks, "/a.md", "# A\n\n```js\nconst x = 1;\n```\n"); // same bytes
    await b.build();

    expect(writes).not.toContain("/a.html");
    expect(await mtime(store, "/a.html")).toBe(before);
    // ...and the artifact is still the real one, not an empty placeholder left behind.
    expect(await readText(store, "/a.html")).toContain('"outputs":["x"]');
  });

  it("prunes the page, the artifact and the attachments of a deleted notebook", async () => {
    const notebooks = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(notebooks, "/x.md", '# X\n\n```js\nFileAttachment("d.csv");\n```\n');
    await writeText(notebooks, "/d.csv", "a\n");
    const b = build(notebooks, output);
    await b.build();
    expect(await output.exists("/x.html")).toBe(true);
    expect(await output.exists("/d.csv")).toBe(true);

    await tick();
    await notebooks.remove("/x.md");
    await b.build();

    expect(await output.exists("/x.html")).toBe(false);
    expect(await output.exists("/d.csv")).toBe(false);
  });

  it("keeps an attachment a surviving notebook still references", async () => {
    const notebooks = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(notebooks, "/x.md", '# X\n\n```js\nFileAttachment("shared.csv");\n```\n');
    await writeText(notebooks, "/keep.md", '# Keep\n\n```js\nFileAttachment("shared.csv");\n```\n');
    await writeText(notebooks, "/shared.csv", "a\n");
    const b = build(notebooks, output);
    await b.build();
    expect(await output.exists("/shared.csv")).toBe(true);

    await tick();
    await notebooks.remove("/x.md");
    await b.build();

    expect(await output.exists("/x.html")).toBe(false);
    expect(await output.exists("/keep.html")).toBe(true);
    // keep.md is unchanged, so the hash gate skips it — nothing will re-copy the
    // attachment. A prune that ignored the other notebooks would delete it forever.
    expect(await output.exists("/shared.csv")).toBe(true);
  });

  it("builds the healthy notebooks when one fails to resolve", async () => {
    const notebooks = await seed();
    await writeText(
      notebooks,
      "/bad.md",
      '# Bad\n\n```js\nimport x from "npm:does-not-exist";\n```\n',
    );
    const output = new MemFilesApi();
    const failing: ModuleServerLike = {
      ...fakeServer(),
      resolve: async (ref: ModuleRef) => {
        if (ref.pkg === "does-not-exist") throw new Error("404");
        return { url: `/_m/${ref.pkg}@1/index.js`, target: "browser" };
      },
    };
    const failures: NotebookFailure[][] = [];
    const b = build(notebooks, output, {
      moduleServer: failing,
      onFailed: (f) => failures.push(f),
    });
    await b.build();
    expect(await output.exists("/a.html")).toBe(true);
    expect(await output.exists("/b.html")).toBe(true);
    expect(await output.exists("/bad.html")).toBe(false);
    // The failure is surfaced after convergence, not swallowed.
    expect(failures.at(-1)?.map((f) => f.notebookPath)).toEqual(["/bad.md"]);
    expect(String(failures.at(-1)?.[0]?.error)).toContain("does-not-exist");
  });

  it("re-renders a notebook that failed once its resolution starts working", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nimport x from "npm:flaky";\n```\n');
    const output = new MemFilesApi();
    let broken = true;
    const server: ModuleServerLike = {
      ...fakeServer(),
      resolve: async (ref: ModuleRef) => {
        if (broken) throw new Error("registry down");
        return { url: `/_m/${ref.pkg}@1/index.js`, target: "browser" };
      },
    };
    const b = build(notebooks, output, { moduleServer: server });
    await b.build();
    expect(await output.exists("/n.html")).toBe(false);

    // The bytes are identical; only the server has recovered. A gate that recorded the
    // hash for a notebook that never rendered would skip this one forever.
    broken = false;
    await tick();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nimport x from "npm:flaky";\n```\n');
    await b.build();
    expect(await output.exists("/n.html")).toBe(true);
  });

  it("does not serve a stale page after a failed edit is retried", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# V1\n\n```js\nimport x from "npm:flaky";\n```\n');
    const output = new MemFilesApi();
    let broken = false;
    const server: ModuleServerLike = {
      ...fakeServer(),
      resolve: async (ref: ModuleRef) => {
        if (broken) throw new Error("registry down");
        return { url: `/_m/${ref.pkg}@1/index.js`, target: "browser" };
      },
    };
    const b = build(notebooks, output, { moduleServer: server });
    await b.build();
    expect(await readText(output, "/n.html")).toContain("V1");

    // v2 is authored while the server is down: the render fails and v1 keeps serving.
    broken = true;
    await tick();
    await writeText(notebooks, "/n.md", '# V2\n\n```js\nimport x from "npm:flaky";\n```\n');
    await b.build();
    expect(await readText(output, "/n.html")).toContain("V1");

    // The server recovers and the source is touched with the SAME v2 bytes. Recording
    // the hash when the notebook is serialized rather than when it is rendered makes
    // this look already-built — and /n.html would serve v1 for ever.
    broken = false;
    await tick();
    await writeText(notebooks, "/n.md", '# V2\n\n```js\nimport x from "npm:flaky";\n```\n');
    await b.build();
    expect(await readText(output, "/n.html")).toContain("V2");
    expect(await readText(output, "/n.html")).not.toContain("V1");
  });

  it("skips a source edit that serializes to the same notebook", async () => {
    const notebooks = new MemFilesApi();
    const store = new MemFilesApi();
    const { api: output, writes } = recordingFiles(store);
    await writeText(notebooks, "/n.md", "# N\n\n```js\nconst x = 1;\n```\n");
    const b = build(notebooks, output);
    await b.build();

    writes.length = 0;
    await tick();
    // Different bytes, same notebook: an extra blank line before the fence and a
    // trailing space on the heading are both dropped by the Markdown parse, so the
    // serialized document — what the gate hashes — is byte-identical. A gate that
    // hashed the SOURCE would re-render here.
    await writeText(notebooks, "/n.md", "# N \n\n\n```js\nconst x = 1;\n```\n");
    await b.build();

    expect(writes).not.toContain("/n.html");
  });

  it("prunes outputs recorded before a later stage failed", async () => {
    const notebooks = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nFileAttachment("d.csv");\n```\n');
    await writeText(notebooks, "/d.csv", "a\n");
    // A transient closure failure: resolution works, materializing it does not. The page
    // and its attachment are already written by then.
    const server: ModuleServerLike = {
      ...fakeServer(),
      listResources: async () => {
        throw new Error("closure unavailable");
      },
    };
    const b = build(notebooks, output, { moduleServer: server, mode: "static" });
    await b.build();
    expect(await output.exists("/n.html")).toBe(true);
    expect(await output.exists("/d.csv")).toBe(true);

    await tick();
    await notebooks.remove("/n.md");
    await b.build();

    // Nothing records an output that no manifest mentions, so it would live in the
    // output for ever.
    expect(await output.exists("/n.html")).toBe(false);
    expect(await output.exists("/d.csv")).toBe(false);
  });

  it("prunes the dependency closure of the last notebook that needed it", async () => {
    const notebooks = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nimport * as d3 from "d3";\n```\n');
    const server: ModuleServerLike = {
      ...fakeServer(),
      listResources: async (ref: ModuleRef) => [`/_m/${ref.pkg}@1/index.js`],
      fetch: async () => new Response("//module\n", { status: 200 }),
    };
    const b = build(notebooks, output, { moduleServer: server, mode: "static" });
    await b.build();
    expect(await output.exists("/_m/d3@1/index.js")).toBe(true);
    expect(await output.exists("/_m/@observablehq/notebook-kit@1/index.js")).toBe(true);

    await tick();
    await notebooks.remove("/n.md");
    await b.build();

    expect(await output.exists("/n.html")).toBe(false);
    expect(await output.exists("/_m/d3@1/index.js")).toBe(false);
    expect(await output.exists("/_m/@observablehq/notebook-kit@1/index.js")).toBe(false);
  });
});

/**
 * The gate used to key on the notebook's bytes and nothing else, and it treated that single
 * trigger as sufficient for every input the output actually depends on. Each case below was
 * reproduced against the old build: the source is never touched, and the page is wrong.
 */
describe("newNotebookBuild — what invalidates a built page", () => {
  it("re-renders every notebook when the stylesheet URL changes", async () => {
    const notebooks = await seed();
    const output = new MemFilesApi();
    const cache = new MemFilesApi();
    await build(notebooks, output, { cache, stylesUrl: "/v1.css" }).build();
    expect(await readText(output, "/a.html")).toContain('href="/v1.css"');

    await build(notebooks, output, { cache, stylesUrl: "/v2.css" }).build();
    expect(await readText(output, "/a.html")).toContain('href="/v2.css"');
    expect(await readText(output, "/b.html")).toContain('href="/v2.css"');
  });

  it("materializes the closure when the mode changes from hosted to static", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nimport * as d3 from "d3";\n```\n');
    const output = new MemFilesApi();
    const cache = new MemFilesApi();
    const server: ModuleServerLike = {
      ...fakeServer(),
      listResources: async (ref: ModuleRef) => [`/_m/${ref.pkg}@1/index.js`],
      fetch: async () => new Response("//module\n", { status: 200 }),
    };
    await build(notebooks, output, { cache, moduleServer: server, mode: "hosted" }).build();
    expect(await output.exists("/_m/d3@1/index.js")).toBe(false);

    await build(notebooks, output, { cache, moduleServer: server, mode: "static" }).build();
    expect(await output.exists("/_m/d3@1/index.js")).toBe(true);
  });

  it("re-pins a dependency that the server now resolves elsewhere", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nimport * as d3 from "d3";\n```\n');
    const output = new MemFilesApi();
    let version = 1;
    const server: ModuleServerLike = {
      ...fakeServer(),
      resolve: async (ref: ModuleRef) => ({
        url: `/_m/${ref.pkg}@${version}/index.js`,
        target: "browser",
      }),
    };
    const b = build(notebooks, output, { moduleServer: server });
    await b.build();
    expect(await readText(output, "/n.html")).toContain("/_m/d3@1/index.js");

    // The dependency was republished; the notebook's own bytes did not move.
    version = 2;
    await b.build();
    expect(await readText(output, "/n.html")).toContain("/_m/d3@2/index.js");
    expect(await readText(output, "/n.html")).not.toContain("/_m/d3@1/index.js");
  });

  it("re-copies an attachment whose content changed", async () => {
    const notebooks = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nFileAttachment("d.csv");\n```\n');
    await writeText(notebooks, "/d.csv", "v1\n");
    const b = build(notebooks, output);
    await b.build();
    expect(await readText(output, "/d.csv")).toBe("v1\n");

    await tick();
    await writeText(notebooks, "/d.csv", "v2\n");
    await b.build();
    expect(await readText(output, "/d.csv")).toBe("v2\n");
  });

  it("restores an output that was deleted from the output tree", async () => {
    const notebooks = await seed();
    const output = new MemFilesApi();
    const b = build(notebooks, output);
    await b.build();

    await output.remove("/a.html");
    await b.build();
    expect(await output.exists("/a.html")).toBe(true);
    expect(await readText(output, "/a.html")).toContain('"outputs":["x"]');
  });

  it("retries a notebook that failed transiently, with no source touch", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nimport x from "npm:flaky";\n```\n');
    const output = new MemFilesApi();
    let broken = true;
    const server: ModuleServerLike = {
      ...fakeServer(),
      resolve: async (ref: ModuleRef) => {
        if (broken) throw new Error("registry down");
        return { url: `/_m/${ref.pkg}@1/index.js`, target: "browser" };
      },
    };
    const failures: NotebookFailure[][] = [];
    const changed: string[][] = [];
    const b = build(notebooks, output, {
      moduleServer: server,
      onFailed: (f) => failures.push(f),
      onRebuilt: (c) => changed.push(c),
    });
    await b.build();
    expect(await output.exists("/n.html")).toBe(false);

    // The operator re-runs the build after the registry recovers. Nothing in the sources
    // moved — and the old build reported `failures: []`, `changed: []` and no page, so a CI
    // gate on `onFailed` would have shipped a site with a missing page.
    broken = false;
    await b.build();
    expect(await output.exists("/n.html")).toBe(true);
    expect(failures.at(-1)).toHaveLength(1);
    expect(changed.at(-1)).toContain("/n.html");
  });

  it("retries a notebook whose closure failed to materialize, with no source touch", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nimport * as d3 from "d3";\n```\n');
    const output = new MemFilesApi();
    let broken = true;
    const server: ModuleServerLike = {
      ...fakeServer(),
      listResources: async (ref: ModuleRef) => {
        if (broken) throw new Error("closure unavailable");
        return [`/_m/${ref.pkg}@1/index.js`];
      },
      fetch: async () => new Response("//module\n", { status: 200 }),
    };
    const b = build(notebooks, output, { moduleServer: server, mode: "static" });
    await b.build();
    // In static mode the page is written before the closure, so the site exists and is dead.
    expect(await output.exists("/n.html")).toBe(true);
    expect(await output.exists("/_m/d3@1/index.js")).toBe(false);

    broken = false;
    await b.build();
    expect(await output.exists("/_m/d3@1/index.js")).toBe(true);
  });

  it("reports the materialized closure among the changed paths", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nimport * as d3 from "d3";\n```\n');
    const output = new MemFilesApi();
    const server: ModuleServerLike = {
      ...fakeServer(),
      listResources: async (ref: ModuleRef) => [`/_m/${ref.pkg}@1/index.js`],
      fetch: async () => new Response("//module\n", { status: 200 }),
    };
    const changed: string[][] = [];
    await build(notebooks, output, {
      moduleServer: server,
      mode: "static",
      onRebuilt: (c) => changed.push(c),
    }).build();
    // A deploy driven off `changed` uploads the page and none of its dependencies otherwise.
    expect(changed.at(-1)).toContain("/n.html");
    expect(changed.at(-1)).toContain("/_m/d3@1/index.js");
  });
});

/**
 * The state sidecar is the record "this exact serialization WAS rendered", so it must be the
 * last thing a render writes. Written any earlier, a later stage's failure leaves a record
 * claiming success and the notebook is never re-derived — the previous version serves for ever.
 *
 * Only one stage of four used to be guarded (`resolveNotebook`, which precedes every candidate
 * insertion point), so moving the write to just after `copyAttachments` or to just after the
 * page write left all 73 tests green. Each case below edits v1 to v2, fails at one stage,
 * then repairs the world WITHOUT touching the source and demands v2.
 */
describe("newNotebookBuild — the successful-render record is written last", () => {
  const V1 = '# V1\n\n```js\nFileAttachment("d.csv");\n```\n';
  const V2 = '# V2\n\n```js\nFileAttachment("d.csv");\n```\n';

  it("does not record a render whose attachments failed to copy", async () => {
    const notebooks = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(notebooks, "/n.md", V1);
    await writeText(notebooks, "/d.csv", "a\n");
    const b = build(notebooks, output);
    await b.build();
    expect(await readText(output, "/n.html")).toContain("V1");

    await tick();
    await writeText(notebooks, "/n.md", V2);
    await notebooks.remove("/d.csv");
    await b.build();
    expect(await readText(output, "/n.html")).toContain("V1");

    await writeText(notebooks, "/d.csv", "a\n");
    await b.build();
    expect(await readText(output, "/n.html")).toContain("V2");
  });

  it("does not record a render whose page failed to write", async () => {
    const notebooks = new MemFilesApi();
    const store = new MemFilesApi();
    let refuse = false;
    const output = failingFiles(store, (path) => refuse && path === "/n.html");
    await writeText(notebooks, "/n.md", V1);
    await writeText(notebooks, "/d.csv", "a\n");
    const b = build(notebooks, output);
    await b.build();
    expect(await readText(store, "/n.html")).toContain("V1");

    // v2 renders and its attachment copies; only the page write fails. A record written
    // anywhere before this point claims v2 was published while /n.html still holds v1.
    refuse = true;
    await tick();
    await writeText(notebooks, "/n.md", V2);
    await b.build();
    expect(await readText(store, "/n.html")).toContain("V1");

    refuse = false;
    await b.build();
    expect(await readText(store, "/n.html")).toContain("V2");
  });

  it("does not record a render whose closure failed to materialize", async () => {
    const notebooks = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# V1\n\n```js\nimport * as d3 from "d3";\n```\n');
    let broken = false;
    const server: ModuleServerLike = {
      ...fakeServer(),
      listResources: async (ref: ModuleRef) => {
        if (broken) throw new Error("closure unavailable");
        return [`/_m/${ref.pkg}@1/index.js`];
      },
      fetch: async () => new Response("//module\n", { status: 200 }),
    };
    const b = build(notebooks, output, { moduleServer: server, mode: "static" });
    await b.build();
    expect(await readText(output, "/n.html")).toContain("V1");

    // The page and the manifest are both written before the closure, so this is the case a
    // record written "after the page" or "after the manifest" cannot survive: everything the
    // gate looks at is present and only the closure is missing.
    // v2 pulls in a SECOND package, so "the closure was materialized" is a question about
    // v2's closure and not one v1 already answered.
    broken = true;
    await tick();
    await writeText(
      notebooks,
      "/n.md",
      '# V2\n\n```js\nimport * as d3 from "d3";\nimport * as p from "plot";\n```\n',
    );
    await b.build();
    expect(await output.exists("/_m/plot@1/index.js")).toBe(false);

    broken = false;
    await b.build();
    expect(await readText(output, "/n.html")).toContain("V2");
    expect(await output.exists("/_m/plot@1/index.js")).toBe(true);
  });
});

/**
 * `restartFrom(NOTEBOOK_CELL)` clears the handled markers of the whole downstream closure, so
 * `[Page]` replays the `notebook` update of a notebook that has since been deleted — and its
 * `sources-removed` tombstone was consumed builds ago, so no prune will ever undo it again.
 *
 * Two builds cannot reach this: the resurrection needs a THIRD build, one where something
 * unrelated makes `revalidate` restart the pipeline. The triggers are ordinary — a new
 * notebook, an edited attachment, any configuration change, or any notebook currently failing.
 */
describe("newNotebookBuild — a deleted notebook stays deleted", () => {
  it("does not resurrect a pruned notebook when a later build revalidates", async () => {
    const notebooks = await seed();
    const output = new MemFilesApi();
    const failures: NotebookFailure[][] = [];
    const b = build(notebooks, output, { onFailed: (f) => failures.push(f) });
    await b.build();
    expect(await output.exists("/b.html")).toBe(true);

    await tick();
    await notebooks.remove("/b.md");
    await b.build();
    expect(await output.exists("/b.html")).toBe(false);

    // Build three. Nothing about /b.md is involved: a brand-new notebook is what makes
    // `revalidate` restart the pipeline.
    await tick();
    await writeText(notebooks, "/c.md", "# C\n\n```js\nconst z = 3;\n```\n");
    await b.build();

    expect(await output.exists("/c.html")).toBe(true);
    expect(await output.exists("/b.html")).toBe(false);
    expect(failures.at(-1) ?? []).toEqual([]);
  });

  it("does not resurrect a pruned notebook when a failing one keeps revalidating", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/keep.md", '# Keep\n\n```js\nimport x from "npm:flaky";\n```\n');
    await writeText(notebooks, "/gone.md", "# Gone\n\n```js\nconst y = 2;\n```\n");
    const output = new MemFilesApi();
    const server: ModuleServerLike = {
      ...fakeServer(),
      resolve: async (ref: ModuleRef) => {
        if (ref.pkg === "flaky") throw new Error("registry down");
        return { url: `/_m/${ref.pkg}@1/index.js`, target: "browser" };
      },
    };
    const b = build(notebooks, output, { moduleServer: server, onFailed: () => {} });
    await b.build();
    expect(await output.exists("/gone.html")).toBe(true);

    await tick();
    await notebooks.remove("/gone.md");
    await b.build();
    expect(await output.exists("/gone.html")).toBe(false);

    // `/keep.md` fails on every build, so every build revalidates — and every build used to
    // put `/gone.html` back.
    await b.build();
    await b.build();
    expect(await output.exists("/gone.html")).toBe(false);
  });

  it("fails loudly instead of publishing a blank page when the artifact reads empty", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", "# V1\n\n```js\nconst x = 1;\n```\n");
    const output = new MemFilesApi();
    const store = new MemFilesApi();
    let emptied = false;
    // `readText` returns "" for a file that is not there — it does not throw. That silent
    // conversion is what turned a pruned artifact into an empty, `Untitled` notebook.
    const cache: FilesApi = {
      read: (path: string, options?: ReadOptions) =>
        emptied && path.endsWith(".nb.html")
          ? (async function* () {})()
          : store.read(path, options),
      write: (path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) =>
        store.write(path, content),
      mkdir: (path: string) => store.mkdir(path),
      list: (path: string, options?: ListOptions) => store.list(path, options),
      stats: (path: string) => store.stats(path),
      exists: (path: string) => store.exists(path),
      remove: (path: string) => store.remove(path),
      move: (from: string, to: string) => store.move(from, to),
      copy: (from: string, to: string) => store.copy(from, to),
    };
    const failures: NotebookFailure[][] = [];
    const b = build(notebooks, output, { cache, onFailed: (f) => failures.push(f) });
    await b.build();
    expect(await readText(output, "/n.html")).toContain("V1");

    emptied = true;
    await tick();
    await writeText(notebooks, "/n.md", "# V2\n\n```js\nconst x = 1;\n```\n");
    await b.build();

    expect(failures.at(-1)?.map((f) => f.notebookPath)).toEqual(["/n.md"]);
    expect(String(failures.at(-1)?.[0]?.error)).toMatch(/empty|artifact/i);
    // V1 keeps serving: what must never happen is a blank `Untitled` page replacing it.
    expect(await readText(output, "/n.html")).toContain("V1");
    expect(await readText(output, "/n.html")).not.toContain("Untitled");
  });

  it("restores a closure file deleted from the output tree", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nimport * as d3 from "d3";\n```\n');
    const output = new MemFilesApi();
    const server: ModuleServerLike = {
      ...fakeServer(),
      listResources: async (ref: ModuleRef) => [`/_m/${ref.pkg}@1/index.js`],
      fetch: async () => new Response("//module\n", { status: 200 }),
    };
    const b = build(notebooks, output, { moduleServer: server, mode: "static" });
    await b.build();
    expect(await output.exists("/_m/d3@1/index.js")).toBe(true);

    // A partially wiped or partially deployed `/_m/` is a dead static site, and it used to
    // pass as a green no-op build — the same defect as a deleted page, one output class over.
    await output.remove("/_m/d3@1/index.js");
    await b.build();
    expect(await output.exists("/_m/d3@1/index.js")).toBe(true);
  });
});
