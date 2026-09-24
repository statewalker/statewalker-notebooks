import { type Notebook, transpile } from "@observablehq/notebook-kit";
import { dirname, type FilesApi, readFile } from "@statewalker/webrun-files";
import { contentHash } from "./hash.js";
import { resolveWithin } from "./paths.js";
import { CODE_MODES } from "./transpile.js";

/** One copied attachment: where it landed, and the hash of the bytes that were copied. */
export interface CopiedAttachment {
  path: string;
  /** Hex SHA-256 of the copied content — the build's record of WHICH bytes are published. */
  hash: string;
}

/**
 * Every `FileAttachment` name referenced in the notebook, deduplicated, in first-seen
 * order. Collected the same way `[Resolve]` collects import specifiers: by transpiling
 * with notebook-kit's own file-resolution walker and reading the `files` set it already
 * returns, instead of a second hand-rolled scan of the source that could drift from what
 * notebook-kit itself parses.
 *
 * Gated on the SAME `CODE_MODES` the transpile stage compiles with — a THIRD copy of that set
 * is what let a `sql` cell's `FileAttachment` be emitted into the page and never copied. The
 * two sets cannot be allowed to differ in either direction: a mode this build emits code for
 * is a mode whose attachments the page will fetch. A `sql` cell's `${…}` interpolations are
 * compiled as JavaScript (notebook-kit's `transpile.js` routes every non-js/ts/ojs mode
 * through `transpileJavaScript(transpileTemplate(cell), options)`), so `transpile(…,
 * {resolveFiles: true}).files` reports their attachments like any other cell's.
 */
function collectAttachmentNames(nb: Notebook): string[] {
  const seen = new Set<string>();
  for (const cell of nb.cells) {
    if (!CODE_MODES.has(cell.mode)) continue;
    try {
      const t = transpile(cell.value, cell.mode, { resolveFiles: true });
      for (const name of t.files ?? []) seen.add(name);
    } catch {
      // A cell that does not parse has no resolvable attachments. A later stage is where
      // the syntax error becomes a visible error on the page.
    }
  }
  return [...seen];
}

/**
 * Copies every `FileAttachment` the notebook references from `source` to `output`,
 * resolved relative to the notebook's own directory (not the project root — a notebook
 * at `/nb/index.md` referencing `FileAttachment("data.csv")` means `/nb/data.csv`).
 *
 * An attachment that climbs out of that directory is REFUSED, not copied. Unresolved `..`
 * escapes both roots at once on a real backend (see `resolveWithin`): it reads a file above
 * the notebooks root and writes it above the output root, and because the escaping path is
 * recorded in the notebook's manifest, a later prune calls `output.remove()` on it. The
 * benign-looking case is broken too — a browser resolves `../../shared/x.csv` against the
 * PAGE's URL, so it asks for a path this build never writes.
 *
 * Returns the output paths written, each with the hash of the bytes written there. Both
 * halves are load-bearing: a later prune step removes exactly these paths when the notebook
 * that referenced them disappears, and the incremental gate compares the recorded hash against
 * the attachment's current content, so an edited attachment republishes. Hashing what was
 * copied — rather than re-reading afterwards — is what makes the record describe the bytes
 * that are actually in the output.
 */
export async function copyAttachments(
  nb: Notebook,
  source: FilesApi,
  output: FilesApi,
  notebookPath: string,
): Promise<CopiedAttachment[]> {
  const dir = dirname(notebookPath);
  const written: CopiedAttachment[] = [];
  for (const name of collectAttachmentNames(nb)) {
    const path = resolveWithin(dir, name);
    if (path === undefined) {
      throw new Error(
        `${notebookPath}: attachment "${name}" resolves outside the notebook's own directory (${dir})`,
      );
    }
    if (!(await source.exists(path))) {
      throw new Error(`${notebookPath}: cannot find attachment "${name}" (expected at ${path})`);
    }
    const data = await readFile(source, path);
    await output.write(path, [data]);
    written.push({ path, hash: await contentHash(data) });
  }
  return written;
}
