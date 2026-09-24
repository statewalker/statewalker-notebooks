import { describe, expect, it, vi } from "vitest";
import { primeModules } from "./prime.js";

describe("primeModules", () => {
  it("primes every ref before returning", async () => {
    const prime = vi.fn(async () => ({ url: "/_m/x", target: "browser" as const }));
    const result = await primeModules({ prime } as never, [{ pkg: "d3" }, { pkg: "katex" }]);
    expect(prime).toHaveBeenCalledTimes(2);
    expect(result.primed).toHaveLength(2);
    expect(result.failed).toEqual([]);
  });

  // (1) priming is the mitigation, so a failure to prime must be visible
  it("reports a ref that could not be primed without aborting the rest", async () => {
    const prime = vi.fn(async (ref: { pkg: string }) => {
      if (ref.pkg === "missing") throw new Error("404 from registry");
      return { url: `/_m/${ref.pkg}`, target: "browser" as const };
    });
    const result = await primeModules({ prime } as never, [
      { pkg: "d3" },
      { pkg: "missing" },
      { pkg: "katex" },
    ]);
    expect(result.primed).toHaveLength(2);
    expect(result.failed).toEqual([{ ref: { pkg: "missing" }, error: "404 from registry" }]);
  });

  it("returns immediately for an empty ref list", async () => {
    const prime = vi.fn();
    const result = await primeModules({ prime } as never, []);
    expect(prime).not.toHaveBeenCalled();
    expect(result).toEqual({ primed: [], failed: [] });
  });

  it("primes serially by default so a cold cache is not hammered concurrently", async () => {
    const order: string[] = [];
    const prime = async (ref: { pkg: string }) => {
      order.push(`start:${ref.pkg}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${ref.pkg}`);
      return { url: "/_m/x", target: "browser" as const };
    };
    await primeModules({ prime } as never, [{ pkg: "a" }, { pkg: "b" }]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });
});
