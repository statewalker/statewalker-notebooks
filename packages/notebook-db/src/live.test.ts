import { describe, expect, it, vi } from "vitest";
import { newLiveDatabases } from "./live.js";

const okDb = () =>
  ({ query: async () => [], exec: async () => {}, close: async () => {} }) as never;

describe("newLiveDatabases", () => {
  it("opens a database on first use and reuses it after", async () => {
    const open = vi.fn(async () => okDb());
    const dbs = newLiveDatabases({ open });
    await dbs.get("warehouse");
    await dbs.get("warehouse");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens distinct databases separately", async () => {
    const open = vi.fn(async () => okDb());
    const dbs = newLiveDatabases({ open });
    await dbs.get("a");
    await dbs.get("b");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does not open twice when two callers race the first use", async () => {
    const open = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return okDb();
    });
    const dbs = newLiveDatabases({ open });
    await Promise.all([dbs.get("x"), dbs.get("x")]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  // (5) OPFS unavailable, or the wasm bundle blocked
  it("rejects with a named error when the database cannot be opened", async () => {
    const dbs = newLiveDatabases({
      open: async () => {
        throw new Error("OPFS unavailable");
      },
    });
    await expect(dbs.get("warehouse")).rejects.toThrow(/warehouse.*OPFS unavailable/);
  });

  it("retries the next time rather than caching the failure forever", async () => {
    let attempt = 0;
    const dbs = newLiveDatabases({
      open: async () => {
        if (++attempt === 1) throw new Error("transient");
        return okDb();
      },
    });
    await expect(dbs.get("x")).rejects.toThrow();
    await expect(dbs.get("x")).resolves.toBeDefined();
  });

  it("closes every open database", async () => {
    const close = vi.fn(async () => {});
    const dbs = newLiveDatabases({
      open: async () => ({ query: async () => [], exec: async () => {}, close }) as never,
    });
    await dbs.get("a");
    await dbs.get("b");
    await dbs.closeAll();
    expect(close).toHaveBeenCalledTimes(2);
  });

  // (D5) `closeAll` empties the map after closing. Without that, the registry still holds every
  // client it just closed: a second `closeAll` — a double teardown, a `beforeEach` that also
  // runs in `afterAll`, a page unload racing an explicit close — calls `close()` on each `Db`
  // AGAIN. Removing `clients.clear()` left the whole suite green before this test existed.
  it("does not close a database twice when closeAll is called twice", async () => {
    const close = vi.fn(async () => {});
    const dbs = newLiveDatabases({
      open: async () => ({ query: async () => [], exec: async () => {}, close }) as never,
    });
    await dbs.get("a");
    await dbs.get("b");
    await dbs.closeAll();
    await dbs.closeAll();
    expect(close).toHaveBeenCalledTimes(2);
  });

  // The other half of the same line: a name asked for again after teardown must be REOPENED.
  // A registry that kept its entries would hand back a client whose `Db` is already closed, and
  // the failure would surface later, in the query, as whatever the driver says about a closed
  // handle.
  it("reopens a database requested again after closeAll", async () => {
    const open = vi.fn(async () => okDb());
    const dbs = newLiveDatabases({ open });
    await dbs.get("a");
    await dbs.closeAll();
    await dbs.get("a");
    expect(open).toHaveBeenCalledTimes(2);
  });
});
