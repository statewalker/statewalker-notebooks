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
});
