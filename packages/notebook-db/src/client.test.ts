import type { Db, DbEntry } from "@statewalker/db-api";
import { describe, expect, it, vi } from "vitest";
import { newDbClient } from "./client.js";

/** Records exactly what SQL and params reached the driver. */
function fakeDb(rows: DbEntry[] = []): Db & { calls: Array<[string, unknown[] | undefined]> } {
  const calls: Array<[string, unknown[] | undefined]> = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push([sql, params]);
      return rows as never;
    },
    exec: async () => {},
    close: async () => {},
  } as never;
}

describe("newDbClient", () => {
  it("runs a tagged-template query and returns the rows", async () => {
    const db = fakeDb([{ n: 1 }]);
    const client = newDbClient(db);
    expect(await client.sql`SELECT 1 AS n`).toEqual([{ n: 1 }]);
    expect(db.calls[0]![0]).toBe("SELECT 1 AS n");
  });

  // (1) an interpolated metacharacter must be bound, never concatenated
  it("binds interpolated values as parameters instead of splicing them in", async () => {
    const db = fakeDb();
    const client = newDbClient(db);
    const evil = "'; DROP TABLE t; --";
    await client.sql`SELECT * FROM t WHERE name = ${evil}`;
    const [sql, params] = db.calls[0]!;
    expect(sql).toBe("SELECT * FROM t WHERE name = ?");
    expect(params).toEqual([evil]);
    expect(sql).not.toContain("DROP TABLE");
  });

  it("binds several parameters in order", async () => {
    const db = fakeDb();
    await newDbClient(db).sql`SELECT * FROM t WHERE a = ${1} AND b = ${"two"}`;
    expect(db.calls[0]).toEqual(["SELECT * FROM t WHERE a = ? AND b = ?", [1, "two"]]);
  });

  // (2) display code iterates the result; undefined would throw there instead of here
  it("returns an empty array when the query matches nothing", async () => {
    expect(await newDbClient(fakeDb([])).sql`SELECT 1 WHERE false`).toEqual([]);
  });

  it("exposes a plain query method for non-template callers", async () => {
    const db = fakeDb([{ a: 1 }]);
    expect(await newDbClient(db).query("SELECT ?", [5])).toEqual([{ a: 1 }]);
    expect(db.calls[0]).toEqual(["SELECT ?", [5]]);
  });

  it("closes the underlying database", async () => {
    const close = vi.fn(async () => {});
    await newDbClient({ query: async () => [], exec: async () => {}, close } as never).close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("satisfies notebook-kit's duck-typed database source check", () => {
    const client = newDbClient(fakeDb());
    // `of(source, name)` in notebook-kit accepts anything with a `sql` function.
    expect(typeof client.sql).toBe("function");
  });

  // --- D2: BIGINT --------------------------------------------------------------------------
  //
  // DuckDB's `count(*)`, `sum()` over integers and any BIGINT column arrive as JavaScript
  // `bigint` (proven against a real engine in `test-browser/duckdb.browser.test.ts`). A raw
  // `bigint` crashes `JSON.stringify` at build time ("Do not know how to serialize a BigInt")
  // and reaches notebook-kit's renderer unconverted at run time. The choice here is NUMBER,
  // matching notebook-kit's own `revive` (`row[name] = Number(value)`), with the lossy range
  // turned into a loud error instead of a silent rounding.
  it("returns a BIGINT column as a number so a row is JSON-serializable", async () => {
    const rows = await newDbClient(fakeDb([{ c: 3n } as never])).sql`SELECT count(*) AS c`;
    expect(rows).toEqual([{ c: 3 }]);
    expect(typeof (rows[0] as { c: unknown }).c).toBe("number");
    expect(JSON.stringify(rows)).toBe('[{"c":3}]');
  });

  it("converts the largest exactly-representable BIGINT", async () => {
    const rows = await newDbClient(fakeDb([{ c: 9007199254740991n } as never])).sql`SELECT 1`;
    expect(rows).toEqual([{ c: 9007199254740991 }]);
  });

  // The boundary that must NOT silently corrupt. 2^53+1 is the smallest integer a double
  // cannot hold: `Number(9007199254740993n)` is 9007199254740992 — off by one, with nothing
  // in the output to say so.
  it("refuses a BIGINT above Number.MAX_SAFE_INTEGER instead of rounding it", async () => {
    await expect(
      newDbClient(fakeDb([{ id: 9007199254740993n } as never])).sql`SELECT id FROM t`,
    ).rejects.toThrow(/"id".*9007199254740993/s);
  });

  it("refuses a BIGINT below -Number.MAX_SAFE_INTEGER", async () => {
    await expect(
      newDbClient(fakeDb([{ id: -9007199254740993n } as never])).query("SELECT id FROM t"),
    ).rejects.toThrow(/-9007199254740993/);
  });

  // DuckDB LIST/STRUCT columns nest, and a bigint one level down breaks JSON.stringify exactly
  // the same way a top-level one does.
  it("converts a BIGINT nested inside a list or struct column", async () => {
    const rows = await newDbClient(fakeDb([{ ids: [1n, 2n], meta: { total: 3n } } as never]))
      .sql`SELECT 1`;
    expect(rows).toEqual([{ ids: [1, 2], meta: { total: 3 } }]);
    expect(JSON.stringify(rows)).toBe('[{"ids":[1,2],"meta":{"total":3}}]');
  });

  it("leaves a value that is already a number untouched", async () => {
    const rows = await newDbClient(fakeDb([{ n: 1.5, s: "a", b: true, z: null }])).sql`SELECT 1`;
    expect(rows).toEqual([{ n: 1.5, s: "a", b: true, z: null }]);
  });
});
