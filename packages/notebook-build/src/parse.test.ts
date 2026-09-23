import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./md-parse.js";
import { parseNotebookHtml } from "./parse.js";
import { serializeNotebook } from "./serialize.js";

function nodeDom() {
  const { window } = new JSDOM("<!doctype html>");
  return { document: window.document, parser: new window.DOMParser() };
}

describe("parseNotebookHtml", () => {
  it("reads back what serializeNotebook wrote", () => {
    const dom = nodeDom();
    const original = parseMarkdown("# Hand authored\n\n```js\nconst x = 1;\n```\n");
    const nb = parseNotebookHtml(serializeNotebook(original, dom), dom);
    expect(nb.title).toBe("Hand authored");
    expect(nb.cells.map((c) => c.value)).toEqual(original.cells.map((c) => c.value));
  });

  it("normalizes a partial notebook to a complete one", () => {
    const nb = parseNotebookHtml("<!doctype html><title>Bare</title>", nodeDom());
    expect(nb.theme).toBe("air");
    expect(nb.readOnly).toBe(false);
    expect(Array.isArray(nb.cells)).toBe(true);
  });
});
