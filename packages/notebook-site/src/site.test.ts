import { newPubSub } from "@statewalker/notebook-events";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newNotebookSite } from "./site.js";

async function seededOutput() {
  const output = new MemFilesApi();
  await writeText(output, "/index.html", "<!doctype html><title>Home</title>");
  await writeText(output, "/chart.html", "<!doctype html><title>Chart</title>");
  await writeText(output, "/data.csv", "a,b\n1,2\n");
  return output;
}

describe("newNotebookSite", () => {
  it("serves a notebook page at its real .html path", async () => {
    const handler = newNotebookSite({ output: await seededOutput() });
    const res = await handler(new Request("http://h/chart.html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Chart");
  });

  // (3) without directoryIndex a directory request 404s and looks like a build failure
  it("serves index.html for a directory request", async () => {
    const handler = newNotebookSite({ output: await seededOutput() });
    const res = await handler(new Request("http://h/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Home");
  });

  // (2) a missing path must be a clean 404, not a thrown rejection
  it("answers 404 for a path that does not exist", async () => {
    const handler = newNotebookSite({ output: await seededOutput() });
    const res = await handler(new Request("http://h/nope.html"));
    expect(res.status).toBe(404);
  });

  it("does not throw for a malformed path", async () => {
    const handler = newNotebookSite({ output: await seededOutput() });
    await expect(handler(new Request("http://h/%2e%2e/%2e%2e/etc/passwd"))).resolves.toBeDefined();
  });

  // (4) a wasm loader may issue a Range request
  it("honours a Range request with a 206 and the requested bytes", async () => {
    const handler = newNotebookSite({ output: await seededOutput() });
    const res = await handler(
      new Request("http://h/data.csv", { headers: { range: "bytes=0-2" } }),
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("a,b");
  });

  it("delegates /_m/* to the module server when one is given", async () => {
    const handler = newNotebookSite({
      output: await seededOutput(),
      moduleServer: {
        fetch: async (req) =>
          new Response(`served ${new URL(req.url).pathname}`, {
            status: 200,
            headers: { "content-type": "text/javascript" },
          }),
      },
    });
    const res = await handler(new Request("http://h/_m/d3@7/index.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("served /_m/d3@7/index.js");
  });

  it("mounts the events handler under /_events", async () => {
    const events = newPubSub();
    const handler = newNotebookSite({ output: await seededOutput(), events });
    const res = await handler(new Request("http://h/_events/build"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.body?.cancel();
  });
});
