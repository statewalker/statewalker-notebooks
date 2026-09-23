import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./md-parse.js";

describe("parseMarkdown", () => {
  it("takes the title from the first h1", () => {
    const nb = parseMarkdown("# My notebook\n\nsome prose\n");
    expect(nb.title).toBe("My notebook");
  });

  it("turns a fenced js block into a js cell", () => {
    const nb = parseMarkdown("# T\n\n```js\nconst x = 1;\n```\n");
    const js = nb.cells.filter((c) => c.mode === "js");
    expect(js).toHaveLength(1);
    expect(js[0]!.value).toBe("const x = 1;");
  });

  it("maps the fence language onto the cell mode", () => {
    const nb = parseMarkdown("# T\n\n```ts\nconst x: number = 1;\n```\n\n```sql\nSELECT 1\n```\n");
    expect(nb.cells.map((c) => c.mode)).toEqual(expect.arrayContaining(["ts", "sql"]));
  });

  it("keeps prose between code blocks as md cells, in document order", () => {
    const nb = parseMarkdown("# T\n\nfirst\n\n```js\n1\n```\n\nsecond\n");
    expect(nb.cells.map((c) => c.mode)).toEqual(["md", "js", "md"]);
    // Exact equality, not `toContain`: a heading/paragraph `map` and its nested `inline`
    // child both cover the same source lines, so naively counting every token with a `map`
    // duplicates each line ("first\nfirst" instead of "first"). `toContain` would not catch
    // that duplication; only an exact match does.
    expect(nb.cells[0]!.value).toBe("# T\nfirst");
    expect(nb.cells[2]!.value).toBe("second");
  });

  it("assigns every cell a distinct id", () => {
    const nb = parseMarkdown("# T\n\na\n\n```js\n1\n```\n\nb\n");
    const ids = nb.cells.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads front matter into notebook fields", () => {
    const nb = parseMarkdown("---\ntitle: From front matter\ntheme: coffee\n---\n\n# Ignored\n");
    expect(nb.title).toBe("From front matter");
    expect(nb.theme).toBe("coffee");
  });

  it("defaults the theme when front matter omits it", () => {
    expect(parseMarkdown("# T\n").theme).toBe("air");
  });
});
