import { deserialize, type Notebook, toNotebook } from "@observablehq/notebook-kit";
import type { DomEnv } from "./serialize.js";

export function parseNotebookHtml(html: string, dom: DomEnv): Notebook {
  // deserialize returns a NotebookSpec; toNotebook fills every default so
  // downstream stages never branch on an absent field.
  return toNotebook(deserialize(html, { parser: dom.parser }));
}
