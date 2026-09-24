import { type Cell, type CellMode, type Notebook, transpile } from "@observablehq/notebook-kit";
import type { PinMap } from "./resolve.js";

export interface CellDefinition {
  id: number;
  body: string;
  inputs: string[];
  outputs: string[];
  /**
   * The SINGULAR output name, which notebook-kit sets for every mode that is not js/ts/ojs
   * (`transpile.js`: `if (mode !== "ts" && mode !== "js" && mode !== "ojs") transpiled.output =
   * cell.output`). It is an ALTERNATIVE to `outputs`, not an addition: a cell that has one has
   * an empty other. notebook-kit's `define()` reads it to name the cell's variable, so a
   * renderer that drops it emits a definition no downstream cell can reference.
   */
  output?: string;
  autodisplay: boolean;
  mode: CellMode;
  /** Set when the cell did not compile; the page renders this in its place. */
  error?: string;
}

/**
 * The modes this build compiles and the page can actually run. Exported because `render.ts`
 * must gate on the SAME set: two copies drifted apart is precisely how a widened transpile
 * yields cells that compile and are then rendered as prose.
 *
 * Why `sql` and nothing else, measured against the installed notebook-kit 2.6.4 rather than
 * inferred — `transpile()` returns a real body for EVERY mode below, so "notebook-kit supports
 * it" is not the test. The test is whether the body can run in a page this build produces:
 *
 *  * `sql` — body is `(await DatabaseClient.of(db, "db")).sql\`…\`` (a live database from a
 *    notebook variable) or `DatabaseClient("name", {id}).sql\`…\`` (a precomputed
 *    `.observable/cache/…json` fetch). `DatabaseClient` is defined directly in the runtime's
 *    `stdlib/index.js`, and both paths stay on this origin. IN.
 *  * `html`, `tex`, `dot` — the bodies need the `htl`, `tex` and `dot` builtins, and all three
 *    resolve through `stdlib/recommendedLibraries.js` to a literal
 *    `import("https://cdn.jsdelivr.net/npm/…")` (`tex.js` and `dot.js` import katex and
 *    @viz-js/viz from jsDelivr at module scope). A static export that reaches a CDN is not a
 *    static export; the browser suite asserts zero off-origin requests. OUT.
 *  * `node`, `python`, `r` — `Interpreter(mode, …).run(source)` does not execute anything: it
 *    is `FileAttachment(".observable/cache/<hash>.bin")`, a fetch of an artifact produced by a
 *    build-time data loader. This build has no interpreter stage, so every such cell would
 *    404. A cell that transpiles and then silently fails is worse than an inert one. OUT.
 *  * `sql.view` — body returns a `SqlView`, which is only useful with `displayMode: "table"`,
 *    and that display path is `import("./stdlib/inputs.js")`, whose first line is
 *    `export * from "https://cdn.jsdelivr.net/npm/@observablehq/inputs/+esm"`. Off-origin
 *    again, and without it the cell inspects an opaque query object. OUT.
 *  * `md` — has a body (`md\`…\``) and would work, but this build renders prose at BUILD time
 *    with markdown-it, into the document body, so it is readable with JavaScript disabled and
 *    costs the page nothing. Compiling it instead would be a regression, not a fix. OUT.
 *
 * For the same reason `displayMode` is not emitted anywhere in this package: notebook-kit's
 * own Vite plugin sets `displayMode: "table"` for `sql` cells, and that is the `inputs.js`
 * CDN path above. SQL results render through the default inspector here.
 */
export const CODE_MODES = new Set<CellMode>(["js", "ts", "ojs", "sql"]);

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
      // Prose cells, and every mode deliberately left out of CODE_MODES above, pass through
      // with empty inputs/outputs and no `output`, so the renderer lays them out in document
      // order as prose alongside code cells.
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
        // Spread rather than `output: t.output`: `exactOptionalPropertyTypes` refuses an
        // explicit `undefined` for an optional field, and a cell with no singular output must
        // not carry the key at all — `renderDefineCall` decides on its presence.
        ...(t.output === undefined ? {} : { output: t.output }),
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
