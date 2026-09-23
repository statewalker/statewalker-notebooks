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

  // A synchronous version of this test (both calls in one statement, no sleep) was tried
  // first and dropped: it races a millisecond clock, and against a serializer mutated to
  // append `Date.now()` it caught the bug only ~45% of the time (9/20 runs) because the two
  // back-to-back calls usually land in the same millisecond. A test that fires on a coin flip
  // reads as a passing test, which is worse than no test. The sleep below is not wasted time —
  // it is what makes this assertion actually gate the incremental build's hash input; don't
  // re-add the fast version to "speed up" this file.
  it("is byte-stable for the same notebook, across time", async () => {
    const dom = nodeDom();
    const nb = parseMarkdown("# T\n\n```js\n1\n```\n");
    const first = serializeNotebook(nb, dom);
    await new Promise((r) => setTimeout(r, 25)); // outlast a ms-resolution clock
    const second = serializeNotebook(nb, dom);
    expect(second).toBe(first);
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
