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

## BIGINT columns

DuckDB answers `count(*)`, an integer `sum()` and any `BIGINT` column with a JavaScript
`bigint`. `newDbClient` converts those to `number`, in both `sql` and `query`, and so does the
precompute stage before it serializes. That is the same conversion notebook-kit's own
`DatabaseClient.revive` performs (`row[name] = Number(value)`), so a live cell and a
precomputed one show the same value; a string would make `count(*)` render as `"3"` and
`rows[0].c + 1` produce `"31"`.

A double holds every integer below 2^53 exactly and none above it, so a value outside
`Number.MAX_SAFE_INTEGER` is an ERROR naming the column and the exact value, never a silently
rounded result:

```
cannot represent BIGINT column "id" as a JSON number: 9007199254740993 is outside
Number.MAX_SAFE_INTEGER (9007199254740991) and would become 9007199254740992.
Cast it in SQL (for example `CAST("id" AS VARCHAR)`) to keep the exact value.
```

Nested `LIST` and `STRUCT` values are converted too; `Date`, `Uint8Array` and anything else
carrying its own prototype is left untouched.

## The precomputed cache file

`precomputeQueries` writes each query's result at the page-relative path notebook-kit's
`DatabaseClient.sql()` fetches, and writes it as the `{rows, schema}` envelope that client
expects — never a bare array. `sql()` is `fetch(path).then(r => r.json()).then(revive)`, and
`revive` destructures `{rows, schema, ...}` and iterates `schema`, so an array throws
`TypeError: schema is not iterable` on every precomputed cell.

`schema` here is a **revival directive**, not SQL column-type metadata: db-api reports no SQL
types, and this field only says which values need reconstructing after a JSON round trip. It is
derived by inspecting the values being serialized, and it matters for exactly one case —
`revive` branches on `"bigint"` and `"date"` and ignores every other type. A `Date` column must
be marked `"date"` or the precomputed page gets the ISO string where the live page gets a
`Date`.

Every row is scanned, not just the first, so a `Date` column whose first row is `NULL` is still
found. A column that is `NULL` in every row is marked `"other"` (nothing observed, nothing to
revive). A column is marked `"date"` only if *every* non-null value is a `Date`: `revive` marks
a column rather than a value, so marking a mixed column would turn its non-dates into
`Invalid Date`. Mixed columns therefore keep their JSON values verbatim, which means a `Date`
inside one arrives as a string — a limit of the cache format, and not reachable from a typed
SQL column.

`"bigint"` is never emitted: the conversion above already ran, so those columns hold numbers by
the time they are serialized.

## What this package does not do

It does not implement SQL composition, dialect-specific identifier quoting, or view/CTE flattening.
Those are notebook-kit's own `sql` tagged template, `SqlFragment`, `SqlView` and `sql.ident` — import
them from `@observablehq/notebook-kit` if a notebook needs to compose fragments before handing them
to a `client`.

## License

MIT
