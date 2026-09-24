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
  // Deliberately NOT encoding-transparent. `notebook-build`'s `pagePath` keeps the source
  // filename verbatim and `copyAttachments` keeps an attachment's declared name verbatim, so
  // both of these are ordinary output of an ordinary build. Keep them: a suite whose every
  // fixture name survives percent-encoding unchanged cannot see the decoding layer at all.
  await writeText(output, "/My Notebook.html", "<!doctype html><title>Spaced</title>");
  await writeText(output, "/Notes/Été.html", "<!doctype html><title>Accented</title>");
  await writeText(output, "/100% done.csv", "pct\n100\n");
  // Two pages that sit just past each endpoint's boundary. `/_m/*` and `/_events/*` are
  // prefixes of a PATH SEGMENT, not of a string: `/_m*` and `/_events*` are the tidy-ups
  // waiting to be made once you notice `basePath` already ends in a slash, and each would
  // swallow the page below it. Nothing else in the suite would notice.
  await writeText(output, "/_module-notes.html", "PAGE-NOT-MODULE");
  await writeText(output, "/_eventsource-guide.html", "PAGE-NOT-EVENTS");
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

  // A `SiteHandler` is handed a `Request`, and a URL pathname is percent-encoded by
  // definition — `new URL("http://h/My Notebook.html").pathname` is already
  // "/My%20Notebook.html". Nothing below this composition decodes it: `SiteBuilder` passes
  // `url.pathname` straight through to `newServeFiles`, which passes it straight to
  // `filesApi.stats`. So without a decoding layer here, every page or attachment whose name
  // carries a space or a non-ASCII character 404s — while the SAME build, served as a static
  // export by any ordinary HTTP server, works. The two modes must not disagree.
  it("serves a page whose name contains a space", async () => {
    const handler = newNotebookSite({ output: await seededOutput() });
    const res = await handler(new Request("http://h/My%20Notebook.html"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Spaced");
  });

  it("serves a page whose name contains a non-ASCII character", async () => {
    const handler = newNotebookSite({ output: await seededOutput() });
    const res = await handler(new Request("http://h/Notes/%C3%89t%C3%A9.html"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Accented");
  });

  // A literal `%` in a filename is encoded as `%25`, so decoding must handle it...
  it("serves a file whose name contains a literal percent sign", async () => {
    const handler = newNotebookSite({ output: await seededOutput() });
    const res = await handler(new Request("http://h/100%25%20done.csv"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("100");
  });

  // ...and a `%` that is NOT a valid escape must not blow the request up either. Browsers
  // encode, but a hand-typed or hand-written link does not have to.
  it("does not throw on an undecodable percent escape", async () => {
    const handler = newNotebookSite({ output: await seededOutput() });
    const res = await handler(new Request("http://h/broken%zz.html"));
    expect(res.status).toBe(404);
  });

  // Decoding must not hand the backend a path it would not otherwise have seen. `%2f` is the
  // one that matters: the URL parser leaves it alone (it is NOT a path separator), so a naive
  // whole-path `decodeURIComponent` would turn "/..%2f..%2fetc/passwd" into "/../../etc/passwd"
  // and re-create, at the files boundary, exactly the traversal the URL layer refused.
  it("refuses a traversal smuggled through %2f rather than decoding it into one", async () => {
    const output = await seededOutput();
    const seenPaths: string[] = [];
    const spied: FilesApi = new Proxy(output, {
      get(target, prop, receiver) {
        if (prop === "stats") {
          return async (path: string) => {
            seenPaths.push(path);
            return Reflect.get(target, prop, receiver).call(target, path);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const handler = newNotebookSite({ output: spied });
    const res = await handler(new Request("http://h/..%2f..%2fetc/passwd"));
    expect(res.status).toBe(404);
    for (const path of seenPaths) expect(path.split("/")).not.toContain("..");
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

  it("does not let the module server swallow a page whose name merely starts with the prefix", async () => {
    const handler = newNotebookSite({
      output: await seededOutput(),
      moduleServer: { fetch: async () => new Response("MODULE", { status: 200 }) },
    });
    const res = await handler(new Request("http://h/_module-notes.html"));
    expect(await res.text()).toBe("PAGE-NOT-MODULE");
  });

  it("does not let the events endpoint swallow a page whose name merely starts with the prefix", async () => {
    const handler = newNotebookSite({ output: await seededOutput(), events: newPubSub() });
    const res = await handler(new Request("http://h/_eventsource-guide.html"));
    expect(await res.text()).toBe("PAGE-NOT-EVENTS");
  });

  // (5) `basePath` defaults to "/_m/" and `eventsPath` to "/_events" — opposite trailing-slash
  // conventions, so whichever spelling a caller copies from the other option must still work.
  // Only `basePath` used to be normalized, which made `eventsPath: "/_events/"` build
  // `/_events//*`: it matches nothing, the page's `EventSource` retries forever, rebuild
  // notifications never arrive, and nothing logs.
  it("accepts a basePath spelled with or without a trailing slash", async () => {
    for (const basePath of ["/_mods/", "/_mods"]) {
      const handler = newNotebookSite({
        output: await seededOutput(),
        basePath,
        moduleServer: {
          fetch: async (req) => new Response(`served ${new URL(req.url).pathname}`),
        },
      });
      const res = await handler(new Request("http://h/_mods/d3@7/index.js"));
      expect(await res.text()).toBe("served /_mods/d3@7/index.js");
    }
  });

  it("accepts an eventsPath spelled with or without a trailing slash", async () => {
    for (const eventsPath of ["/_feed/", "/_feed"]) {
      const events = newPubSub();
      const handler = newNotebookSite({ output: await seededOutput(), events, eventsPath });
      const res = await handler(new Request("http://h/_feed/build"));
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(events.subscriberCount("build")).toBe(1);
      await res.body?.cancel();
    }
  });

  // A root mount is not a configuration to be honoured quietly: `basePath: "/"` makes the module server
  // claim the whole site, /index.html included, and the site then serves no pages at all.
  it("refuses a basePath or eventsPath that would claim the site root", async () => {
    for (const basePath of ["/", "", "  "]) {
      expect(() =>
        newNotebookSite({
          output: new MemFilesApi(),
          basePath,
          moduleServer: { fetch: async () => new Response("MODULE") },
        }),
      ).toThrow(/basePath/);
    }
    expect(() =>
      newNotebookSite({ output: new MemFilesApi(), events: newPubSub(), eventsPath: "/" }),
    ).toThrow(/eventsPath/);
  });

  // The content-type alone cannot see the wiring: an endpoint that ignores `events` entirely
  // and answers a hardcoded `text/event-stream` header passes it. `subscriberCount` is what
  // requires the supplied PubSub to have been used — the SSE stream's `start` subscribes
  // during construction, so the count is already 1 by the time the Response is returned.
  it("mounts the events handler under /_events, backed by the supplied PubSub", async () => {
    const events = newPubSub();
    const handler = newNotebookSite({ output: await seededOutput(), events });
    expect(events.subscriberCount("build")).toBe(0);
    const res = await handler(new Request("http://h/_events/build"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(events.subscriberCount("build")).toBe(1);
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
