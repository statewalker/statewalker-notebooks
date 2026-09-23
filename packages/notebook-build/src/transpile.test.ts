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
