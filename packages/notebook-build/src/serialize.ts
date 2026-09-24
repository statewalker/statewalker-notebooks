import { type Notebook, serialize } from "@observablehq/notebook-kit";
import { textHash } from "./hash.js";

/**
 * The DOM this build runs against. In a browser these are the natives; under
 * Node the caller injects jsdom. Nothing in this package reads a DOM global.
 */
export interface DomEnv {
  document: Document;
  parser: DOMParser;
}

export function serializeNotebook(nb: Notebook, dom: DomEnv): string {
  return serialize(nb, { document: dom.document });
}

/** Hex SHA-256 over the serialized notebook — one of the incremental build's gates. */
export function notebookHash(html: string): Promise<string> {
  return textHash(html);
}
