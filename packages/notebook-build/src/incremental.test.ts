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
  extra: { moduleServer?: ModuleServerLike; onFailed?: (f: NotebookFailure[]) => void } = {},
) =>
  newNotebookBuild({
    notebooks,
    output,
    cache: new MemFilesApi(),
    moduleServer: extra.moduleServer ?? fakeServer(),
    dom: nodeDom(),
    mode: "hosted",
    ...(extra.onFailed ? { onFailed: extra.onFailed } : {}),
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
});
