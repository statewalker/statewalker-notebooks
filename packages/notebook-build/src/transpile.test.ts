import { type CellSpec, toNotebook } from "@observablehq/notebook-kit";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./md-parse.js";
import { transpileNotebook } from "./transpile.js";

// No leading `# T` heading: md-parse.ts turns a lone heading (with no other prose before the
// first fence) into its own leading "md" cell (see md-parse.test.ts, "turns a fenced js block
// into a js cell", which sidesteps the same thing with a mode filter). Omitting the heading
// keeps `nbWith`'s cells index-aligned with the fenced blocks passed in.
const nbWith = (...blocks: string[]) =>
  parseMarkdown(`${blocks.map((b) => `\`\`\`js\n${b}\n\`\`\``).join("\n\n")}\n`);

describe("transpileNotebook", () => {
  it("rewrites an import to its pinned URL", () => {
    const nb = nbWith(`import * as Plot from "npm:@observablehq/plot";\nPlot.dot([]);`);
    const cell = transpileNotebook(
      nb,
      new Map([["npm:@observablehq/plot", "/_m/plot@1/index.js"]]),
    )[0]!;
    expect(cell.body).toContain('import("/_m/plot@1/index.js")');
    expect(cell.body).not.toContain("npm:");
  });

  it("reports declared outputs so downstream cells can consume them", () => {
    const cell = transpileNotebook(nbWith("const answer = 42;"), new Map())[0]!;
    expect(cell.outputs).toContain("answer");
  });

  it("reports referenced inputs", () => {
    const cells = transpileNotebook(nbWith("const a = 1;", "const b = a + 1;"), new Map());
    expect(cells[1]!.inputs).toContain("a");
  });

  it("leaves an unpinned specifier untouched rather than corrupting it", () => {
    const cell = transpileNotebook(nbWith(`import x from "./local.js";`), new Map())[0]!;
    expect(cell.body).toContain("./local.js");
  });

  // (2) a half-typed cell is the normal authoring state
  it("records a syntax error on the cell instead of throwing", () => {
    const cells = transpileNotebook(nbWith("const broken = ;"), new Map());
    expect(cells).toHaveLength(1);
    expect(cells[0]!.error).toBeTruthy();
    expect(cells[0]!.body).toBe("");
  });

  it("keeps transpiling the other cells after a broken one", () => {
    const cells = transpileNotebook(nbWith("const broken = ;", "const fine = 1;"), new Map());
    expect(cells[0]!.error).toBeTruthy();
    expect(cells[1]!.error).toBeUndefined();
    expect(cells[1]!.outputs).toContain("fine");
  });

  it("does not transpile prose cells", () => {
    const nb = parseMarkdown("# T\n\nprose\n\n```js\n1\n```\n");
    const prose = transpileNotebook(nb, new Map())[0]!;
    // Not just the mode label: a prose cell that was actually run through `transpile()` (say,
    // because a future edit widened which modes count as "code") would still carry mode "md"
    // through the catch branch — but it would also pick up an `error` from the attempt. Empty
    // fields and no error is the actual proof the cell was skipped, not merely mislabeled.
    expect(prose).toMatchObject({
      mode: "md",
      body: "",
      inputs: [],
      outputs: [],
      autodisplay: false,
    });
    expect(prose.error).toBeUndefined();
  });
});

/**
 * A notebook built from raw cell specs, because `parseMarkdown` cannot express a `sql` cell's
 * `output` or `database` attributes — only a notebook-kit HTML source can, and that is exactly
 * what the build feeds this stage (`emitPage` re-parses the serialized artifact).
 */
const nbOf = (...cells: CellSpec[]) => toNotebook({ cells });

describe("transpileNotebook, sql cells", () => {
  // notebook-kit's `transpile()` (dist/src/javascript/transpile.js) routes every non-js/ts/ojs
  // mode through `transpileTemplate` and then sets a SINGULAR `output` from `cell.output` —
  // never the plural `outputs`, which stays empty. Measured by running it, not read off a .d.ts.
  it("compiles a sql cell into a body that queries its database", () => {
    const cell = transpileNotebook(
      nbOf({ id: 1, mode: "sql", value: "SELECT 1 AS n", output: "myTable" }),
      new Map(),
    )[0]!;
    expect(cell.error).toBeUndefined();
    expect(cell.body).not.toBe("");
    expect(cell.body).toContain("DatabaseClient");
    expect(cell.body).toContain("SELECT 1 AS n");
    expect(cell.inputs).toContain("DatabaseClient");
  });

  it("carries the singular output name notebook-kit sets for a sql cell", () => {
    const cell = transpileNotebook(
      nbOf({ id: 1, mode: "sql", value: "SELECT 1 AS n", output: "myTable" }),
      new Map(),
    )[0]!;
    // Singular, not plural: `outputs` is empty for every non-js/ts/ojs mode, so a renderer
    // that only reads `outputs` emits a define nothing downstream can name.
    expect(cell.output).toBe("myTable");
    expect(cell.outputs).toEqual([]);
  });

  it("leaves `output` undefined for a js cell, which notebook-kit never sets it on", () => {
    const cell = transpileNotebook(
      nbOf({ id: 1, mode: "js", value: "const answer = 42;" }),
      new Map(),
    )[0]!;
    expect(cell.output).toBeUndefined();
    expect(cell.outputs).toContain("answer");
  });
});

/**
 * The modes deliberately NOT widened into `CODE_MODES`, each for a reason that was measured
 * rather than assumed. See the note on `CODE_MODES` in transpile.ts.
 */
describe("transpileNotebook, the modes that stay inert", () => {
  for (const mode of ["html", "tex", "dot", "python", "r", "node", "sql.view"] as const) {
    it(`emits a ${mode} cell inert rather than as a cell that cannot run`, () => {
      const cell = transpileNotebook(
        nbOf({ id: 1, mode, value: "x", output: "out" }),
        new Map(),
      )[0]!;
      expect(cell.body).toBe("");
      expect(cell.output).toBeUndefined();
      expect(cell.error).toBeUndefined();
    });
  }
});
