import { deserialize } from "@observablehq/notebook-kit";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./md-parse.js";
import { notebookHash, serializeNotebook } from "./serialize.js";

/** Under Node there is no DOM; the browser injects its own natives instead. */
function nodeDom() {
  const { window } = new JSDOM("<!doctype html>");
  return { document: window.document, parser: new window.DOMParser() };
}

describe("serializeNotebook", () => {
  it("round-trips through notebook-kit's own deserialize", () => {
    const dom = nodeDom();
    const nb = parseMarkdown("# Round trip\n\n```js\nconst x = 1;\n```\n");
    const html = serializeNotebook(nb, dom);
    const back = deserialize(html, { parser: dom.parser });
    expect(back.title).toBe("Round trip");
    expect(back.cells.map((c) => [c.mode, c.value])).toEqual(
      nb.cells.map((c) => [c.mode, c.value]),
    );
  });

  it("produces a document Observable Desktop would recognise", () => {
    const html = serializeNotebook(parseMarkdown("# T\n"), nodeDom());
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<title>T</title>");
  });

  it("is byte-stable for the same notebook", () => {
    const dom = nodeDom();
    const nb = parseMarkdown("# T\n\n```js\n1\n```\n");
    expect(serializeNotebook(nb, dom)).toBe(serializeNotebook(nb, dom));
  });
});

describe("notebookHash", () => {
  it("is stable for identical input and differs for changed input", async () => {
    const a = await notebookHash("<!doctype html><title>a</title>");
    const b = await notebookHash("<!doctype html><title>a</title>");
    const c = await notebookHash("<!doctype html><title>b</title>");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
