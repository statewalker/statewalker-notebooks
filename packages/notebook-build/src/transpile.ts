import { type Cell, type CellMode, type Notebook, transpile } from "@observablehq/notebook-kit";
import type { PinMap } from "./resolve.js";

export interface CellDefinition {
  id: number;
  body: string;
  inputs: string[];
  outputs: string[];
  autodisplay: boolean;
  mode: CellMode;
  /** Set when the cell did not compile; the page renders this in its place. */
  error?: string;
}

const CODE_MODES = new Set<CellMode>(["js", "ts", "ojs"]);

/**
 * Transpiles every code cell in `nb` against the module pin map produced by `resolveNotebook`.
 *
 * Synchronous by construction: every specifier was already resolved (awaited) in [Resolve].
 * `resolveImport` here is a pure `Map` lookup, matching notebook-kit's sync `resolveImport`
 * hook. An unpinned specifier — a URL import, a relative import, or a non-npm protocol like
 * `jsr:`/`observable:` — passes through unchanged (`pins.get(s) ?? s`) rather than becoming
 * "undefined" or a mangled value, which would fail at link time in the browser with a message
 * pointing nowhere near the cause.
 */
export function transpileNotebook(nb: Notebook, pins: PinMap): CellDefinition[] {
  const resolveImport = (specifier: string) => pins.get(specifier) ?? specifier;

  return nb.cells.map((cell: Cell): CellDefinition => {
    if (!CODE_MODES.has(cell.mode)) {
      // Prose cells are not transpiled; they pass through with empty inputs/outputs so the
      // renderer can lay them out in document order alongside code cells.
      //
      // GAP: this branch also swallows every non-js/ts/ojs *executable* mode (sql, html, tex,
      // dot, python, r) as if it were inert prose, dropping `cell.output` on the floor.
      // notebook-kit's `transpile()` does support these modes — it returns a `body` plus a
      // singular `output` (not the plural `outputs` js/ts/ojs use) for them — so they are not
      // unsupported, just unwired here. Closing this needs two things together, not one:
      // widening CODE_MODES to include them, AND teaching the renderer (a later stage) to
      // consume a singular `output` alongside plural `outputs`. Do not widen CODE_MODES alone:
      // a sql/html/... cell would then transpile but the renderer — which currently treats
      // every non-code mode as prose — would never render it. Tracked for the SQL-cell work in
      // a later plan.
      return {
        id: cell.id,
        body: "",
        inputs: [],
        outputs: [],
        autodisplay: false,
        mode: cell.mode,
      };
    }
    try {
      const t = transpile(cell, { resolveImport });
      return {
        id: cell.id,
        body: t.body,
        inputs: t.inputs ?? [],
        outputs: t.outputs ?? [],
        autodisplay: t.autodisplay ?? false,
        mode: cell.mode,
      };
    } catch (e) {
      // A cell that does not parse is the normal state while authoring — one broken cell must
      // not cost the author the other twenty. Record the error and keep going.
      return {
        id: cell.id,
        body: "",
        inputs: [],
        outputs: [],
        autodisplay: false,
        mode: cell.mode,
        error: String((e as Error)?.message ?? e),
      };
    }
  });
}
