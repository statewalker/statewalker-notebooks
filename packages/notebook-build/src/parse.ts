import { deserialize, type Notebook, toNotebook } from "@observablehq/notebook-kit";
import type { DomEnv } from "./serialize.js";

export function parseNotebookHtml(html: string, dom: DomEnv): Notebook {
  // deserialize already returns a fully-normalized Notebook (it calls toNotebook
  // internally). The outer toNotebook here is a harmless idempotent second pass,
  // kept for explicitness so downstream stages never have to trust that an
  // upstream default was actually applied.
  return toNotebook(deserialize(html, { parser: dom.parser }));
}
