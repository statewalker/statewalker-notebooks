import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./md-parse.js";
import { collectSpecifiers, ResolveError, resolveNotebook, toModuleRef } from "./resolve.js";

const nbWith = (...blocks: string[]) =>
  parseMarkdown(`# T\n\n${blocks.map((b) => "```js\n" + b + "\n```").join("\n\n")}\n`);

describe("collectSpecifiers", () => {
  it("finds static, namespace and dynamic imports across all cells", () => {
    const nb = nbWith(
      `import * as Plot from "npm:@observablehq/plot";`,
      `import {csv} from "d3";`,
      `const m = await import("npm:katex");`,
    );
    expect(new Set(collectSpecifiers(nb))).toEqual(
      new Set(["npm:@observablehq/plot", "d3", "npm:katex"]),
    );
  });

  it("returns each specifier once even when several cells import it", () => {
    const nb = nbWith(`import * as d3 from "d3";`, `import {max} from "d3";`);
    expect(collectSpecifiers(nb)).toEqual(["d3"]);
  });

  it("ignores cells that are not code", () => {
    expect(collectSpecifiers(parseMarkdown("# T\n\njust prose\n"))).toEqual([]);
  });
});

describe("toModuleRef", () => {
  it("strips the npm: prefix", () => {
    expect(toModuleRef("npm:d3")).toEqual({ pkg: "d3" });
  });
  it("splits a scoped name with a version and a subpath", () => {
    expect(toModuleRef("npm:@scope/pkg@1.2.3/sub/path")).toEqual({
      pkg: "@scope/pkg",
      version: "1.2.3",
      subpath: "sub/path",
    });
  });
  it("handles a bare name", () => {
    expect(toModuleRef("d3")).toEqual({ pkg: "d3" });
  });
  it("throws for a specifier that is not an npm specifier", () => {
    expect(() => toModuleRef("https://esm.sh/d3")).toThrow();
    expect(() => toModuleRef("./helper.js")).toThrow();
    expect(() => toModuleRef("jsr:@std/path")).toThrow();
  });
});

describe("resolveNotebook", () => {
  const fakeServer = (urls: Record<string, string>) => ({
    resolve: async (ref: { pkg?: string }) => {
      const url = urls[ref.pkg as string];
      if (!url) throw new Error(`no such package: ${ref.pkg}`);
      return { url, target: "browser" as const };
    },
  });

  it("maps every specifier to its resolved URL", async () => {
    const nb = nbWith(`import * as Plot from "npm:@observablehq/plot";`, `import {csv} from "d3";`);
    const pins = await resolveNotebook(
      nb,
      { moduleServer: fakeServer({ "@observablehq/plot": "/_m/plot.js", d3: "/_m/d3.js" }) },
      "/n/a.md",
    );
    expect(pins.get("npm:@observablehq/plot")).toBe("/_m/plot.js");
    expect(pins.get("d3")).toBe("/_m/d3.js");
  });

  // (1) a bad import must name the notebook and the specifier
  it("throws a ResolveError naming the notebook and the specifier", async () => {
    const nb = nbWith(`import x from "npm:@observablehq/nope";`);
    const err = await resolveNotebook(nb, { moduleServer: fakeServer({}) }, "/n/broken.md").then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(ResolveError);
    expect(err.notebookPath).toBe("/n/broken.md");
    expect(err.specifier).toBe("npm:@observablehq/nope");
    expect(String(err.message)).toContain("/n/broken.md");
  });

  // (4) two notebooks, same package, different versions
  it("gives each notebook its own pin for the same package at different versions", async () => {
    const server = {
      resolve: async (ref: { pkg?: string; version?: string }) => ({
        url: `/_m/${ref.pkg}@${ref.version ?? "latest"}/index.js`,
        target: "browser" as const,
      }),
    };
    const a = await resolveNotebook(
      nbWith(`import * as d3 from "npm:d3@6";`),
      { moduleServer: server },
      "/a.md",
    );
    const b = await resolveNotebook(
      nbWith(`import * as d3 from "npm:d3@7";`),
      { moduleServer: server },
      "/b.md",
    );
    expect(a.get("npm:d3@6")).toBe("/_m/d3@6/index.js");
    expect(b.get("npm:d3@7")).toBe("/_m/d3@7/index.js");
  });

  it("does not pin a URL import and does not throw", async () => {
    const nb = nbWith(`import * as d3 from "https://esm.sh/d3";`);
    const pins = await resolveNotebook(nb, { moduleServer: fakeServer({}) }, "/n/a.md");
    expect(pins.size).toBe(0);
  });

  it("does not pin a relative import and does not throw", async () => {
    const nb = nbWith(`import { helper } from "./helper.js";`);
    const pins = await resolveNotebook(nb, { moduleServer: fakeServer({}) }, "/n/a.md");
    expect(pins.size).toBe(0);
  });

  it("does not pin a jsr: import and does not throw", async () => {
    const nb = nbWith(`import { join } from "jsr:@std/path";`);
    const pins = await resolveNotebook(nb, { moduleServer: fakeServer({}) }, "/n/a.md");
    expect(pins.size).toBe(0);
  });

  it("does not pin an observable: import and does not throw", async () => {
    const nb = nbWith(`import { foo } from "observable:@user/nb";`);
    const pins = await resolveNotebook(nb, { moduleServer: fakeServer({}) }, "/n/a.md");
    expect(pins.size).toBe(0);
  });

  it("pins only the npm import in a notebook that mixes an npm and a URL import", async () => {
    const nb = nbWith(`import {csv} from "d3";`, `import * as Plot from "https://esm.sh/plot";`);
    const pins = await resolveNotebook(
      nb,
      { moduleServer: fakeServer({ d3: "/_m/d3.js" }) },
      "/n/a.md",
    );
    expect(pins.get("d3")).toBe("/_m/d3.js");
    expect(pins.has("https://esm.sh/plot")).toBe(false);
    expect(pins.size).toBe(1);
  });
});
