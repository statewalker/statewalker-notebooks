import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./md-parse.js";
import { renderPage } from "./render.js";
import { transpileNotebook } from "./transpile.js";

const RUNTIME_URL = "/_m/@observablehq/notebook-kit@2.6.4/dist/src/runtime/index.js";

const render = (src: string) => {
  const nb = parseMarkdown(src);
  return renderPage(nb, transpileNotebook(nb, new Map()), { runtimeUrl: RUNTIME_URL });
};

/**
 * Parse the page the way a browser does. A string assertion cannot tell a page that loads
 * from a page whose document ended halfway down: only a parser can.
 */
const parse = (html: string) => new JSDOM(html).window.document;

describe("renderPage", () => {
  it("emits one root element per cell, carrying the cell id", () => {
    const html = render("# T\n\n```js\n1\n```\n\n```js\n2\n```\n");
    expect(html).toContain('id="cell-1"');
    expect(html).toContain('id="cell-2"');
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

  // I6: `escapeScriptClose` was applied to rendered PROSE, which goes in the document body and
  // not in a `<script>`. markdown-it runs with `html: true`, so a raw `<script>` block in a
  // prose cell passed through verbatim and its closing tag became `<\/script` — which no HTML
  // parser accepts. Everything after that cell, the whole `define()` script included, was
  // swallowed as script text: the page loaded, rendered one cell, and nothing ran.
  it("does not break the document when a prose cell contains a raw script block", () => {
    const html = render(
      [
        "# T",
        "",
        "<script>window.fromProse = 1;</script>",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
      ].join("\n"),
    );
    const doc = parse(html);
    expect(doc.querySelectorAll("[id^='cell-']")).toHaveLength(2);
    expect(doc.querySelectorAll('script[type="module"]')).toHaveLength(1);
    expect(doc.querySelector('script[type="module"]')?.textContent).toContain("define(");
    // The author's own script survives intact, unescaped — it is ordinary page content.
    expect(html).toContain("<script>window.fromProse = 1;</script>");
  });

  // I7: `escapeHtml` could be mutated to `return s;` with all 73 tests still green.
  it("escapes markup in the title instead of emitting it into the head", () => {
    const doc = parse(render('# </title><img src=x onerror="boom()">\n'));
    expect(doc.querySelectorAll("head img")).toHaveLength(0);
    expect(doc.title).toBe('</title><img src=x onerror="boom()">');
  });

  it("escapes markup in a cell's error message instead of emitting it into the body", () => {
    const nb = parseMarkdown("# T\n\n```js\nconst x = 1;\n```\n");
    const cells = transpileNotebook(nb, new Map());
    const code = cells[1];
    if (!code) throw new Error("expected a code cell");
    const html = renderPage(
      nb,
      [
        cells[0] as (typeof cells)[number],
        { ...code, error: '</div><img src=x onerror="boom()">' },
      ],
      {
        runtimeUrl: RUNTIME_URL,
      },
    );
    const doc = parse(html);
    expect(doc.querySelectorAll("img")).toHaveLength(0);
    expect(doc.querySelector(".cell-error")?.textContent).toBe(
      '</div><img src=x onerror="boom()">',
    );
  });

  // M6: `stylesUrl` is interpolated into an `href` ATTRIBUTE, and `escapeHtml` did not touch
  // quotes — so a `"` in it closed the attribute and everything after it became markup.
  it("escapes a quote in the stylesheet URL instead of opening a new attribute", () => {
    const nb = parseMarkdown("# T\n");
    const html = renderPage(nb, transpileNotebook(nb, new Map()), {
      runtimeUrl: RUNTIME_URL,
      stylesUrl: '/s.css" onload="boom()',
    });
    const link = parse(html).querySelector("link");
    expect(link?.getAttribute("onload")).toBe(null);
    expect(link?.getAttribute("href")).toBe('/s.css" onload="boom()');
  });
});
