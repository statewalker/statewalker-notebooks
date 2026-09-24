import type { PubSub } from "@statewalker/notebook-events";
import type { FilesApi } from "@statewalker/webrun-files";
import { SiteBuilder, type SiteHandler } from "@statewalker/webrun-site-builder";
import { withDecodedPaths } from "./decode-path.js";

export interface NotebookSiteOptions {
  /** The built site: notebook pages, attachments, and in static mode the deps. */
  output: FilesApi;
  /** Hosted mode only. Omit for a static export, which has no module endpoint. */
  moduleServer?: { fetch(request: Request): Promise<Response> };
  /**
   * Mount prefix for module dependencies. Must match the build's basePath. A trailing slash
   * is optional — `"/_m/"` and `"/_m"` mount the same place. The site root is rejected.
   */
  basePath?: string;
  /** Rebuild notifications. Omit to serve without an event stream. */
  events?: PubSub;
  /** Mount prefix for the rebuild event stream. Same rules as {@link basePath}. */
  eventsPath?: string;
  /**
   * webrun-site-builder has NO default here: without it a directory request
   * is a 404, which reads as a broken build rather than a missing option.
   */
  directoryIndex?: string;
}

export function newNotebookSite({
  output,
  moduleServer,
  basePath = "/_m/",
  events,
  eventsPath = "/_events",
  directoryIndex = "index.html",
}: NotebookSiteOptions): SiteHandler {
  const builder = new SiteBuilder();

  // Endpoints are matched before files, so these prefixes must not collide
  // with a notebook path. Both are underscore-prefixed for that reason.
  // Conditional on purpose: a static export has no module server at all, so
  // nothing may claim `/_m/*` — the request must fall through to `setFiles`
  // below and be served from (or 404 against) the materialized dependency.
  if (moduleServer) {
    builder.setEndpoint(mountPattern("basePath", basePath), (request) =>
      moduleServer.fetch(request),
    );
  }

  if (events) {
    builder.setEndpoint(mountPattern("eventsPath", eventsPath), (request) =>
      events.handler(request),
    );
  }

  // `withDecodedPaths`, not `output` directly: a URL pathname is percent-encoded, and nothing
  // below this line decodes it. See `decode-path.ts` — without it `/My%20Notebook.html` 404s
  // here while the same file, served as a static export, does not.
  builder.setFiles("/", withDecodedPaths(output), { directoryIndex });

  // A thrown handler in a ServiceWorker takes down every open page, so
  // nothing is allowed to escape as a rejection.
  builder.setErrorHandler((error) => {
    console.error("[notebook-site]", error);
    return new Response("internal error", { status: 500 });
  });

  return builder.build();
}

/**
 * Turn a mount option into a `URLPattern` pathname, identically for both options.
 *
 * The two defaults have opposite trailing-slash conventions — `"/_m/"` has one, `"/_events"`
 * does not — so a caller who spells one by analogy with the other must still get a working
 * mount. Only `basePath` used to be normalized; `eventsPath: "/_events/"` therefore built
 * `/_events//*`, which matches nothing: the page's `EventSource` retried forever, rebuild
 * notifications silently never arrived, and nothing logged.
 *
 * The trailing `/` before the wildcard is load-bearing and must not be tidied away. `/_m*`
 * would match `/_module-notes.html`; `/_events*` would turn `/_eventsource-guide.html` into an
 * SSE stream. The prefix is a prefix of path SEGMENTS, not of the string.
 */
function mountPattern(option: "basePath" | "eventsPath", value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const prefix = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (prefix === "/") {
    // Refused rather than honoured: this endpoint is matched before files, so at the root it
    // claims the entire site — /index.html and every notebook page with it — and the site
    // serves nothing. A silent all-pages outage is not a configuration worth supporting.
    throw new Error(
      `newNotebookSite: ${option} must not be the site root (got ${JSON.stringify(value)}); ` +
        "an endpoint mounted there claims every page, including /index.html",
    );
  }
  return `${prefix}/*`;
}
