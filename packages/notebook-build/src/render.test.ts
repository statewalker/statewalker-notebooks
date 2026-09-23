import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./md-parse.js";
import { renderPage } from "./render.js";
import { transpileNotebook } from "./transpile.js";

const render = (src: string) => {
  const nb = parseMarkdown(src);
  return renderPage(nb, transpileNotebook(nb, new Map()), {
    runtimeUrl: "/_m/@observablehq/notebook-kit@2.6.4/dist/src/runtime/index.js",
  });
};

describe("renderPage", () => {
  it("emits one root element per cell, carrying the cell id", () => {
    const html = render("# T\n\n```js\n1\n```\n\n```js\n2\n```\n");
    expect(html).toContain('id="cell-0"');
    expect(html).toContain('id="cell-1"');
  });

  it("imports the runtime from the pinned URL", () => {
    const html = render("# T\n\n```js\n1\n```\n");
    expect(html).toContain(
      'import {define} from "/_m/@observablehq/notebook-kit@2.6.4/dist/src/runtime/index.js"',
    );
  });

  it("emits a define call per code cell", () => {
    const html = render("# T\n\n```js\nconst x = 1;\n```\n");
    expect(html).toContain("define(");
    expect(html).toContain('"outputs":["x"]');
  });

  it("puts the title in the document head", () => {
    expect(render("# My title\n")).toContain("<title>My title</title>");
  });

  it("renders prose cells as HTML, not as define calls", () => {
    const html = render("# T\n\nsome **bold** prose\n");
    expect(html).toContain("<strong>bold</strong>");
  });

  // (2) the page half of the syntax-error contract
  it("renders a cell's error in place of its definition", () => {
    const html = render("# T\n\n```js\nconst broken = ;\n```\n");
    expect(html).toContain("cell-error");
    expect(html).not.toContain("define(");
  });

  it("escapes a cell body that contains a closing script tag", () => {
    const html = render('# T\n\n```js\nconst s = "</script>";\n```\n');
    // The literal must not be able to terminate the module script early...
    expect(html).not.toContain('</script>";');
    // ...but the value must survive, escaped, not simply be dropped. A mutation that deletes
    // the sequence instead of escaping it would still satisfy the assertion above while
    // corrupting the notebook's actual behaviour, so it must fail this one.
    expect(html).toContain('<\\/script>";'); // the escaped form survives, value intact
  });
});
