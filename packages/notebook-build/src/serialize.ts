import { type Notebook, serialize } from "@observablehq/notebook-kit";

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

/** Hex SHA-256 over the serialized notebook — the incremental build's gate. */
export async function notebookHash(html: string): Promise<string> {
  const bytes = new TextEncoder().encode(html);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
