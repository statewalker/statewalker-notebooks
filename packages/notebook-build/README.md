# @statewalker/notebook-build

Turns a tree of notebooks on a [`FilesApi`](https://github.com/statewalker/webrun-files) into a
static site of executable pages, incrementally.

A notebook is a Markdown file (fenced `js`/`ts`/`ojs` blocks become cells, everything else is
prose) or an [Observable notebook-kit](https://github.com/observablehq/notebook-kit) HTML
document. Each one becomes an `.html` page that imports notebook-kit's runtime and runs its own
cell graph in the browser.

```sh
npm install @statewalker/notebook-build
```

## Usage

```ts
import { newNotebookBuild } from "@statewalker/notebook-build";

const build = newNotebookBuild({
  notebooks, // FilesApi: the sources
  output,    // FilesApi: the site
  cache,     // FilesApi: the build's own state
  moduleServer,               // @statewalker/webrun-modules
  dom: { document, parser },  // jsdom under Node; the natives in a browser
  mode: "static",
  stylesUrl: "/_m/@observablehq/notebook-kit@2.6.4/dist/src/styles/index.css",
  onRebuilt: (changed) => deploy(changed),
  onFailed: (failures) => failures.forEach((f) => console.error(f.notebookPath, f.error)),
});

await build.build();
```

`build()` runs to convergence and returns. Call it again to pick up changes.

| option | meaning |
| --- | --- |
| `notebooks` | Source tree. Scanned recursively; `.md` and `.html` are notebooks, everything else is data. |
| `output` | Where pages, attachments and (in static mode) the dependency closure are written. |
| `cache` | Where the serialized-notebook artifacts and the incremental state live. |
| `moduleServer` | Resolves and serves npm packages — `@statewalker/webrun-modules`. |
| `dom` | A `document` and a `DOMParser`. Nothing in this package reads a DOM global. |
| `mode` | `"static"` (default) materializes the whole dependency closure into `output`; `"hosted"` leaves it to a live module server. |
| `basePath` | URL prefix the module server serves packages under (default `/_m/`). |
| `stylesUrl` | Stylesheet the pages link. Unset, the pages carry no styles at all. |
| `onRebuilt` | Called once per converged build with every output path that changed — page, attachments and closure. |
| `onFailed` | Called once per converged build with the notebooks that failed. One bad notebook never stops the others. |

The three `FilesApi` instances must be three distinct directories. The build writes a hidden
probe file to prove it, because two handles on one directory would feed the build's own output
back in as sources.

## What is published

For `/reports/q3.md`:

- `/reports/q3.html` — the page: one root element per cell, one `define()` per code cell.
- every `FileAttachment("…")` it references, copied to the same relative path. An attachment
  that resolves outside the notebook's own directory is refused.
- in static mode, the dependency closure under `basePath`: every JS-reachable module plus the
  `.wasm`, `.css` and font files a package ships that its JS graph never imports (a static
  export built from the JS graph alone looks perfect and dies at the first wasm instantiation).

Deleting a notebook prunes exactly what it published, minus anything another notebook still
claims.

## Incrementality

A notebook is re-derived unless everything the published page depended on is unchanged: the
serialized notebook, the build configuration (`mode`, `basePath`, `stylesUrl`), the resolved
pin map, the content of every attachment, and the presence of every output. A notebook with no
recorded successful build — one that failed, transiently or not — is retried on the next run
without needing its source touched.

Two sources that would publish to the same page (`report.md` and `report.html`) are both
reported as failures rather than one silently overwriting the other.

## Status

`sql`, `html`, `tex`, `dot`, `python` and `r` cells parse and render as inert prose: they are
not executed yet.
