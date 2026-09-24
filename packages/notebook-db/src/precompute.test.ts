import { readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newDbClient } from "./client.js";
import { cachePathFor, precomputeQueries } from "./precompute.js";

const fakeDb = (rows: Record<string, unknown>[]) =>
  ({ query: async () => rows, exec: async () => {}, close: async () => {} }) as never;

/** Counts how many times the driver was actually asked to run a query. */
const countingDb = (rows: Record<string, unknown>[]) => {
  const state = { queries: 0 };
  const db = {
    query: async () => {
      state.queries++;
      return rows;
    },
    exec: async () => {},
    close: async () => {},
  } as never;
  return { db, state };
};

describe("cachePathFor", () => {
  it("lands under .observable/cache with a json extension", async () => {
    const p = await cachePathFor("/index.html", "warehouse", ["SELECT 1"], []);
    // notebook-kit's `hash`/`nameHash` are base36 (0-9a-z), not hex, and `nameHash` leaves a
    // "simple" database name (matching /^[\w-]+$/, like "warehouse") untouched rather than
    // hashing it — confirmed against the installed notebook-kit in the equivalence suite below.
    expect(p).toMatch(/^\/\.observable\/cache\/[\w.-]+-[0-9a-z]+\.json$/);
  });

  it("is stable for identical query and parameters", async () => {
    expect(await cachePathFor("/index.html", "db", ["SELECT ", ""], [1])).toBe(
      await cachePathFor("/index.html", "db", ["SELECT ", ""], [1]),
    );
  });

  // (3) two queries differing only in a parameter must not share a file
  it("differs when only a parameter differs", async () => {
    expect(await cachePathFor("/index.html", "db", ["SELECT ", ""], [1])).not.toBe(
      await cachePathFor("/index.html", "db", ["SELECT ", ""], [2]),
    );
  });

  it("differs when only the database differs", async () => {
    expect(await cachePathFor("/index.html", "a", ["SELECT 1"], [])).not.toBe(
      await cachePathFor("/index.html", "b", ["SELECT 1"], []),
    );
  });

  // D1: notebook-kit fetches a PAGE-RELATIVE ".observable/cache/..." (no leading slash), so the
  // browser resolves it against the DOCUMENT'S DIRECTORY. A root-anchored path is right only for
  // a notebook that happens to sit at the site root — every fixture above is one, which is why a
  // root-only implementation looked correct. A notebook one directory down 404s on every cell.
  it("anchors the cache file at the notebook's own directory, not the site root", async () => {
    expect(await cachePathFor("/reports/q3.html", "warehouse", ["SELECT 1"], [])).toMatch(
      /^\/reports\/\.observable\/cache\/[\w.-]+-[0-9a-z]+\.json$/,
    );
  });

  it("follows the notebook down every level of nesting", async () => {
    expect(await cachePathFor("/a/b/c/deep.html", "warehouse", ["SELECT 1"], [])).toMatch(
      /^\/a\/b\/c\/\.observable\/cache\//,
    );
  });

  // Two pages, same query: the browser asks each one's OWN directory, so they cannot share a
  // file. A cache path that ignored the notebook would make these equal and one of the two
  // pages would 404.
  it("gives notebooks in different directories different cache paths for the same query", async () => {
    expect(await cachePathFor("/index.html", "db", ["SELECT 1"], [])).not.toBe(
      await cachePathFor("/reports/q3.html", "db", ["SELECT 1"], []),
    );
  });

  // `notebook-site` serves a directory request through `directoryIndex`, so `/reports/` and
  // `/reports/index.html` are the same document and resolve the relative fetch identically.
  // A plain `dirname()` on "/reports/" answers "/" and would put the file one level too high.
  it("treats a directory-index URL as that directory, not its parent", async () => {
    expect(await cachePathFor("/reports/", "db", ["SELECT 1"], [])).toBe(
      await cachePathFor("/reports/index.html", "db", ["SELECT 1"], []),
    );
  });

  it("refuses a notebook path that climbs out of the site root", async () => {
    await expect(cachePathFor("/../escape.html", "db", ["SELECT 1"], [])).rejects.toThrow(
      /escape\.html/,
    );
  });

  it("differs when the split between strings and params differs", async () => {
    // "SELECT 'x'" as a literal vs as a bound parameter must not collide.
    expect(await cachePathFor("/index.html", "db", ["SELECT 'x'"], [])).not.toBe(
      await cachePathFor("/index.html", "db", ["SELECT ", ""], ["x"]),
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
/**
 * The REAL, installed notebook-kit client's `cachePath` — a PAGE-RELATIVE string with no
 * leading slash (`".observable/cache/<nameHash>-<hash>.json"`), which the browser resolves
 * against the document's own directory.
 */
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

describe("cachePathFor matches notebook-kit's actual DatabaseClient.cachePath", () => {
  it("matches for a simple name and a bound parameter", async () => {
    const expected = `/${await oracle("warehouse", ["SELECT ", ""], [1])}`;
    expect(await cachePathFor("/index.html", "warehouse", ["SELECT ", ""], [1])).toBe(expected);
  });

  // The acceptance test for D1: byte-exact against the REAL client, for a page that is NOT at
  // the root. `oracle` returns the relative string the browser is handed; prefixing it with the
  // document's directory is precisely what the browser's URL resolution does.
  it("matches what the browser resolves for a notebook in a subdirectory", async () => {
    const relative = await oracle("warehouse", ["SELECT ", ""], [1]);
    expect(relative.startsWith("/")).toBe(false); // the whole reason D1 exists
    expect(await cachePathFor("/reports/q3.html", "warehouse", ["SELECT ", ""], [1])).toBe(
      `/reports/${relative}`,
    );
  });

  it("matches for a name that forces the sluggify+hash branch of nameHash", async () => {
    // Anything outside /^[\w-]+$/ takes nameHash's other branch (sluggify + a name hash).
    const name = "a/b weird name!";
    const expected = `/${await oracle(name, ["SELECT 1"], [])}`;
    expect(await cachePathFor("/index.html", name, ["SELECT 1"], [])).toBe(expected);
  });
});

describe("precomputeQueries", () => {
  it("writes each query's rows as JSON at its cache path", async () => {
    const output = new MemFilesApi();
    const databases = new Map([["warehouse", newDbClient(fakeDb([{ n: 1 }, { n: 2 }]))]]);
    const written = await precomputeQueries(
      [
        {
          notebook: "/index.html",
          database: "warehouse",
          strings: ["SELECT n FROM t"],
          params: [],
        },
      ],
      databases,
      output,
    );
    expect(written).toHaveLength(1);
    expect(JSON.parse(await readText(output, written[0]!))).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("reports a query naming a database that was not configured", async () => {
    await expect(
      precomputeQueries(
        [{ notebook: "/index.html", database: "absent", strings: ["SELECT 1"], params: [] }],
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
        { notebook: "/index.html", database: "db", strings: ["SELECT 1"], params: [] },
        { notebook: "/index.html", database: "db", strings: ["SELECT 1"], params: [] },
      ],
      databases,
      output,
    );
    expect(new Set(written).size).toBe(1);
  });

  // D1's acceptance test at the pipeline level: the file has to land where the BROWSER will ask
  // for it. Every fixture above sits at "/", where a root-anchored path is accidentally correct.
  it("writes a nested notebook's rows under that notebook's own directory", async () => {
    const output = new MemFilesApi();
    const databases = new Map([["db", newDbClient(fakeDb([{ n: 1 }]))]]);
    const [path] = await precomputeQueries(
      [{ notebook: "/reports/q3.html", database: "db", strings: ["SELECT 1"], params: [] }],
      databases,
      output,
    );
    expect(path).toMatch(/^\/reports\/\.observable\/cache\//);
    expect(await output.exists(path!)).toBe(true);
    // And the browser's own resolution of the relative path notebook-kit fetches.
    const relative = await oracle("db", ["SELECT 1"], []);
    expect(new URL(relative, `http://host/reports/q3.html`).pathname).toBe(path);
  });

  // Two pages at different depths sharing a query get COPIES, not one shared file: notebook-kit
  // fetches page-relative and a static export has no server-side redirect to fold them together.
  // The cost is duplicated bytes; the query itself still runs once.
  it("copies a shared query into each notebook's directory and runs it once", async () => {
    const output = new MemFilesApi();
    const { db, state } = countingDb([{ n: 1 }]);
    const databases = new Map([["db", newDbClient(db)]]);
    const written = await precomputeQueries(
      [
        { notebook: "/index.html", database: "db", strings: ["SELECT 1"], params: [] },
        { notebook: "/reports/q3.html", database: "db", strings: ["SELECT 1"], params: [] },
      ],
      databases,
      output,
    );
    expect(new Set(written).size).toBe(2);
    expect(written[0]).toMatch(/^\/\.observable\//);
    expect(written[1]).toMatch(/^\/reports\/\.observable\//);
    for (const path of written) {
      expect(JSON.parse(await readText(output, path))).toEqual([{ n: 1 }]);
    }
    // The point of collapsing by query rather than by path: one execution, two files.
    expect(state.queries).toBe(1);
  });

  // D2: `JSON.stringify` THROWS on a `bigint` ("Do not know how to serialize a BigInt"), with a
  // message naming neither the cell nor the query. DuckDB's `count(*)` is BIGINT, so this took
  // the whole build down on the most ordinary SQL cell there is.
  it("serializes a BIGINT column from a hand-rolled client rather than crashing", async () => {
    const output = new MemFilesApi();
    // NOT `newDbClient`: `precomputeQueries` accepts any `NotebookDbClient`, so the
    // serialization step has to be safe on its own and not lean on the adapter's conversion.
    const raw = {
      sql: async () => [{ c: 3n }] as never,
      query: async () => [{ c: 3n }] as never,
      close: async () => {},
    };
    const [path] = await precomputeQueries(
      [{ notebook: "/index.html", database: "db", strings: ["SELECT count(*) AS c"], params: [] }],
      new Map([["db", raw]]),
      output,
    );
    expect(JSON.parse(await readText(output, path!))).toEqual([{ c: 3 }]);
  });

  it("refuses a BIGINT the JSON file could not hold exactly", async () => {
    const raw = {
      sql: async () => [{ id: 9007199254740993n }] as never,
      query: async () => [] as never,
      close: async () => {},
    };
    await expect(
      precomputeQueries(
        [{ notebook: "/index.html", database: "db", strings: ["SELECT id"], params: [] }],
        new Map([["db", raw]]),
        new MemFilesApi(),
      ),
    ).rejects.toThrow(/"id".*9007199254740993/s);
  });
});
