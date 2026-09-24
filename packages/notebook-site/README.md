# @statewalker/notebook-site

Composes one [`SiteHandler`](https://github.com/statewalker/webrun-wire) that serves a site built
by [`@statewalker/notebook-build`](../notebook-build): pages and attachments from a `FilesApi`,
module dependencies from a live module server, and the rebuild stream from
[`@statewalker/notebook-events`](../notebook-events).

It owns the composition and nothing else — no routing of its own, no build, no transport. The
same handler runs under Node, in a Worker, and behind a browser ServiceWorker.

```sh
npm install @statewalker/notebook-site
```

## Usage

```ts
import { newNotebookSite, primeModules } from "@statewalker/notebook-site";

const handler = newNotebookSite({
  output,       // FilesApi: what notebook-build wrote
  moduleServer, // hosted mode only — omit for a static export
  events,       // PubSub from @statewalker/notebook-events — omit for no event stream
  basePath: "/_m/",
  eventsPath: "/_events",
});

const response = await handler(new Request("http://localhost/reports/q3.html"));
```

| option | meaning |
| --- | --- |
| `output` | The built site: pages, attachments, and in static mode the materialized dependency closure. |
| `moduleServer` | Serves `basePath/*` in hosted mode. **Omit it for a static export** — then nothing claims that prefix and the request falls through to `output`. |
| `basePath` | Where module dependencies are mounted (default `/_m/`). Must match the build's `basePath`. |
| `events` | Rebuild notifications. Omit to serve without an event stream. |
| `eventsPath` | Where the event stream is mounted (default `/_events`). |
| `directoryIndex` | File served for a directory request (default `index.html`). `webrun-site-builder` has no default here, and without one a directory request 404s, which reads as a broken build. |

## Dispatch

Endpoints are matched before files, so both mounts must stay clear of notebook paths — hence the
underscore prefixes.

- `basePath` and `eventsPath` are prefixes of path **segments**, not of the string. `/_m/*` does
  not match `/_module-notes.html`, and `/_events/*` does not match `/_eventsource-guide.html`.
- A trailing slash is optional and means nothing: `"/_m/"` and `"/_m"` mount the same place. The
  two defaults are spelled inconsistently — `/_m/` has one, `/_events` does not — so either
  spelling of either option has to work, and does.
- The site root is refused. `basePath: "/"` would make the module server claim every page,
  `/index.html` included, so it throws rather than serving nothing.

## Paths are percent-decoded

A `SiteHandler` receives a `Request`, and a URL pathname is percent-encoded by definition. Nothing
below this package decodes it, so `newNotebookSite` does — otherwise `/My%20Notebook.html` would
404 here while the identical static export, served by any ordinary HTTP server, worked.

Decoding is per segment. `%2f` is not a path separator to the URL parser, and it is not turned
into one: a segment that decodes to a dot-segment or to anything containing a separator rejects
the path rather than reaching the backend. A `%` that is not a valid escape is left alone, since a
filename may legitimately contain one.

## Priming

```ts
const { primed, failed } = await primeModules(moduleServer, [
  { pkg: "d3", version: "7" },
  { pkg: "katex", version: "0.16", subpath: "dist/katex.mjs" },
]);
```

Lazy emission of `~deps` proxy files races concurrent browser fetches — a cold first load failed
roughly one time in four with a link error naming a proxy that had not finished being written.
`primeModules` warms them first. It is serial (concurrency re-creates the contention it exists to
avoid), it deduplicates refs, and one unresolvable package lands in `failed` instead of leaving
the rest of the site cold.

## Errors

Nothing escapes the handler as a rejection: a throw in any layer is logged and answered with a
`500`. A thrown handler in a ServiceWorker takes down every open page.

**Known gap:** this does not cover a failure *inside the response body*. `newServeFiles` returns a
`Response` whose stream pulls from `output.read()` lazily, so a backend that throws mid-read fails
long after the handler returned — the caller gets a `200` with a truncated body, and there is no
`500` and no log. Closing it needs either a buffered body or a trailer-capable stream.

## Hosting behind a ServiceWorker

`@statewalker/webrun-site-host`'s `HostedSiteBuilder` runs the handler behind a ServiceWorker, not
inside one: the worker half intercepts `fetch` and relays over a `MessagePort`, and the page-side
`SwHttpAdapter` is what invokes the `SiteHandler`. The shipped package is compiled without the DOM
lib, which is a compile-time guard — it is not runtime proof that the handler never touches the
DOM, and nothing here executes in worker scope.

## License

MIT
