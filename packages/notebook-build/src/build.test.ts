import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toNotebook } from "@observablehq/notebook-kit";
import { type FilesApi, readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { type NotebookFailure, newNotebookBuild } from "./build.js";
import type { ModuleServerLike } from "./deps.js";
import { parseMarkdown } from "./md-parse.js";
import type { ModuleRef } from "./resolve.js";
import { serializeNotebook } from "./serialize.js";

/** Under Node there is no DOM; the browser injects its own natives instead. */
function nodeDom() {
  const { window } = new JSDOM("<!doctype html>");
  return { document: window.document, parser: new window.DOMParser() };
}

/**
 * A module server that records every call, so a test can assert what the build asked
 * of it — in particular that the expensive `[Deps]` stage did NOT run in hosted mode.
 * `listResources`/`listPackageFiles` answer for any package, so a scoped name
 * (`@observablehq/notebook-kit`) goes through the same path an unscoped one does.
 */
function fakeServer() {
  const calls: string[] = [];
  const server: ModuleServerLike = {
    resolve: async (ref: ModuleRef) => {
      calls.push(`resolve ${ref.pkg}`);
      return { url: `/_m/${ref.pkg}@1/index.js`, target: "browser" };
    },
    listResources: async (ref: ModuleRef) => {
      calls.push(`listResources ${ref.pkg}`);
      return [`/_m/${ref.pkg}@1/index.js`];
    },
    listPackageFiles: async (ref: ModuleRef) => {
      calls.push(`listPackageFiles ${ref.pkg}`);
      return ["dist/style.css", "dist/core.wasm", "README.md"];
    },
    fetch: async (request: Request) => {
      calls.push(`fetch ${new URL(request.url).pathname}`);
      return new Response("//module\n", { status: 200 });
    },
  };
  return { server, calls };
}

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
    onFailed?: (failures: NotebookFailure[]) => void;
    onRebuilt?: (changed: string[]) => void;
    moduleServer?: ModuleServerLike;
    mode?: "hosted" | "static";
    stylesUrl?: string;
  } = {},
) =>
  newNotebookBuild({
    notebooks,
    output,
    cache: new MemFilesApi(),
    moduleServer: extra.moduleServer ?? fakeServer().server,
    dom: nodeDom(),
    mode: extra.mode ?? "hosted",
    ...(extra.onFailed ? { onFailed: extra.onFailed } : {}),
    ...(extra.onRebuilt ? { onRebuilt: extra.onRebuilt } : {}),
    ...(extra.stylesUrl ? { stylesUrl: extra.stylesUrl } : {}),
  });

