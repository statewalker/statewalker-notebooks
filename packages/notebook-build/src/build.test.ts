import { type FilesApi, readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { newNotebookBuild } from "./build.js";
import type { ModuleServerLike } from "./deps.js";
import type { ModuleRef } from "./resolve.js";

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
});
