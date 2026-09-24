import { newPubSub } from "@statewalker/notebook-events";
import type { FilesApi } from "@statewalker/webrun-files";
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

  // (2) a missing path must be a clean 404, not a thrown rejection. `SiteBuilder` itself has a
  // top-level 404 for "nothing matched", which is byte-for-byte identical to the files backend's
  // own "not found" response — so the status/body alone can never prove `setFiles` is wired.
  // The spy on `stats` is what actually requires it: with `setFiles` removed, this request
  // still 404s (via the top-level fallback) but never touches the backend, so `statsCalls`
  // stays 0 and this assertion (not the status one) is what catches it.
  it("answers 404 for a path that does not exist, by consulting the files backend", async () => {
    const output = await seededOutput();
    let statsCalls = 0;
    const spied: FilesApi = new Proxy(output, {
      get(target, prop, receiver) {
        if (prop === "stats") {
          return async (...args: [string]) => {
            statsCalls++;
            return Reflect.get(target, prop, receiver).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const handler = newNotebookSite({ output: spied });
    const res = await handler(new Request("http://h/nope.html"));
    expect(res.status).toBe(404);
    expect(statsCalls).toBeGreaterThan(0);
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

  // Discriminates our error handler from SiteBuilder's own default: both would answer 500 for
  // a throwing files backend, but only ours answers with this body. Deleting `setErrorHandler`
  // from site.ts leaves all the other tests green (the traversal path never throws), so this is
  // the only test that actually requires it to be wired.
  it("answers 500 with its own body when the files backend throws", async () => {
    const throwingOutput = {
      async stats() {
        throw new Error("boom");
      },
      async read() {
        throw new Error("boom");
      },
    } as never;
    const handler = newNotebookSite({ output: throwingOutput });
    const res = await handler(new Request("http://h/whatever.html"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("internal error"); // not "Internal Server Error"
  });
});

describe("newNotebookSite — static export mode", () => {
  // (5) the exported site must work with no module endpoint at all
  it("serves a materialized dependency from files when no moduleServer is given", async () => {
    const output = new MemFilesApi();
    await writeText(output, "/index.html", "<!doctype html><title>Home</title>");
    await writeText(output, "/_m/d3@7/index.js", "export const version = 7;");

    const handler = newNotebookSite({ output }); // deliberately no moduleServer
    const res = await handler(new Request("http://h/_m/d3@7/index.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("version = 7");
  });

  it("404s a dependency that was never materialized, rather than hanging", async () => {
    const output = new MemFilesApi();
    await writeText(output, "/index.html", "<!doctype html>");
    const handler = newNotebookSite({ output });
    expect((await handler(new Request("http://h/_m/absent@1/index.js"))).status).toBe(404);
  });
});