describe("newNotebookBuild", () => {
  it("emits a page and a standard .html artifact per notebook", async () => {
    const notebooks = await seed();
    const output = new MemFilesApi();
    await build(notebooks, output).build();
    expect(await output.exists("/a.html")).toBe(true);
    expect(await output.exists("/b.html")).toBe(true);
    const page = await readText(output, "/a.html");
    expect(page).toContain("define(");
    // The page is built from THIS notebook, not from whatever happened to be first:
    // b.md's `const y = 2` must not appear on a.html.
    expect(page).toContain('"outputs":["x"]');
    expect(page).not.toContain('"outputs":["y"]');
    expect(await readText(output, "/b.html")).toContain('"outputs":["y"]');
  });

  /**
   * The end-to-end shape of the two defects a widened `CODE_MODES` exposed. A `sql` cell's
   * `${…}` interpolations are compiled as JavaScript by notebook-kit, so both the
   * `FileAttachment` and the dynamic import inside one are real requests the page will make.
   * While `assets.ts` and `resolve.ts` each kept their own narrow copy of the mode set, the
   * build emitted both into the page and published neither: the attachment 404'd, and the
   * specifier reached the browser unresolved as `TypeError: Failed to resolve module
   * specifier`. `read_csv(FileAttachment(...).url())` is the idiomatic DuckDB pattern.
   */
  it("publishes a sql cell's attachment and pins its import", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/sales.csv", "a,b\n1,2\n");
    await writeText(
      notebooks,
      "/q.md",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: `${…}` is notebook-kit SQL-cell interpolation syntax inside notebook SOURCE, not a JS template.
      '# Q\n\n```sql\nSELECT ${(await import("npm:d3-array")).max([1, 2])} FROM read_csv(${await FileAttachment("sales.csv").url()})\n```\n',
    );
    const output = new MemFilesApi();
    const failures: NotebookFailure[] = [];
    const { server, calls } = fakeServer();
    await build(notebooks, output, {
      moduleServer: server,
      onFailed: (f) => failures.push(...f),
    }).build();

    expect(failures).toEqual([]);
    expect(await output.exists("/sales.csv")).toBe(true);
    expect(calls).toContain("resolve d3-array");
    const page = await readText(output, "/q.html");
    expect(page).toContain("/_m/d3-array@1/index.js");
    expect(page).not.toContain('import(\\"npm:d3-array\\")');
  });

  it("notifies with the changed paths on convergence", async () => {
    const notebooks = await seed();
    const changed: string[][] = [];
    await build(notebooks, new MemFilesApi(), { onRebuilt: (c) => changed.push(c) }).build();
    expect(changed.at(-1)).toEqual(expect.arrayContaining(["/a.html", "/b.html"]));
  });

  it("refuses a cache that is the notebooks source itself", () => {
    const notebooks = new MemFilesApi();
    expect(() =>
      newNotebookBuild({
        notebooks,
        output: new MemFilesApi(),
        cache: notebooks,
        moduleServer: fakeServer().server,
        dom: nodeDom(),
      }),
    ).toThrow(/distinct/);
  });

  it("refuses an output that is the cache itself", () => {
    // The sidecars (`.nb.html`, `.hash`, `.outputs.json`) would be published into the
    // static site, so all three must really be distinct — not just two of the pairs.
    const shared = new MemFilesApi();
    expect(() =>
      newNotebookBuild({
        notebooks: new MemFilesApi(),
        output: shared,
        cache: shared,
        moduleServer: fakeServer().server,
        dom: nodeDom(),
      }),
    ).toThrow(/distinct/);
  });

  // The constructor's guard compares instance identity, which three `new NodeFilesApi(...)`
  // over one directory pass while being the same tree: the engine's scanner then finds the
  // sidecars it just wrote, and the static site publishes them.
  it("refuses three distinct instances that are the same directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "nb-roots-"));
    try {
      const b = newNotebookBuild({
        notebooks: new NodeFilesApi({ rootDir: root }),
        output: new NodeFilesApi({ rootDir: root }),
        cache: new NodeFilesApi({ rootDir: root }),
        moduleServer: fakeServer().server,
        dom: nodeDom(),
      });
      await expect(b.build()).rejects.toThrow(/same directory|distinct/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts three instances that really are three directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "nb-roots-"));
    try {
      await newNotebookBuild({
        notebooks: new NodeFilesApi({ rootDir: join(root, "notebooks") }),
        output: new NodeFilesApi({ rootDir: join(root, "out") }),
        cache: new NodeFilesApi({ rootDir: join(root, "cache") }),
        moduleServer: fakeServer().server,
        dom: nodeDom(),
      }).build();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("puts the stylesheet on the page when one is configured", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", "# N\n\n```js\nconst x = 1;\n```\n");
    const output = new MemFilesApi();
    await build(notebooks, output, { stylesUrl: "/_m/notebook-kit@1/index.css" }).build();
    expect(await readText(output, "/n.html")).toContain(
      '<link rel="stylesheet" href="/_m/notebook-kit@1/index.css">',
    );
  });

  it("does not run the deps stage in hosted mode", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nimport * as d3 from "d3";\n```\n');
    const { server, calls } = fakeServer();
    const output = new MemFilesApi();
    await build(notebooks, output, { moduleServer: server, mode: "hosted" }).build();

    expect(await output.exists("/n.html")).toBe(true);
    expect(calls).toContain("resolve d3");
    // The module server is mounted live; materializing its closure is the expensive
    // stage and must not run.
    expect(calls.filter((c) => c.startsWith("listResources"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("fetch"))).toEqual([]);
    expect(await output.exists("/_m/d3@1/index.js")).toBe(false);
  });

  it("materializes the dependency closure in static mode, runtime included", async () => {
    const notebooks = new MemFilesApi();
    await writeText(notebooks, "/n.md", '# N\n\n```js\nimport * as d3 from "d3";\n```\n');
    const { server, calls } = fakeServer();
    const output = new MemFilesApi();
    await build(notebooks, output, { moduleServer: server, mode: "static" }).build();

    expect(calls).toContain("listResources d3");
    expect(await output.exists("/_m/d3@1/index.js")).toBe(true);
    expect(await output.exists("/_m/d3@1/dist/style.css")).toBe(true);
    expect(await output.exists("/_m/d3@1/dist/core.wasm")).toBe(true);
    expect(await output.exists("/_m/d3@1/README.md")).toBe(false);
    // The runtime the page imports is part of the closure too — a static export whose
    // `define` 404s is a blank page. Its name is scoped, so this also exercises the
    // `(@scope/)?name@version` package-root grammar.
    expect(await output.exists("/_m/@observablehq/notebook-kit@1/index.js")).toBe(true);
  });

  // `pagePath` strips the extension and appends `.html`, and `NOTEBOOK_EXT` accepts both `.md`
  // and `.html` — so `/report.md` and `/report.html` both claim `/report.html`. Measured
  // before this check: zero reported failures, one output file, two manifests both claiming
  // the same path. Deleting `report.md` then left `/report.html` serving its content for
  // ever: the survivor's hash was unchanged so it never re-rendered, and the prune correctly
  // refused to remove a path another manifest still claimed.
  it("fails both notebooks when two sources claim the same page path", async () => {
    const notebooks = new MemFilesApi();
    const { window } = new JSDOM("<!doctype html>");
    await writeText(notebooks, "/report.md", "# MD\n\n```js\nconst x = 1;\n```\n");
    await writeText(
      notebooks,
      "/report.html",
      serializeNotebook(parseMarkdown("# HTML\n\n```js\nconst y = 2;\n```\n"), {
        document: window.document,
        parser: new window.DOMParser(),
      }),
    );
    const output = new MemFilesApi();
    const failures: NotebookFailure[][] = [];
    await build(notebooks, output, { onFailed: (f) => failures.push(f) }).build();

    expect(
      failures
        .at(-1)
        ?.map((f) => f.notebookPath)
        .sort(),
    ).toEqual(["/report.html", "/report.md"]);
    // Both source paths are named, so the author knows which two files to reconcile.
    for (const failure of failures.at(-1) ?? []) {
      expect(String(failure.error)).toContain("/report.md");
      expect(String(failure.error)).toContain("/report.html");
    }
    // No winner is picked: neither notebook's content is published under the contested path.
    expect(await output.exists("/report.html")).toBe(false);
  });

  // M7: two cells declaring the same name is not a style question — notebook-kit's runtime
  // refuses the second definition, so the page half-runs. It used to build silently.
  it("fails a notebook whose cells declare the same output name twice", async () => {
    const notebooks = new MemFilesApi();
    await writeText(
      notebooks,
      "/n.md",
      "# N\n\n```js\nconst x = 1;\n```\n\n```js\nconst x = 2;\n```\n",
    );
    const output = new MemFilesApi();
    const failures: NotebookFailure[][] = [];
    await build(notebooks, output, { onFailed: (f) => failures.push(f) }).build();

    expect(failures.at(-1)?.map((f) => f.notebookPath)).toEqual(["/n.md"]);
    expect(String(failures.at(-1)?.[0]?.error)).toMatch(/"x"/);
    expect(await output.exists("/n.html")).toBe(false);
  });

  // The same defect, one output class over. A `sql` cell declares its name through the
  // SINGULAR `output`, not through `outputs`, so a check that reads only `outputs` sees two
  // cells declaring nothing and publishes a page whose second SQL cell — and everything
  // downstream of it — never resolves, with no error anywhere.
  it("fails a notebook whose sql cells declare the same singular output twice", async () => {
    const notebooks = new MemFilesApi();
    await writeText(
      notebooks,
      "/n.html",
      serializeNotebook(
        toNotebook({
          title: "N",
          cells: [
            { id: 1, mode: "sql", value: "SELECT 1", database: "w", output: "rows" },
            { id: 2, mode: "sql", value: "SELECT 2", database: "w", output: "rows" },
          ],
        }),
        nodeDom(),
      ),
    );
    const output = new MemFilesApi();
    const failures: NotebookFailure[][] = [];
    await build(notebooks, output, { onFailed: (f) => failures.push(f) }).build();

    expect(failures.at(-1)?.map((f) => f.notebookPath)).toEqual(["/n.html"]);
    expect(String(failures.at(-1)?.[0]?.error)).toMatch(/"rows"/);
    expect(await output.exists("/n.html")).toBe(false);
  });
});
