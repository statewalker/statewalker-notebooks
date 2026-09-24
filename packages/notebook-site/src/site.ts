import type { PubSub } from "@statewalker/notebook-events";
import type { FilesApi } from "@statewalker/webrun-files";
import { SiteBuilder, type SiteHandler } from "@statewalker/webrun-site-builder";

export interface NotebookSiteOptions {
  /** The built site: notebook pages, attachments, and in static mode the deps. */
  output: FilesApi;
  /** Hosted mode only. Omit for a static export, which has no module endpoint. */
  moduleServer?: { fetch(request: Request): Promise<Response> };
  /** Mount prefix for module dependencies. Must match the build's basePath. */
  basePath?: string;
  /** Rebuild notifications. Omit to serve without an event stream. */
  events?: PubSub;
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
  // Minimal: mounted unconditionally. Task 3's failing test is what makes
  // this conditional, which is what static-export mode needs.
  builder.setEndpoint(`${basePath.replace(/\/$/, "")}/*`, (request) =>
    (moduleServer as NonNullable<typeof moduleServer>).fetch(request),
  );

  if (events) {
    builder.setEndpoint(`${eventsPath}/*`, (request) => events.handler(request));
  }

  builder.setFiles("/", output, { directoryIndex });

  // A thrown handler in a ServiceWorker takes down every open page, so
  // nothing is allowed to escape as a rejection.
  builder.setErrorHandler((error) => {
    console.error("[notebook-site]", error);
    return new Response("internal error", { status: 500 });
  });

  return builder.build();
}
