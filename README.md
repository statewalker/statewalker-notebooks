# statewalker-notebooks

Browser-based Observable notebooks built on the statewalker stack.

## Packages

| Package | Description |
| --- | --- |
| [@statewalker/notebook-build](packages/notebook-build) | Builds a tree of notebooks on a FilesApi into a static site of executable pages, incrementally. |
| [@statewalker/notebook-events](packages/notebook-events) | Generic publish/subscribe over Server-Sent Events: a standard FetchHandler and a matching client. |

## Development

```sh
pnpm install
pnpm run build
pnpm run test
```
