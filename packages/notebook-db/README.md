# @statewalker/notebook-db

Back a notebook-kit SQL cell with any [`@statewalker/db-api`](https://github.com/statewalker/statewalker-db)
`Db` — DuckDB, SQLite, or whatever else implements the interface.

notebook-kit's `DatabaseClient.of(source, name)` accepts any object exposing a `sql` tagged-template
function as a database source; it never has to know about db-api. This package supplies that
object.

```sh
npm install @statewalker/notebook-db
```

```ts
import { newDbClient } from "@statewalker/notebook-db";
import { newDuckDb } from "@statewalker/db-duckdb-node"; // or any other db-api driver

const db = await newDuckDb();
const client = newDbClient(db);

// Tagged-template form, the shape a notebook SQL cell compiles to:
const rows = await client.sql`SELECT * FROM t WHERE id = ${id}`;

// Plain form, for callers that already have a SQL string:
const rows2 = await client.query("SELECT * FROM t WHERE id = ?", [id]);

await client.close();
```

## Parameter binding

Interpolations in the tagged template become bound parameters — `strings.join("?")` for the SQL
text, the interpolated values as a separate `params` array — passed to `Db.query(sql, params)`.
They are never concatenated into the SQL string. A cell querying user-supplied data would
otherwise be an injection.

## What this package does not do

It does not implement SQL composition, dialect-specific identifier quoting, or view/CTE flattening.
Those are notebook-kit's own `sql` tagged template, `SqlFragment`, `SqlView` and `sql.ident` — import
them from `@observablehq/notebook-kit` if a notebook needs to compose fragments before handing them
to a `client`.

## License

MIT
