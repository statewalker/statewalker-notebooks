import { type Notebook, transpile } from "@observablehq/notebook-kit";
import { dirname, type FilesApi, joinPath, readFile } from "@statewalker/webrun-files";

const CODE_MODES = new Set(["js", "ts", "ojs"]);

/**
 * Every `FileAttachment` name referenced in the notebook, deduplicated, in first-seen
 * order. Collected the same way `[Resolve]` collects import specifiers: by transpiling
 * with notebook-kit's own file-resolution walker and reading the `files` set it already
 * returns, instead of a second hand-rolled scan of the source that could drift from what
 * notebook-kit itself parses.
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
 * Returns the output paths written. That list is load-bearing: a later prune step
 * removes exactly these paths when the notebook that referenced them disappears, so
 * this must report every path it actually wrote, not just the notebook's own page.
 */
export async function copyAttachments(
  nb: Notebook,
  source: FilesApi,
  output: FilesApi,
  notebookPath: string,
): Promise<string[]> {
  const dir = dirname(notebookPath);
  const written: string[] = [];
  for (const name of collectAttachmentNames(nb)) {
    const path = joinPath(dir, name);
    if (!(await source.exists(path))) {
      throw new Error(`${notebookPath}: cannot find attachment "${name}" (expected at ${path})`);
    }
    const data = await readFile(source, path);
    await output.write(path, [data]);
    written.push(path);
  }
  return written;
}
