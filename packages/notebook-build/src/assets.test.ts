import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyAttachments } from "./assets.js";
import { contentHash } from "./hash.js";
import { parseMarkdown } from "./md-parse.js";

describe("copyAttachments", () => {
  it("copies a FileAttachment referenced by a cell", async () => {
    const source = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(source, "/nb/data.csv", "a,b\n1,2\n");
    const nb = parseMarkdown('# T\n\n```js\nconst d = FileAttachment("data.csv");\n```\n');
    const written = await copyAttachments(nb, source, output, "/nb/index.md");
    expect(written.map((a) => a.path)).toEqual(["/nb/data.csv"]);
    // The recorded hash is the hash of the bytes that were copied, not of the name or the
    // path: the incremental gate compares it against the attachment's current content.
    expect(written[0]?.hash).toBe(await contentHash(new TextEncoder().encode("a,b\n1,2\n")));
    expect(await output.exists("/nb/data.csv")).toBe(true);
  });

  it("resolves an attachment relative to the notebook, not the root", async () => {
    const source = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(source, "/deep/nested/x.json", "{}");
    const nb = parseMarkdown('# T\n\n```js\nFileAttachment("x.json");\n```\n');
    await copyAttachments(nb, source, output, "/deep/nested/n.md");
    expect(await output.exists("/deep/nested/x.json")).toBe(true);
  });

  it("reports a missing attachment by name rather than writing an empty file", async () => {
    const nb = parseMarkdown('# T\n\n```js\nFileAttachment("gone.csv");\n```\n');
    await expect(
      copyAttachments(nb, new MemFilesApi(), new MemFilesApi(), "/n.md"),
    ).rejects.toThrow(/gone\.csv/);
  });

  /**
   * A `sql` cell's `${…}` interpolations are compiled as JavaScript by notebook-kit
   * (`transpile.js` routes every non-js/ts/ojs mode through `transpileJavaScript(
   * transpileTemplate(cell))`), so a `FileAttachment` there is a real fetch the page will
   * make. Verified against the installed notebook-kit 2.6.4: `transpile(cell, "sql",
   * {resolveFiles: true}).files` is `Set(1) { 'data.csv' }`. Before this cell's mode was
   * admitted here the page fetched a file the build never published — a 404 in both hosted
   * and static mode.
   */
  it("copies a FileAttachment referenced from a sql cell's interpolation", async () => {
    const source = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(source, "/nb/sales.csv", "a,b\n1,2\n");
    const nb = parseMarkdown(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: `${…}` is notebook-kit SQL-cell interpolation syntax inside notebook SOURCE, not a JS template.
      '# T\n\n```sql\nSELECT * FROM read_csv(${await FileAttachment("sales.csv").url()})\n```\n',
    );
    const written = await copyAttachments(nb, source, output, "/nb/index.md");
    expect(written.map((a) => a.path)).toEqual(["/nb/sales.csv"]);
    expect(await output.exists("/nb/sales.csv")).toBe(true);
  });

  it("copies each attachment once when several cells reference it", async () => {
    const source = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(source, "/d.csv", "x");
    const nb = parseMarkdown(
      '# T\n\n```js\nFileAttachment("d.csv");\n```\n\n```js\nFileAttachment("d.csv");\n```\n',
    );
    expect((await copyAttachments(nb, source, output, "/n.md")).map((a) => a.path)).toEqual([
      "/d.csv",
    ]);
  });
});

/**
 * A REAL filesystem, not `MemFilesApi`. Mem keys its store on the literal path string, so
 * `/nb/deep/../../x` is just an odd key there and nothing escapes; a real backend
 * (`NodeFilesApi.resolvePath` is `rootDir + normalizePath(path)`, and `normalizePath` does
 * not resolve `..`) hands the traversal straight to the OS.
 */
describe("copyAttachments — path containment", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nb-attachments-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses an attachment that climbs out of the notebook's directory", async () => {
    // The two roots sit at different depths, so an escape out of the source root and an
    // escape out of the output root land on two different files — and the write is visible.
    const notebooksDir = join(root, "notebooks");
    const outputDir = join(root, "deep", "out");
    await mkdir(notebooksDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(root, "secret.txt"), "TOP SECRET\n");

    const source = new NodeFilesApi({ rootDir: notebooksDir });
    const output = new NodeFilesApi({ rootDir: outputDir });
    const nb = parseMarkdown('# T\n\n```js\nFileAttachment("../secret.txt");\n```\n');

    await expect(copyAttachments(nb, source, output, "/report.md")).rejects.toThrow(
      /\/report\.md.*\.\.\/secret\.txt/,
    );
    // …and nothing was written outside the output root on the way to failing.
    expect(existsSync(join(root, "deep", "secret.txt"))).toBe(false);
  });

  it("refuses an attachment that climbs out of a nested notebook's own directory", async () => {
    const notebooksDir = join(root, "notebooks");
    const outputDir = join(root, "deep", "out");
    await mkdir(join(notebooksDir, "nb", "deep"), { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(root, "secret.txt"), "TOP SECRET\n");

    const source = new NodeFilesApi({ rootDir: notebooksDir });
    const output = new NodeFilesApi({ rootDir: outputDir });
    const nb = parseMarkdown('# T\n\n```js\nFileAttachment("../../../secret.txt");\n```\n');

    await expect(copyAttachments(nb, source, output, "/nb/deep/report.md")).rejects.toThrow(
      /secret\.txt/,
    );
    expect(existsSync(join(root, "deep", "secret.txt"))).toBe(false);
  });

  it("resolves `..` inside the notebook's directory instead of copying it literally", async () => {
    const source = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(source, "/nb/data.csv", "a\n");
    const nb = parseMarkdown('# T\n\n```js\nFileAttachment("sub/../data.csv");\n```\n');
    // Left unresolved this is the key `/nb/sub/../data.csv`, which exists nowhere.
    expect((await copyAttachments(nb, source, output, "/nb/index.md")).map((a) => a.path)).toEqual([
      "/nb/data.csv",
    ]);
    expect(await output.exists("/nb/data.csv")).toBe(true);
  });
});
