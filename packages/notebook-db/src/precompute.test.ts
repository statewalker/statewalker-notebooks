import { readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newDbClient } from "./client.js";
import { cachePathFor, precomputeQueries } from "./precompute.js";

const fakeDb = (rows: Record<string, unknown>[]) =>
  ({ query: async () => rows, exec: async () => {}, close: async () => {} }) as never;

describe("cachePathFor", () => {
  it("lands under .observable/cache with a json extension", async () => {
    const p = await cachePathFor("warehouse", ["SELECT 1"], []);
    // notebook-kit's `hash`/`nameHash` are base36 (0-9a-z), not hex, and `nameHash` leaves a
    // "simple" database name (matching /^[\w-]+$/, like "warehouse") untouched rather than
    // hashing it — confirmed against the installed notebook-kit in the equivalence suite below.
    expect(p).toMatch(/^\/\.observable\/cache\/[\w.-]+-[0-9a-z]+\.json$/);
  });

  it("is stable for identical query and parameters", async () => {
    expect(await cachePathFor("db", ["SELECT ", ""], [1])).toBe(
      await cachePathFor("db", ["SELECT ", ""], [1]),
    );
  });

  // (3) two queries differing only in a parameter must not share a file
  it("differs when only a parameter differs", async () => {
    expect(await cachePathFor("db", ["SELECT ", ""], [1])).not.toBe(
      await cachePathFor("db", ["SELECT ", ""], [2]),
    );
  });

  it("differs when only the database differs", async () => {
    expect(await cachePathFor("a", ["SELECT 1"], [])).not.toBe(
      await cachePathFor("b", ["SELECT 1"], []),
    );
  });

  it("differs when the split between strings and params differs", async () => {
    // "SELECT 'x'" as a literal vs as a bound parameter must not collide.
    expect(await cachePathFor("db", ["SELECT 'x'"], [])).not.toBe(
      await cachePathFor("db", ["SELECT ", ""], ["x"]),
    );
  });
});

// Proof of equivalence with notebook-kit's own client (see task-2-report.md item 1).
// notebook-kit does not export `hash`/`nameHash` from any public entry point — grep of every
// `exports` target in its package.json turns up none — so this suite reimplements them and
// pins the result against the REAL, installed `DatabaseClientImpl.cachePath`, reached by
// resolving notebook-kit's own package entry and walking a relative URL to the un-exported
// module. If a future notebook-kit release changes the algorithm, this is the test that goes
// red, not a page 404 discovered after publish.
describe("cachePathFor matches notebook-kit's actual DatabaseClient.cachePath", () => {
  async function oracle(name: string, strings: string[], params: unknown[]): Promise<string> {
    const entry = import.meta.resolve("@observablehq/notebook-kit");
    const moduleUrl = new URL("./runtime/stdlib/databaseClient.js", entry).href;
    const { DatabaseClient } = (await import(moduleUrl)) as {
      DatabaseClient: (name: string) => {
        cachePath(strings: string[], ...params: unknown[]): Promise<string>;
      };
    };
    return DatabaseClient(name).cachePath(strings, ...params);
  }

  it("matches for a simple name and a bound parameter", async () => {
    const expected = `/${await oracle("warehouse", ["SELECT ", ""], [1])}`;
    expect(await cachePathFor("warehouse", ["SELECT ", ""], [1])).toBe(expected);
  });

  it("matches for a name that forces the sluggify+hash branch of nameHash", async () => {
    // Anything outside /^[\w-]+$/ takes nameHash's other branch (sluggify + a name hash).
    const name = "a/b weird name!";
    const expected = `/${await oracle(name, ["SELECT 1"], [])}`;
    expect(await cachePathFor(name, ["SELECT 1"], [])).toBe(expected);
  });
});

describe("precomputeQueries", () => {
  it("writes each query's rows as JSON at its cache path", async () => {
    const output = new MemFilesApi();
    const databases = new Map([["warehouse", newDbClient(fakeDb([{ n: 1 }, { n: 2 }]))]]);
    const written = await precomputeQueries(
      [{ database: "warehouse", strings: ["SELECT n FROM t"], params: [] }],
      databases,
      output,
    );
    expect(written).toHaveLength(1);
    expect(JSON.parse(await readText(output, written[0]!))).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("reports a query naming a database that was not configured", async () => {
    await expect(
      precomputeQueries(
        [{ database: "absent", strings: ["SELECT 1"], params: [] }],
        new Map(),
        new MemFilesApi(),
      ),
    ).rejects.toThrow(/absent/);
  });

  it("writes one file per distinct query and reuses the path for a repeat", async () => {
    const output = new MemFilesApi();
    const databases = new Map([["db", newDbClient(fakeDb([]))]]);
    const written = await precomputeQueries(
      [
        { database: "db", strings: ["SELECT 1"], params: [] },
        { database: "db", strings: ["SELECT 1"], params: [] },
      ],
      databases,
      output,
    );
    expect(new Set(written).size).toBe(1);
  });
});
