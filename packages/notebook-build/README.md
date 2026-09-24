# @statewalker/notebook-build

Turns a tree of notebooks on a [`FilesApi`](https://github.com/statewalker/webrun-files) into a
static site of executable pages, incrementally.

A notebook is a Markdown file (fenced `js`/`ts`/`ojs`/`sql` blocks become cells, everything else
is prose) or an [Observable notebook-kit](https://github.com/observablehq/notebook-kit) HTML
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

## Cell modes

`js`, `ts`, `ojs` and `sql` cells are compiled and run in the page; every other mode renders as
prose.

### SQL cells

A SQL cell's `database` and `output` attributes are what make it work, and only a notebook-kit
HTML source can carry them — a Markdown fence has no syntax for an attribute.

`database` picks the mode, and the two are notebook-kit's, not this package's:

- `database="var:db"` (the default) is **live**: the cell compiles to
  ``DatabaseClient.of(db, "db").sql`…` `` and queries whatever the notebook's own `db` variable
  is. Any object with a `sql` tagged-template function will do — for instance a
  [`@statewalker/notebook-db`](https://www.npmjs.com/package/@statewalker/notebook-db) client
  over a `@statewalker/db-api` `Db`.
- `database="warehouse"` is **precomputed**: notebook-kit's client runs no SQL at all. It
  fetches `.observable/cache/<nameHash>-<hash>.json`, and that path is relative to the PAGE, so
  a notebook at `/reports/q3.html` reads `/reports/.observable/cache/…`. Writing those files is
  `@statewalker/notebook-db`'s `precomputeQueries`.

A Markdown ` ```sql ` fence is therefore a cell with NEITHER attribute, and since `ca27d82`
that is a live cell, not prose: it compiles to ``DatabaseClient.of(db, "db").sql`…` `` against
the notebook's own `db` variable (the `database` default), and with no `output` it is
anonymous — it runs and displays its result, and nothing downstream can name its rows. A
notebook that wants to reference the rows, or to query anything other than `db`, needs a
notebook-kit HTML source. Measured against notebook-kit 2.6.4, a bare `sql` cell transpiles to
`inputs: ["DatabaseClient", "db"]`, `outputs: []`, no singular `output` and `autodisplay:
true` — a consumer of a `db` variable the notebook must define elsewhere, and a producer of
nothing.

`output="revenue"` exposes the cell's rows to the rest of the notebook. It is notebook-kit's
*singular* output — `outputs` stays empty for a SQL cell — and two cells claiming one name fail
the build exactly as two `const x` cells do.

SQL results render through notebook-kit's default inspector. notebook-kit's own Vite plugin
uses `displayMode: "table"` instead; this package does not, because that display path is
`import("…/stdlib/inputs.js")`, whose first line imports `@observablehq/inputs` from jsDelivr.

### The modes that stay prose

Not "unsupported": notebook-kit's `transpile()` returns a real body for each of them. They are
left inert because the body cannot run in a page this build produces.

| mode | why |
| --- | --- |
| `html`, `tex`, `dot`, `sql.view` | need the `htl`, `tex`, `dot` and `Inputs` builtins, each of which notebook-kit loads from `cdn.jsdelivr.net`. A static export that reaches a CDN is not a static export. |
| `node`, `python`, `r` | are data-loader cells: `Interpreter(…).run(src)` fetches `.observable/cache/<hash>.bin`, an artifact a build-time interpreter stage produces. This build has none, so every such cell would 404 — worse than rendering inert. |
| `md` | is rendered at build time with markdown-it, into the document body, so prose is readable with JavaScript off. |

## What is published

For `/reports/q3.md`:

- `/reports/q3.html` — the page: one root element per cell, one `define()` per code cell.
- every `FileAttachment("…")` it references, copied to the same relative path — including one
  inside a `sql` cell's `${…}` interpolation, which notebook-kit compiles as JavaScript like
  any other cell's. An attachment that resolves outside the notebook's own directory is
  refused.
- in static mode, the dependency closure under `basePath`: every JS-reachable module, plus two
  kinds of file the JS graph never imports and a closure built from it alone would therefore
  miss (such an export looks perfect and dies at the first wasm instantiation):
  - the `.wasm`, `.css` and font files a package ships;
  - the classic worker scripts it ships (`*.worker.js`, and not their `.map` siblings). These
    are fetched with `?raw` so the module server's CJS→ESM transform cannot wrap them —
    duckdb-wasm's worker bundles are UMD, and a classic worker cannot parse the `import`/
    `export` a wrapped one would contain. The `?raw` is on the fetch only: the file is written
    at its plain `.worker.js` path, so the site serves it with a JavaScript content type, which
    is what the spec requires of a classic worker script.

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

`html`, `tex`, `dot`, `sql.view`, `node`, `python` and `r` cells parse and render as inert
prose — see "Cell modes" above for why each one is left out rather than wired up.

This package has NO build-time database wiring of any kind — not a stub, not a placeholder.
`NotebookBuildOptions` has no `databases` option, and nothing here derives a
`PrecomputeRequest` from a parsed notebook, so a `database="warehouse"` cell's
`.observable/cache/…json` is never written by this build. `@statewalker/notebook-db` exports
`precomputeQueries`, which writes exactly those files, but a caller must assemble the requests
and run it itself. Only the live path (`database="var:db"`, the Markdown fence default) works
end to end from a build alone.
