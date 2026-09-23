import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { copyAttachments } from "./assets.js";
import { parseMarkdown } from "./md-parse.js";

describe("copyAttachments", () => {
  it("copies a FileAttachment referenced by a cell", async () => {
    const source = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(source, "/nb/data.csv", "a,b\n1,2\n");
    const nb = parseMarkdown('# T\n\n```js\nconst d = FileAttachment("data.csv");\n```\n');
    const written = await copyAttachments(nb, source, output, "/nb/index.md");
    expect(written).toEqual(["/nb/data.csv"]);
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

  it("copies each attachment once when several cells reference it", async () => {
    const source = new MemFilesApi();
    const output = new MemFilesApi();
    await writeText(source, "/d.csv", "x");
    const nb = parseMarkdown(
      '# T\n\n```js\nFileAttachment("d.csv");\n```\n\n```js\nFileAttachment("d.csv");\n```\n',
    );
    expect(await copyAttachments(nb, source, output, "/n.md")).toEqual(["/d.csv"]);
  });
});
