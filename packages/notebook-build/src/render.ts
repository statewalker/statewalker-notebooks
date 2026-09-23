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
 * A literal `</script` anywhere in a string this module emits into the page would close the
 * enclosing `<script>` tag early: the HTML parser does not know or care that the sequence sits
 * inside a JS string literal, so everything after it in the document is dropped — the page still
 * loads and looks fine, but the rest of the notebook silently never runs. `<\/script` is the
 * standard escape for this: once parsed as a JS string it is the identical value (`\/` is just
 * `/`), but it is no longer a byte-for-byte match for the closing tag the HTML parser looks for.
 */
function escapeScriptClose(s: string): string {
  return s.replace(/<\/script/gi, "<\\/script");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderCellRoot(id: number, inner: string): string {
  return `<div id="cell-${id}">${inner}</div>`;
}

/**
 * `state` is notebook-kit's `DefineState` (`display.ts`/`define.ts` in
 * `@observablehq/notebook-kit`): `{root, variables, expanded}` exactly, nothing more and nothing
 * renamed — `display.js` reads `state.root`/`state.variables`/`state.expanded` directly, so any
 * other shape loads fine and throws at the first display.
 *
 * `root` is looked up through `self.document` rather than a bare `document` reference: this
 * source module never touches a DOM global itself (it only builds a string), but the string it
 * builds is JavaScript that *will* run in a browser, where it does need to resolve the page's own
 * `document`.
 */
function renderDefineCall(cell: CellDefinition): string {
  const state = `{root: self.document.getElementById("cell-${cell.id}"), variables: [], expanded: []}`;
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
      const html = md.render(source.get(cell.id) ?? "");
      roots.push(renderCellRoot(cell.id, escapeScriptClose(html)));
      continue;
    }
    if (cell.error) {
      // One unparseable cell must not cost the author the other twenty: show the error in place
      // of a definition, and skip it in the script below.
      const message = escapeScriptClose(escapeHtml(cell.error));
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
