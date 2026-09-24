import type { CellMode, Notebook } from "@observablehq/notebook-kit";
import MarkdownIt from "markdown-it";
import type { CellDefinition } from "./transpile.js";

export interface RenderOptions {
  runtimeUrl: string;
  stylesUrl?: string;
}

/** Modes the transpile stage actually compiles; everything else arrives inert (see transpile.ts). */
const CODE_MODES = new Set<CellMode>(["js", "ts", "ojs"]);

const md = new MarkdownIt({ html: true });

/**
 * A literal `</script` inside the MODULE SCRIPT would close its `<script>` tag early: the HTML
 * parser does not know or care that the sequence sits inside a JS string literal, so everything
 * after it in the document is dropped — the page still loads and looks fine, but the rest of the
 * notebook silently never runs. `<\/script` is the standard escape: once parsed as a JS string it
 * is the identical value (`\/` is just `/`), but it is no longer a byte-for-byte match for the
 * closing tag the HTML parser looks for.
 *
 * It applies to SCRIPT CONTENT AND NOTHING ELSE. Applied to rendered prose — which goes in the
 * document body — it corrupts the page instead of protecting it: markdown-it runs with
 * `html: true`, so a raw `<script>` block in a prose cell passes through verbatim, and rewriting
 * its closing tag to `<\/script` leaves a script element no parser ever closes. Everything after
 * it, the `define()` script included, is then swallowed as script text. Measured with jsdom on a
 * two-cell notebook: 1 cell root instead of 2, 0 module scripts — exactly the failure this
 * function exists to prevent, caused by this function.
 */
function escapeScriptClose(s: string): string {
  return s.replace(/<\/script/gi, "<\\/script");
}

/**
 * For text interpolated into MARKUP: element content and, because `stylesUrl` is interpolated
 * into an `href="..."`, quoted attribute values. `"` is therefore escaped as well — without it a
 * quote in the URL closes the attribute and the rest of the string becomes markup of its own.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCellRoot(id: number, inner: string): string {
  return `<div id="cell-${id}">${inner}</div>`;
}

/**
 * `state` is notebook-kit's `DefineState` (`display.ts`/`define.ts` in
 * `@observablehq/notebook-kit`): `{root, variables, expanded}` exactly, nothing more and nothing
 * renamed — `display.js` reads `state.root`/`state.variables`/`state.expanded` directly, so any
 * other shape loads fine and throws at the first display.
 */
function renderDefineCall(cell: CellDefinition): string {
  const state = `{root: document.getElementById("cell-${cell.id}"), variables: [], expanded: []}`;
  const definition =
    `{"id":${cell.id},"body":${cell.body},` +
    `"inputs":${JSON.stringify(cell.inputs)},"outputs":${JSON.stringify(cell.outputs)},` +
    `"autodisplay":${JSON.stringify(cell.autodisplay)}}`;
  return `define(${state}, ${definition});`;
}

/**
 * Renders a resolved, transpiled notebook into the HTML page a browser loads and runs.
 *
 * `cells` must be `transpileNotebook(nb, pins)` for the same `nb` — this function reads the
 * original prose source back out of `nb.cells` (the transpile stage discards it for non-code
 * modes) and pairs it positionally with the corresponding `CellDefinition`.
 */
export function renderPage(nb: Notebook, cells: CellDefinition[], options: RenderOptions): string {
  const { runtimeUrl, stylesUrl } = options;
  const source = new Map(nb.cells.map((cell) => [cell.id, cell.value]));

  const roots: string[] = [];
  const defines: string[] = [];

  for (const cell of cells) {
    if (!CODE_MODES.has(cell.mode)) {
      // "md" cells, plus every mode the transpile stage does not yet wire up (sql/html/tex/dot/
      // python/r — see the GAP comment in transpile.ts): render as inert prose, the same as md.
      // Verbatim: this is document body, not script content. See `escapeScriptClose`.
      const html = md.render(source.get(cell.id) ?? "");
      roots.push(renderCellRoot(cell.id, html));
      continue;
    }
    if (cell.error) {
      // One unparseable cell must not cost the author the other twenty: show the error in place
      // of a definition, and skip it in the script below.
      // Body content too, and `escapeHtml` has already turned any `<` into `&lt;`.
      const message = escapeHtml(cell.error);
      roots.push(renderCellRoot(cell.id, `<div class="cell-error">${message}</div>`));
      continue;
    }
    roots.push(renderCellRoot(cell.id, ""));
    defines.push(renderDefineCall(cell));
  }

  const script = escapeScriptClose(
    [`import {define} from "${runtimeUrl}";`, ...defines].join("\n"),
  );

  const head = [
    '<meta charset="utf-8">',
    `<title>${escapeHtml(nb.title)}</title>`,
    stylesUrl ? `<link rel="stylesheet" href="${escapeHtml(stylesUrl)}">` : undefined,
  ].filter((line): line is string => line !== undefined);

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    ...head,
    "</head>",
    "<body>",
    ...roots,
    '<script type="module">',
    script,
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}
