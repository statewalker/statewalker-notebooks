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
});
