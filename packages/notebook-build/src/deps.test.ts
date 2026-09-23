import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { ASSET_EXTENSIONS, materializeDeps } from "./deps.js";

/** Mirrors the real shape: listResources returns only the JS-reachable graph. */
const fakeServer = () => ({
  resolve: async () => ({ url: "/_m/duck@1/dist/duckdb-browser.mjs", target: "browser" as const }),
  listResources: async () => ["/_m/duck@1/dist/duckdb-browser.mjs", "/_m/duck@1/dist/helper.js"],
  listPackageFiles: async () => [
    "dist/duckdb-browser.mjs",
    "dist/helper.js",
    "dist/duckdb-eh.wasm",
    "dist/duckdb-mvp.wasm",
    "README.md",
  ],
  fetch: async (req: Request) =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        "content-type": new URL(req.url).pathname.endsWith(".wasm")
          ? "application/wasm"
          : "text/javascript",
      },
    }),
});

/**
 * A scoped package — `@duckdb/duckdb-wasm` is the exact motivating case named in
 * `deps.ts`'s own docstring. Its resolved URL puts a scope segment (`@duckdb/`) before
 * the `{name}@{version}` segment, so "take the first slash after basePath" lands on the
 * scope boundary, not the version boundary.
 */
const fakeScopedServer = () => ({
  resolve: async () => ({
    url: "/_m/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browser.mjs",
    target: "browser" as const,
  }),
  listResources: async () => [
    "/_m/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browser.mjs",
    "/_m/@duckdb/duckdb-wasm@1.29.0/dist/helper.js",
  ],
  listPackageFiles: async () => [
    "dist/duckdb-browser.mjs",
    "dist/helper.js",
    "dist/duckdb-eh.wasm",
    "README.md",
  ],
  fetch: async (req: Request) =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        "content-type": new URL(req.url).pathname.endsWith(".wasm")
          ? "application/wasm"
          : "text/javascript",
      },
    }),
});

describe("materializeDeps", () => {
  it("writes every JS-reachable module", async () => {
    const output = new MemFilesApi();
    await materializeDeps(
      new Map([["npm:duck", "/_m/duck@1/dist/duckdb-browser.mjs"]]),
      fakeServer() as never,
      output,
      "/_m/",
    );
    expect(await output.exists("/_m/duck@1/dist/duckdb-browser.mjs")).toBe(true);
    expect(await output.exists("/_m/duck@1/dist/helper.js")).toBe(true);
  });

  // (3) the defect that makes a static export silently broken
  it("also writes side-car assets that listResources omits", async () => {
    const output = new MemFilesApi();
    const written = await materializeDeps(
      new Map([["npm:duck", "/_m/duck@1/dist/duckdb-browser.mjs"]]),
      fakeServer() as never,
      output,
      "/_m/",
    );
    expect(await output.exists("/_m/duck@1/dist/duckdb-eh.wasm")).toBe(true);
    expect(await output.exists("/_m/duck@1/dist/duckdb-mvp.wasm")).toBe(true);
    expect(written).toContain("/_m/duck@1/dist/duckdb-eh.wasm");
  });

  it("does not copy non-asset files such as README.md", async () => {
    const output = new MemFilesApi();
    await materializeDeps(
      new Map([["npm:duck", "/_m/duck@1/dist/duckdb-browser.mjs"]]),
      fakeServer() as never,
      output,
      "/_m/",
    );
    expect(await output.exists("/_m/duck@1/README.md")).toBe(false);
  });

  it("covers every extension class the stdlib libraries need", () => {
    expect(ASSET_EXTENSIONS).toEqual(expect.arrayContaining([".wasm", ".woff2", ".css"]));
  });

  it("writes nothing when there are no pins", async () => {
    const output = new MemFilesApi();
    expect(await materializeDeps(new Map(), fakeServer() as never, output, "/_m/")).toEqual([]);
  });

  it("skips a non-npm pin instead of throwing a confusing error", async () => {
    const output = new MemFilesApi();
    const written = await materializeDeps(
      new Map([["./local-helper.js", "/local-helper.js"]]),
      fakeServer() as never,
      output,
      "/_m/",
    );
    expect(written).toEqual([]);
  });

  // The defect this guards against: computing the package root as "first slash after
  // basePath" lands on the scope separator for a scoped package, not the version
  // boundary, and requests a bogus URL that 404s against a real server.
  it("computes the correct package root for a scoped package", async () => {
    const output = new MemFilesApi();
    const written = await materializeDeps(
      new Map([
        ["npm:@duckdb/duckdb-wasm", "/_m/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browser.mjs"],
      ]),
      fakeScopedServer() as never,
      output,
      "/_m/",
    );
    expect(await output.exists("/_m/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-eh.wasm")).toBe(true);
    expect(written).toContain("/_m/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-eh.wasm");
    expect(written).not.toContain("/_m/@duckdb/dist/duckdb-eh.wasm");
  });

  it("throws naming the offending URL when the package root cannot be parsed", async () => {
    const output = new MemFilesApi();
    const badServer = {
      ...fakeServer(),
      resolve: async () => ({ url: "/_m/not-a-package-root", target: "browser" as const }),
    };
    await expect(
      materializeDeps(
        new Map([["npm:duck", "/_m/not-a-package-root"]]),
        badServer as never,
        output,
        "/_m/",
      ),
    ).rejects.toThrow(/not-a-package-root/);
  });
});
