# statewalker-notebooks

Browser-based Observable notebooks built on the statewalker stack.

## Packages

| Package | Description |
| --- | --- |
| [@statewalker/notebook-build](packages/notebook-build) | Builds a tree of notebooks on a FilesApi into a static site of executable pages, incrementally. |
| [@statewalker/notebook-db](packages/notebook-db) | Backs notebook-kit SQL cells with any `@statewalker/db-api` database: a live client, and a build-time precompute that writes the JSON notebook-kit's cached client fetches. |
| [@statewalker/notebook-events](packages/notebook-events) | Generic publish/subscribe over Server-Sent Events: a standard FetchHandler and a matching client. |
| [@statewalker/notebook-site](packages/notebook-site) | Serves a built notebook site as a FetchHandler: pages and attachments from files, modules from a module server in hosted mode or from the export in static mode, plus the rebuild event stream. |

## Development

```sh
pnpm install
pnpm run build
pnpm run test
```
