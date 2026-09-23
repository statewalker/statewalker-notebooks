// TEST FIXTURE — not the real host.
//
// The build writes pages into a `FilesApi`, and a hosted page also fetches its modules from a
// live module server. Nothing in this package serves either of those over HTTP: that is
// `notebook-site`'s job, and it will do it properly through a `SiteHandler` (one handler chain,
// content negotiation, caching, ranges). This file is the minimum Node stand-in that lets a real
// browser load a built page — plain `node:http` on localhost, two routes, a small MIME map, no
// caching and no negotiation. Do not grow it into a host; if a test needs more than "GET this
// path", it belongs in `notebook-site`.
//
// Routing is deliberately `basePath`-first: in hosted mode the page's module URLs live under
// `basePath` and are answered by `moduleServer.fetch`, and everything else comes out of the
// built output. Passing no `moduleServer` serves output only — which is exactly the condition a
// static export has to survive, so that omission is a test, not a convenience.

import { createServer, type Server } from "node:http";
import type { FilesApi } from "@statewalker/webrun-files";

/** Structural subset of a module server this fixture needs. */
export interface FetchHandlerLike {
  fetch(request: Request): Promise<Response>;
}

export interface OutputServerOptions {
  port: number;
  output: FilesApi;
  /** Omitted ⇒ every path is served from `output`, including the ones under `basePath`. */
  moduleServer?: FetchHandlerLike;
  /** URL prefix the module server is mounted at; must match the build's. */
  basePath?: string;
}

export interface OutputServer {
  origin: string;
  stop(): Promise<void>;
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  css: "text/css; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  wasm: "application/wasm",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
};

function mimeOf(path: string): string {
  const ext = path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of files.read(path)) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export async function startOutputServer(options: OutputServerOptions): Promise<OutputServer> {
  const { port, output, moduleServer } = options;
  const basePath = options.basePath ?? "/_m/";

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const pathname = decodeURIComponent(url.pathname);

        if (moduleServer && pathname.startsWith(basePath)) {
          // The module server answers `?raw` / `?module` off the query string, so the search
          // has to survive the hop — dropping it silently serves the wrong representation.
          const response = await moduleServer.fetch(
            new Request(`http://localhost${pathname}${url.search}`),
          );
          const body = new Uint8Array(await response.arrayBuffer());
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
          res.writeHead(response.status, headers);
          res.end(body);
          return;
        }

        if (await output.exists(pathname)) {
          const body = await readAll(output, pathname);
          res.writeHead(200, {
            "content-type": mimeOf(pathname),
            "content-length": String(body.length),
          });
          res.end(body);
          return;
        }

        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end(`not found: ${pathname}`);
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(String((error as Error)?.stack ?? error));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
